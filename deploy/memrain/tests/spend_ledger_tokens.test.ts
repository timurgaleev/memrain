/**
 * What the spend ledger records per call, and a PAT's daily cap.
 *
 * Locks: raw token counts land on the row (cache tokens included) while the
 * cost stays the cache-adjusted price; a call that reported nothing has NULL
 * tokens; a cap resolved at authentication costs the paid path no lookup; a
 * capped caller is refused an unpriced model before anything is sent; and a
 * PAT's `budget_usd_per_day` reaches the chokepoint through the token.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  currentSpendContext,
  daySpendUsd,
  runWithSpendClient,
  setSpendLedgerEngine,
  trackedInvoke,
} from "../src/core/budget.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

/** A tiny worst case: holds a fraction of a cent against a capped client. */
const SMALL = { input: "x", maxOutputTokens: 0 };

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const UNPRICED = "example.unpriced-model-v1:0";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-spend-tokens-"));
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
  spend_cents: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

async function rows(): Promise<Row[]> {
  const r = await storage.engine().query<Row>(
    `SELECT spend_cents::float8 AS spend_cents, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens
       FROM mcp_spend_log ORDER BY id`,
  );
  return r.rows;
}

/** An engine that counts the statements the paid path sends. */
function counting(engine: Engine): { engine: Engine; sql: string[] } {
  const sql: string[] = [];
  const wrapped = new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (text: string, params?: unknown[]) => {
          sql.push(text);
          return target.query(text, params);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { engine: wrapped, sql };
}

describe("the ledger row", () => {
  it("keeps the raw token counts and prices the cache-adjusted usage", async () => {
    await trackedInvoke({ operation: "think", model: HAIKU, worstCase: SMALL }, async (m) => {
      m.report({
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadInputTokens: 1_000_000,
        cacheWriteInputTokens: 0,
      });
    });
    const [row] = await rows();
    expect(row).toMatchObject({
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_tokens: 1_000_000,
      cache_write_tokens: 0,
    });
    // (1M + 0.1 × 1M cache read) @ $1/1M + 100k @ $5/1M = $1.60.
    expect(row!.spend_cents).toBeCloseTo(160, 6);
  });

  it("leaves the tokens NULL when the call reported nothing", async () => {
    await expect(
      trackedInvoke({ operation: "think", model: HAIKU, worstCase: SMALL }, async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    expect(await rows()).toEqual([
      { spend_cents: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null },
    ]);
  });

  it("does not let an unknown cost leak into the day's total", async () => {
    await runWithSpendClient({ clientId: "c", capUsd: null }, async () => {
      await trackedInvoke({ operation: "think", model: UNPRICED, worstCase: SMALL }, async (m) => {
        m.report({ inputTokens: 10, outputTokens: 10 });
      });
      await trackedInvoke({ operation: "think", model: HAIKU, worstCase: SMALL }, async (m) => {
        m.report({ inputTokens: 1_000_000, outputTokens: 0 });
      });
    });
    expect(await daySpendUsd(storage.engine(), "c")).toBeCloseTo(1, 6);
  });
});

describe("a cap known from authentication", () => {
  it("costs an uncapped caller no lookup on the paid path", async () => {
    const c = counting(storage.engine());
    setSpendLedgerEngine(c.engine);
    await runWithSpendClient({ clientId: "someone", capUsd: null }, () =>
      trackedInvoke({ operation: "embedding", model: HAIKU, worstCase: SMALL }, async (m) => {
        m.report({ inputTokens: 10, outputTokens: 0 });
      }),
    );
    expect(c.sql).toHaveLength(1);
    expect(c.sql[0]).toContain("INSERT INTO mcp_spend_log");
  });

  it("still looks the cap up when authentication did not resolve it", async () => {
    const c = counting(storage.engine());
    setSpendLedgerEngine(c.engine);
    await runWithSpendClient("someone", () =>
      trackedInvoke({ operation: "embedding", model: HAIKU, worstCase: SMALL }, async (m) => {
        m.report({ inputTokens: 10, outputTokens: 0 });
      }),
    );
    expect(c.sql.some((q) => q.includes("FROM oauth_clients"))).toBe(true);
  });

  it("refuses a capped caller an unpriced model before sending anything", async () => {
    let sent = false;
    await expect(
      runWithSpendClient({ clientId: "capped", capUsd: 5 }, () =>
        trackedInvoke({ operation: "think", model: UNPRICED, worstCase: SMALL }, async () => {
          sent = true;
        }),
      ),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(sent).toBe(false);
  });

  it("refuses a capped caller once the cap is spent", async () => {
    const ctx = { clientId: "capped", capUsd: 0.01 };
    await runWithSpendClient(ctx, () =>
      trackedInvoke({ operation: "think", model: HAIKU, worstCase: SMALL }, async (m) => {
        m.report({ inputTokens: 1_000_000, outputTokens: 0 });
      }),
    );
    await expect(
      runWithSpendClient(ctx, () =>
        trackedInvoke({ operation: "think", model: HAIKU, worstCase: SMALL }, async (m) => {
          m.report({ inputTokens: 1, outputTokens: 0 });
        }),
      ),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
  });
});

describe("a personal access token's cap", () => {
  async function mintPat(name: string, token: string): Promise<void> {
    await storage.engine().query(
      `INSERT INTO access_tokens (name, token_hash, scopes) VALUES ($1, $2, $3)`,
      [name, createHash("sha256").update(token, "utf8").digest("hex"), ["read", "write"]],
    );
  }

  it("is set by name and read with the token", async () => {
    const provider = new OAuthProvider({ engine: storage.raw() });
    await mintPat("laptop", "memex_pat_secret");
    expect((await provider.verifyAccessToken("memex_pat_secret")).budgetUsdPerDay).toBeNull();

    expect(await provider.setClientBudget("laptop", 2.5)).toBe(true);
    const info = await provider.verifyAccessToken("memex_pat_secret");
    expect(info.clientId).toBe("laptop");
    expect(info.budgetUsdPerDay).toBe(2.5);
  });

  it("caps the PAT's paid calls once its day is spent", async () => {
    const provider = new OAuthProvider({ engine: storage.raw() });
    await mintPat("laptop", "memex_pat_secret");
    await provider.setClientBudget("laptop", 0.01);
    const info = await provider.verifyAccessToken("memex_pat_secret");
    const ctx = { clientId: info.clientId, capUsd: info.budgetUsdPerDay };
    await runWithSpendClient(ctx, () =>
      trackedInvoke({ operation: "think", model: HAIKU, worstCase: SMALL }, async (m) => {
        m.report({ inputTokens: 1_000_000, outputTokens: 0 });
      }),
    );
    await expect(
      runWithSpendClient(ctx, () => trackedInvoke({ operation: "think", model: HAIKU, worstCase: SMALL }, async () => {})),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
  });

  it("is not settable on a revoked token", async () => {
    const provider = new OAuthProvider({ engine: storage.raw() });
    await mintPat("old", "memex_pat_old");
    await storage.engine().query(`UPDATE access_tokens SET revoked_at = now() WHERE name = 'old'`);
    expect(await provider.setClientBudget("old", 1)).toBe(false);
  });
});

