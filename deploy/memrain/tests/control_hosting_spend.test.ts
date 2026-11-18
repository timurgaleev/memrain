/**
 * The hosting spend cap at the paid-call chokepoint. In hosting mode every
 * trackedInvoke reserves its worst case with the control plane after the
 * brain's own holds, and settles it afterwards: at the actual, at 0 when the
 * call failed before billing, not at all when it may have billed unreported
 * (the control plane turns that reservation into spend at its TTL). Any
 * refusal or control failure sends nothing and releases the local holds.
 * Outside hosting mode nothing of this runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { costUsd, isDailyCapRefusal, setSpendLedgerEngine, trackedInvoke, worstCaseUsd, type TrackedCall } from "../src/core/budget.ts";
import { HOSTING_ENV, setTenantPolicySource, type TenantPolicy } from "../src/control/contract.ts";
import { setHostingSpendBackend, type HostingSpendBackend } from "../src/control/hosting-spend.ts";

const MODEL = "eu.anthropic.claude-haiku-5-5";
const CALL: TrackedCall = { operation: "probe", model: MODEL, worstCase: { input: "hello world", maxOutputTokens: 200 } };
const USAGE = { inputTokens: 40, outputTokens: 30 };
const active: TenantPolicy = { status: "active", mode: null, limits: {}, llmOff: false, isolation: "verified" };

interface FakeBackend extends HostingSpendBackend {
  reserves: number[];
  settles: [string, number][];
}

function fake(reply: (usd: number) => Awaited<ReturnType<HostingSpendBackend["reserve"]>> = () => ({ ok: true, id: "r1" })): FakeBackend {
  const b: FakeBackend = {
    reserves: [],
    settles: [],
    async reserve(usd) {
      b.reserves.push(usd);
      return reply(usd);
    },
    async settle(id, usd) {
      b.settles.push([id, usd]);
      return { ok: true, overrun: false };
    },
  };
  return b;
}

const ENV_KEYS = [...Object.values(HOSTING_ENV), "MEMRAIN_DAILY_BUDGET_USD"];
let saved: Map<string, string | undefined>;
let tmp: string;
let storage: Storage;

beforeEach(async () => {
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "memrain-hosting-spend-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  setSpendLedgerEngine(storage.engine());
});

afterEach(async () => {
  setSpendLedgerEngine(null);
  setTenantPolicySource(null);
  setHostingSpendBackend(null);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function hosted(policy: TenantPolicy | null = active): void {
  process.env["MEMRAIN_TENANT_ID"] = "acme";
  process.env["MEMRAIN_CONTROL_URL"] = "control-url-from-secret-file";
  setTenantPolicySource(policy === null ? null : async () => policy);
}

async function pendingHolds(): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_spend_reservations WHERE status = 'pending'`);
  return r.rows[0]!.n;
}

const ok = async (meter: { report(u: typeof USAGE): void }) => {
  meter.report(USAGE);
  return "done";
};

describe("hosting spend cap", () => {
  it("outside hosting mode it reads no policy and reserves nothing", async () => {
    const b = fake();
    setHostingSpendBackend(b);
    let reads = 0;
    setTenantPolicySource(async () => { reads++; return active; });
    expect(await trackedInvoke(CALL, ok)).toBe("done");
    expect(b.reserves).toEqual([]);
    expect(reads).toBe(0);
  });

  it("reserves the worst case before the call and settles the actual after it", async () => {
    hosted();
    const b = fake();
    setHostingSpendBackend(b);
    expect(await trackedInvoke(CALL, ok)).toBe("done");
    expect(b.reserves).toEqual([worstCaseUsd(CALL)!]);
    expect(b.settles).toEqual([["r1", costUsd(MODEL, USAGE)]]);
  });

  it("releases at 0 a call that failed before billing, and leaves one that may have billed", async () => {
    hosted();
    const b = fake();
    setHostingSpendBackend(b);
    await expect(trackedInvoke(CALL, async () => { throw new Error("ValidationException: bad input"); })).rejects.toThrow();
    expect(b.settles).toEqual([["r1", 0]]);
    await expect(trackedInvoke(CALL, async () => {
      const e = new Error("request timed out");
      e.name = "TimeoutError";
      throw e;
    })).rejects.toThrow();
    expect(b.settles).toHaveLength(1);
  });

  it("a refusal sends nothing and releases the brain's own hold", async () => {
    process.env["MEMRAIN_DAILY_BUDGET_USD"] = "5";
    hosted();
    setHostingSpendBackend(fake(() => ({ ok: false, reason: "hosting_cap" })));
    let sent = 0;
    const err = await trackedInvoke(CALL, async (m) => { sent++; return ok(m); }).catch((e: unknown) => e);
    expect(isDailyCapRefusal(err)).toBe(true);
    expect((err as { scope: string }).scope).toBe("hosting");
    expect(sent).toBe(0);
    expect(await pendingHolds()).toBe(0);
  });

  it("an unreachable control plane sends nothing", async () => {
    process.env["MEMRAIN_DAILY_BUDGET_USD"] = "5";
    hosted();
    setHostingSpendBackend({
      reserve: async () => { throw new Error("connect ECONNREFUSED"); },
      settle: async () => ({ ok: true }),
    });
    let sent = 0;
    await expect(trackedInvoke(CALL, async (m) => { sent++; return ok(m); })).rejects.toMatchObject({ code: "storage_error" });
    expect(sent).toBe(0);
    expect(await pendingHolds()).toBe(0);
  });

  it("refuses without asking control when paid calls are off, the policy is unknown, or the call has no price", async () => {
    const b = fake();
    setHostingSpendBackend(b);
    hosted({ ...active, llmOff: true });
    await expect(trackedInvoke(CALL, ok)).rejects.toMatchObject({ code: "budget_exhausted" });
    hosted(null);
    await expect(trackedInvoke(CALL, ok)).rejects.toMatchObject({ code: "storage_error" });
    hosted();
    await expect(trackedInvoke({ ...CALL, model: "vendor.unpriced-model-v1" }, ok)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(b.reserves).toEqual([]);
  });
});
