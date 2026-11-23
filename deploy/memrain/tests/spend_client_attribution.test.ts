/**
 * Per-client spend attribution — the half that made `budget_usd_per_day` real.
 *
 * `bookSpend` wrote every mcp_spend_log row with client_id NULL while
 * `daySpendUsd` sums `WHERE client_id = $1`, so a client's daily cap only ever
 * saw the three ops whose handler echoes `spentUsd` back to `withClientSpend`.
 * Everything else — search embeddings, intent classification, query expansion,
 * rerank, skillify — was attributable and counted against nobody.
 *
 * The client now rides an AsyncLocalStorage context opened once per dispatch,
 * so a paid helper is attributed without having to be handed an id.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { OperationError } from "../src/core/operation-error.ts";
import {
  checkClientBudget,
  currentSpendClient,
  daySpendUsd,
  runWithSpendClient,
  setSpendLedgerEngine,
  trackedInvoke,
} from "../src/core/budget.ts";

/** A tiny worst case: holds a fraction of a cent against a capped client. */
const SMALL = { input: "x", maxOutputTokens: 0 };

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

let tmp: string;
let storage: Storage;

/** One paid call that reports `inputTokens` and returns. */
async function paidCall(inputTokens: number): Promise<void> {
  await trackedInvoke({ operation: "search.expand", model: HAIKU, worstCase: SMALL }, async (meter) => {
    meter.report({ inputTokens, outputTokens: 0 });
  });
}

async function rows(): Promise<{ client_id: string | null; spend_cents: number }[]> {
  const r = await storage.engine().query<{ client_id: string | null; spend_cents: number }>(
    `SELECT client_id, spend_cents::float8 AS spend_cents FROM mcp_spend_log ORDER BY id`,
  );
  return r.rows;
}

/**
 * Explicit per-test reset. Deliberately NOT a `beforeEach`: a hook that
 * occasionally overran its budget showed up as an unnamed failing test, which
 * says nothing about the code under test. Called first by every test instead.
 */
async function reset(): Promise<void> {
  const e = storage.engine();
  await e.query("TRUNCATE mcp_spend_log, mcp_spend_reservations");
  await e.query(
    `UPDATE oauth_clients
        SET budget_usd_per_day = CASE client_id WHEN 'capped' THEN 0.01 ELSE NULL END`,
  );
}

// ONE PGLite instance for the file: every instance reserves WASM linear memory
// that is never returned, so a per-test database exhausts the heap and the
// hooks start timing out. State is reset between tests instead.
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-spend-client-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await storage.engine().query(
    `INSERT INTO oauth_clients (client_id, client_name, budget_usd_per_day)
     VALUES ('capped', 'Capped', 0.01), ('uncapped', 'Uncapped', NULL)`,
  );
  setSpendLedgerEngine(storage.engine());
}, 30_000);


afterAll(async () => {
  setSpendLedgerEngine(null);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  // Closing PGLite after a file's worth of work can exceed the default 5s hook
  // budget; without this the teardown surfaces as an unnamed failing test.
}, 30_000);

describe("spend client context", () => {
  it("books a paid call against the client in scope", async () => {
    await reset();
    await runWithSpendClient("capped", () => paidCall(1_000_000));
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.client_id).toBe("capped");
    expect(all[0]!.spend_cents).toBeGreaterThan(0);
  });

  it("books NULL outside any context, exactly as before", async () => {
    await reset();
    await paidCall(1_000_000);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.client_id).toBeNull();
  });

  it("survives awaits inside the tracked call", async () => {
    await reset();
    await runWithSpendClient("capped", async () => {
      await trackedInvoke({ operation: "search.expand", model: HAIKU, worstCase: SMALL }, async (meter) => {
        await new Promise((r) => setTimeout(r, 5));
        expect(currentSpendClient()).toBe("capped");
        meter.report({ inputTokens: 1_000_000, outputTokens: 0 });
      });
    });
    expect((await rows())[0]!.client_id).toBe("capped");
  });

  it("does not leak the client to a call outside the context", async () => {
    await reset();
    await runWithSpendClient("capped", () => paidCall(1_000_000));
    await paidCall(1_000_000);
    const all = await rows();
    expect(all.map((r) => r.client_id)).toEqual(["capped", null]);
  });

  it("a search-path call now counts toward the client's daily cap", async () => {
    await reset();
    // The point of the whole change: `search.expand` goes through no
    // withClientSpend wrapper, so before this it could not move the cap.
    expect(await daySpendUsd(storage.engine(), "capped")).toBe(0);
    await runWithSpendClient("capped", () => paidCall(1_000_000));
    expect(await daySpendUsd(storage.engine(), "capped")).toBeGreaterThan(0);

    const check = await checkClientBudget(storage.engine(), "capped");
    expect(check.capUsd).toBe(0.01);
    expect(check.allowed).toBe(false);
  });

  it("a client with no cap is unaffected — the existing single-tenant install", async () => {
    await reset();
    await runWithSpendClient("uncapped", () => paidCall(1_000_000));
    const check = await checkClientBudget(storage.engine(), "uncapped");
    expect(check.capUsd).toBeNull();
    expect(check.allowed).toBe(true);
  });
});

