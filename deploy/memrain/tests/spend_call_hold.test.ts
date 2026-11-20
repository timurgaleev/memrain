/**
 * The per-call hold at the spend chokepoint.
 *
 * Locks: concurrent paid calls from one capped client never book more than the
 * cap, because each holds its worst case before sending; a completed call is
 * counted once (its hold settles in the same commit as its row); the worst case
 * prices a prompt-cache prefix at the cache-write rate; and the search
 * fallbacks hand a budget refusal to the caller instead of degrading quietly.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { Storage } from "../src/core/storage.ts";
import {
  costUsd,
  daySpendUsd,
  runWithSpendClient,
  setSpendLedgerEngine,
  trackedInvoke,
  worstCaseUsd,
} from "../src/core/budget.ts";
import { expandQuery } from "../src/core/search/expansion.ts";
import { bedrockClientConfig, withDeadline } from "../src/core/llm/gateway.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-call-hold-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  setSpendLedgerEngine(storage.engine());
});
afterEach(async () => {
  setSpendLedgerEngine(null);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A call whose worst case is $0.02 at Haiku's $5/1M output rate. */
const TWO_CENTS = { input: "", maxOutputTokens: 4_000 - 13 };

describe("concurrent calls near the cap", () => {
  it("book no more than the cap", async () => {
    const worst = worstCaseUsd({ operation: "think", model: HAIKU, worstCase: TWO_CENTS })!;
    expect(worst).toBeCloseTo(0.02, 3);
    const ctx = { clientId: "racer", capUsd: 0.1 };
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        runWithSpendClient(ctx, () =>
          trackedInvoke({ operation: "think", model: HAIKU, worstCase: TWO_CENTS }, async (m) => {
            // Let every caller get past its check before anyone books.
            await new Promise((r) => setTimeout(r, 5));
            m.report({ inputTokens: 0, outputTokens: 4_000 - 13 });
          }),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThan(20);
    for (const r of results) {
      if (r.status === "rejected") expect((r.reason as { code?: string }).code).toBe("budget_exhausted");
    }
    const booked = await storage.engine().query<{ usd: number }>(
      `SELECT COALESCE(SUM(spend_cents), 0)::float8 / 100 AS usd FROM mcp_spend_log WHERE client_id = 'racer'`,
    );
    expect(booked.rows[0]!.usd).toBeLessThanOrEqual(0.1 + 1e-9);
  });
});

describe("a completed call", () => {
  it("is counted once: its hold settles with its row", async () => {
    await runWithSpendClient({ clientId: "once", capUsd: 5 }, () =>
      trackedInvoke({ operation: "think", model: HAIKU, worstCase: TWO_CENTS }, async (m) => {
        m.report({ inputTokens: 1_000, outputTokens: 100 });
      }),
    );
    const actual = costUsd(HAIKU, { inputTokens: 1_000, outputTokens: 100 });
    expect(await daySpendUsd(storage.engine(), "once")).toBeCloseTo(actual, 9);
    const holds = await storage.engine().query<{ status: string }>(
      `SELECT status FROM mcp_spend_reservations WHERE client_id = 'once'`,
    );
    expect(holds.rows).toEqual([{ status: "settled" }]);
  });

  it("keeps the worst case held when the call timed out without reporting", async () => {
    const ctx = { clientId: "cut-off", capUsd: 5 };
    await expect(
      runWithSpendClient(ctx, () =>
        trackedInvoke({ operation: "think", model: HAIKU, worstCase: TWO_CENTS, maxAttempts: 1 }, async () => {
          const e = new Error("request timed out");
          e.name = "TimeoutError";
          throw e;
        }),
      ),
    ).rejects.toThrow("timed out");
    expect(await daySpendUsd(storage.engine(), "cut-off")).toBeCloseTo(0.02, 3);
  });

  it("keeps it when a search deadline cut the call off", async () => {
    const ctx = { clientId: "deadline", capUsd: 5 };
    await expect(
      runWithSpendClient(ctx, () =>
        trackedInvoke({ operation: "query-expansion", model: HAIKU, worstCase: TWO_CENTS, maxAttempts: 1 }, () =>
          withDeadline(10, () => new Promise(() => {})),
        ),
      ),
    ).rejects.toThrow("deadline");
    expect(await daySpendUsd(storage.engine(), "deadline")).toBeCloseTo(0.02, 3);
  });

  it("releases the hold when the service refused the call", async () => {
    const ctx = { clientId: "throttled", capUsd: 5 };
    await expect(
      runWithSpendClient(ctx, () =>
        trackedInvoke({ operation: "think", model: HAIKU, worstCase: TWO_CENTS }, async () => {
          const e = new Error("Rate exceeded");
          e.name = "ThrottlingException";
          throw e;
        }),
      ),
    ).rejects.toThrow("Rate exceeded");
    expect(await daySpendUsd(storage.engine(), "throttled")).toBe(0);
  });

  it("holds nothing for an uncapped client", async () => {
    await runWithSpendClient({ clientId: "free", capUsd: null }, () =>
      trackedInvoke({ operation: "think", model: HAIKU, worstCase: TWO_CENTS }, async () => {}),
    );
    const holds = await storage.engine().query(`SELECT 1 FROM mcp_spend_reservations`);
    expect(holds.rows).toHaveLength(0);
  });
});

const failure = (name: string, message: string): Error => {
  const e = new Error(message);
  e.name = name;
  return e;
};

async function attemptRows(clientId: string): Promise<Array<{ outcome: string; usd: number }>> {
  const r = await storage.engine().query<{ outcome: string; usd: number }>(
    `SELECT outcome, spend_cents::float8 / 100 AS usd FROM mcp_spend_log WHERE client_id = $1 ORDER BY id`,
    [clientId],
  );
  return r.rows;
}

describe("retries inside the wallet", () => {
  it("leaves retrying to the wallet: every Bedrock client sends one attempt", () => {
    expect(bedrockClientConfig(1_000).maxAttempts).toBe(1);
  });

  it("books a timed-out attempt at its worst case, and the retry that succeeds at its actual", async () => {
    let sends = 0;
    const value = await runWithSpendClient({ clientId: "retry-ok", capUsd: 5 }, () =>
      trackedInvoke({ operation: "think", model: HAIKU, worstCase: TWO_CENTS }, async (m) => {
        sends++;
        if (sends === 1) throw failure("TimeoutError", "request timed out");
        m.report({ inputTokens: 1_000, outputTokens: 100 });
        return "answer";
      }),
    );
    expect(value).toBe("answer");
    expect(sends).toBe(2);
    const actual = costUsd(HAIKU, { inputTokens: 1_000, outputTokens: 100 });
    expect(await daySpendUsd(storage.engine(), "retry-ok")).toBeCloseTo(0.02 + actual, 4);
    expect((await attemptRows("retry-ok")).map((r) => r.outcome)).toEqual(["error", "ok"]);
    const holds = await storage.engine().query<{ status: string }>(
      `SELECT status FROM mcp_spend_reservations WHERE client_id = 'retry-ok' ORDER BY created_at`,
    );
    expect(holds.rows.map((h) => h.status).sort()).toEqual(["pending", "settled"]);
  });

  it("keeps a timed-out attempt's worst case when the next attempt is refused by the service", async () => {
    let sends = 0;
    await expect(
      runWithSpendClient({ clientId: "retry-refused", capUsd: 5 }, () =>
        trackedInvoke({ operation: "think", model: HAIKU, worstCase: TWO_CENTS }, async () => {
          sends++;
          if (sends === 1) throw failure("TimeoutError", "request timed out");
          throw failure("ValidationException", "malformed input");
        }),
      ),
    ).rejects.toThrow("malformed input");
    expect(sends).toBe(2);
    expect(await daySpendUsd(storage.engine(), "retry-refused")).toBeCloseTo(0.02, 4);
  });

  it("books nothing for throttled attempts and the actual of the one that got through", async () => {
    let sends = 0;
    await runWithSpendClient({ clientId: "retry-throttle", capUsd: 5 }, () =>
      trackedInvoke({ operation: "think", model: HAIKU, worstCase: TWO_CENTS }, async (m) => {
        sends++;
        if (sends < 3) throw failure("ThrottlingException", "Rate exceeded");
        m.report({ inputTokens: 10, outputTokens: 10 });
      }),
    );
    expect(sends).toBe(3);
    expect(await daySpendUsd(storage.engine(), "retry-throttle")).toBeCloseTo(costUsd(HAIKU, { inputTokens: 10, outputTokens: 10 }), 9);
    expect((await attemptRows("retry-throttle")).map((r) => r.outcome)).toEqual(["error", "error", "ok"]);
  });

  it("stops after four attempts, each held and booked on its own", async () => {
    let sends = 0;
    await expect(
      runWithSpendClient({ clientId: "retry-spent", capUsd: 5 }, () =>
        trackedInvoke({ operation: "think", model: HAIKU, worstCase: TWO_CENTS }, async () => {
          sends++;
          throw failure("TimeoutError", "request timed out");
        }),
      ),
    ).rejects.toThrow("timed out");
    expect(sends).toBe(4);
    expect(await daySpendUsd(storage.engine(), "retry-spent")).toBeCloseTo(0.08, 4);
  });

  it("does not send a retry the cap cannot hold", async () => {
    let sends = 0;
    await expect(
      runWithSpendClient({ clientId: "retry-capped", capUsd: 0.03 }, () =>
        trackedInvoke({ operation: "think", model: HAIKU, worstCase: TWO_CENTS }, async () => {
          sends++;
          throw failure("TimeoutError", "request timed out");
        }),
      ),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(sends).toBe(1);
    expect(await daySpendUsd(storage.engine(), "retry-capped")).toBeCloseTo(0.02, 4);
  });

  it("does not retry once the caller's signal is aborted", async () => {
    let sends = 0;
    const controller = new AbortController();
    await expect(
      runWithSpendClient({ clientId: "retry-aborted", capUsd: 5 }, () =>
        trackedInvoke({ operation: "think", model: HAIKU, worstCase: TWO_CENTS, signal: controller.signal }, async () => {
          sends++;
          controller.abort();
          throw failure("TimeoutError", "request timed out");
        }),
      ),
    ).rejects.toThrow("timed out");
    expect(sends).toBe(1);
  });

  it("does not retry a call that reported usage before it failed", async () => {
    let sends = 0;
    await expect(
      runWithSpendClient({ clientId: "retry-billed", capUsd: 5 }, () =>
        trackedInvoke({ operation: "think", model: HAIKU, worstCase: TWO_CENTS }, async (m) => {
          sends++;
          m.report({ inputTokens: 10, outputTokens: 10 });
          throw failure("TimeoutError", "read timed out after the response arrived");
        }),
      ),
    ).rejects.toThrow("timed out");
    expect(sends).toBe(1);
  });
});

describe("the worst case", () => {
  it("prices a cache prefix at the cache-write rate", () => {
    const plain = worstCaseUsd({ operation: "t", model: HAIKU, worstCase: { input: "a".repeat(1000), maxOutputTokens: 0 } })!;
    const cached = worstCaseUsd({
      operation: "t",
      model: HAIKU,
      worstCase: { input: "", cachedInput: "a".repeat(1000), maxOutputTokens: 0 },
    })!;
    expect(cached).toBeGreaterThan(plain);
  });

  it("bounds multibyte text by its bytes, not its characters", () => {
    const w = worstCaseUsd({ operation: "t", model: HAIKU, worstCase: { input: "語".repeat(1000), maxOutputTokens: 0 } })!;
    // 3000 UTF-8 bytes (+64 framing) at $1/1M.
    expect(w).toBeCloseTo(3064 / 1_000_000, 9);
  });
});

describe("the search fallbacks", () => {
  it("query expansion hands a budget refusal to the caller", async () => {
    const send = mock(async () => ({ output: { message: { content: [{ text: "a\nb" }] } } }));
    const client = { send } as unknown as BedrockRuntimeClient;
    await expect(
      runWithSpendClient({ clientId: "broke", capUsd: 0 }, () => expandQuery("where is the deploy script", { client })),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(send).not.toHaveBeenCalled();
  });
});
