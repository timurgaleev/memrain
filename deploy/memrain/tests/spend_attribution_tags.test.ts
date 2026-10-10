/**
 * Every paid call books the cycle phase and job it ran under, how it ended and
 * how long it took — and a refused call leaves a $0 `refused` row behind.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  BRAIN_SPEND_ID,
  currentSpendTags,
  patNameSpendConflict,
  runWithSpendClient,
  runWithSpendTags,
  setSpendLedgerEngine,
  trackedInvoke,
} from "../src/core/budget.ts";
import { BedrockHalted } from "../src/core/llm/bedrock-errors.ts";
import { revertMigration, runMigrations } from "../src/core/migrate.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const CALL = { operation: "think", model: HAIKU, worstCase: { input: "", maxOutputTokens: 100 } };

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-spend-tags-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  setSpendLedgerEngine(storage.engine());
});
afterEach(async () => {
  setSpendLedgerEngine(null);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface Row {
  client_id: string | null;
  phase: string | null;
  job_id: string | null;
  outcome: string | null;
  latency_ms: number | null;
  usd: number;
}

async function rows(): Promise<Row[]> {
  const r = await storage.engine().query<Row>(
    `SELECT client_id, phase, job_id, outcome, latency_ms, spend_cents::float8 / 100 AS usd
       FROM mcp_spend_log ORDER BY id`,
  );
  return r.rows;
}

describe("spend tags", () => {
  it("merge over the enclosing ones and vanish outside", async () => {
    expect(currentSpendTags()).toEqual({});
    await runWithSpendTags({ phase: "concepts", jobId: "j1" }, async () => {
      await runWithSpendTags({ phase: "patterns" }, async () => {
        expect(currentSpendTags()).toEqual({ phase: "patterns", jobId: "j1" });
      });
      await runWithSpendTags({ jobId: "" }, async () => {
        expect(currentSpendTags()).toEqual({ phase: "concepts", jobId: "j1" });
      });
    });
    expect(currentSpendTags()).toEqual({});
  });

  it("are booked with the call, its outcome and latency", async () => {
    await runWithSpendTags({ phase: "concepts", jobId: "job-7" }, () =>
      trackedInvoke(CALL, async (m) => {
        await new Promise((r) => setTimeout(r, 15));
        m.report({ inputTokens: 10, outputTokens: 10 });
      }),
    );
    const [row] = await rows();
    expect(row).toMatchObject({ client_id: null, phase: "concepts", job_id: "job-7", outcome: "ok" });
    expect(row!.latency_ms).toBeGreaterThanOrEqual(10);
  });

  it("book NULL outside any phase or job", async () => {
    await trackedInvoke(CALL, async () => {});
    expect(await rows()).toMatchObject([{ phase: null, job_id: null, outcome: "ok" }]);
  });
});

describe("the outcome", () => {
  it("is error when the provider call threw", async () => {
    await expect(
      trackedInvoke(CALL, async () => {
        throw new Error("ValidationException");
      }),
    ).rejects.toThrow("ValidationException");
    expect(await rows()).toMatchObject([{ outcome: "error" }]);
  });

  it("is halted when the batch run stopped the call", async () => {
    await expect(
      trackedInvoke(CALL, async () => {
        throw new BedrockHalted("other", Date.now(), "stopped");
      }),
    ).rejects.toThrow("stopped");
    expect(await rows()).toMatchObject([{ outcome: "halted" }]);
  });

  it("is refused, at $0 and attributed, when a client cap refused the call", async () => {
    await expect(
      runWithSpendClient({ clientId: "broke", capUsd: 0 }, () =>
        runWithSpendTags({ jobId: "job-9" }, () => trackedInvoke(CALL, async () => {})),
      ),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(await rows()).toEqual([
      { client_id: "broke", phase: null, job_id: "job-9", outcome: "refused", latency_ms: null, usd: 0 },
    ]);
  });
});

describe("migration 126", () => {
  it("reverts keeping every ledger row, and re-applies", async () => {
    const e = storage.engine();
    await runWithSpendTags({ phase: "concepts" }, () => trackedInvoke(CALL, async () => {}));
    const later = await e.query<{ id: number }>(`SELECT id FROM migrations WHERE id > 126 ORDER BY id DESC`);
    for (const { id } of later.rows) await revertMigration(e, Number(id));
    await revertMigration(e, 126);
    const cols = await e.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'mcp_spend_log' AND column_name IN ('phase', 'job_id', 'outcome', 'latency_ms')`,
    );
    expect(cols.rows).toEqual([]);
    const n = await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_spend_log`);
    expect(n.rows[0]!.n).toBe(1);
    expect((await runMigrations(e)).applied.map((m) => m.id)).toContain(126);
    await expect(
      e.query(`INSERT INTO mcp_spend_log (operation, outcome) VALUES ('x', 'weird')`),
    ).rejects.toThrow();
  });
});

describe("the brain's ledger key", () => {
  it("cannot be taken by a token name", () => {
    expect(patNameSpendConflict(BRAIN_SPEND_ID)).not.toBeNull();
    expect(patNameSpendConflict(`${BRAIN_SPEND_ID}-laptop`)).toBeNull();
  });
});