describe("auth set-budget", () => {
  it("sets and clears the cap the budget check reads", async () => {
    await reset();
    const provider = new OAuthProvider({ engine: storage.raw() });
    expect(await provider.setClientBudget("uncapped", 0.25)).toBe(true);
    expect((await checkClientBudget(storage.engine(), "uncapped")).capUsd).toBe(0.25);

    expect(await provider.setClientBudget("uncapped", null)).toBe(true);
    expect((await checkClientBudget(storage.engine(), "uncapped")).capUsd).toBeNull();
  });

  it("refuses a negative cap and an unknown client", async () => {
    await reset();
    const provider = new OAuthProvider({ engine: storage.raw() });
    await expect(provider.setClientBudget("capped", -1)).rejects.toThrow();
    expect(await provider.setClientBudget("no-such-client", 1)).toBe(false);
  });
});


describe("an exhausted client is refused, not merely logged", () => {
  // withClientSpend wraps three ops, so before this a capped client could burn
  // its budget and then keep calling `search` — whose embedding is paid — all
  // day. The refusal lives at the one chokepoint every paid call passes.
  it("refuses the next paid call once the cap is spent", async () => {
    await reset();
    await runWithSpendClient("capped", () => paidCall(1_000_000));
    expect((await checkClientBudget(storage.engine(), "capped")).allowed).toBe(false);
    await expect(
      runWithSpendClient("capped", () => paidCall(1_000)),
    ).rejects.toBeInstanceOf(OperationError);
  });

  it("never refuses an uncapped client", async () => {
    await reset();
    for (let i = 0; i < 3; i++) {
      await runWithSpendClient("uncapped", () => paidCall(1_000_000));
    }
    const all = await rows();
    expect(all).toHaveLength(3);
  });

  it("never refuses a caller with no client in scope", async () => {
    await reset();
    for (let i = 0; i < 3; i++) await paidCall(1_000_000);
    expect(await rows()).toHaveLength(3);
  });
});

describe("a refusal must not destroy a write", () => {
  // The indexer embeds BEFORE it touches the DB so a Bedrock outage cannot
  // half-write a document. That guard would also throw away the caller's text
  // when the refusal is our own budget policy — which is the wrong trade: the
  // note is the thing worth keeping, and the vector can be filled in later.
  it("stores the document unembedded instead of failing the write", async () => {
    await reset();
    const refuse = () => {
      throw new OperationError("budget_exhausted", "daily budget exhausted", "wait");
    };
    const r = await indexDocument(
      storage,
      {
        sourcePath: "page://budget-refusal-probe",
        text: "a note the caller would hate to lose",
      },
      { embedFn: refuse as never },
    );
    expect(r).toBeTruthy();
    const chunks = await storage.engine().query<{ n: number; embedded: number }>(
      `SELECT COUNT(*)::int AS n,
              COUNT(em.chunk_id)::int AS embedded
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         LEFT JOIN embeddings em ON em.chunk_id = c.id
        WHERE d.source_path = $1`,
      ["page://budget-refusal-probe"],
    );
    expect(chunks.rows[0]!.n).toBeGreaterThan(0);
    expect(chunks.rows[0]!.embedded).toBe(0);
  });

  it("still aborts the write on a non-budget embed failure", async () => {
    await reset();
    const boom = () => {
      throw new Error("bedrock is down");
    };
    await expect(
      indexDocument(
        storage,
        {
          sourcePath: "page://outage-probe",
          text: "half-written documents are worse than none",
        },
        { embedFn: boom as never },
      ),
    ).rejects.toThrow("bedrock is down");
  });
});
