/**
 * Spend attribution — the `trackedInvoke` chokepoint every paid Bedrock call
 * passes through, and the operation label each of the eight invoke sites books
 * under. Before this the live mcp_spend_log held ONE row for all time: the
 * search sites bypassed accounting entirely and BudgetTracker's cost went to an
 * audit file that is off unless MEMRAIN_AUDIT_DIR is set.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationException, type BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  BudgetExhausted,
  BudgetTracker,
  chargeableUsage,
  costUsd,
  priceFor,
  setSpendLedgerEngine,
  trackedInvoke,
} from "../src/core/budget.ts";
import { embedText } from "../src/core/embedding.ts";
import { expandQuery } from "../src/core/search/expansion.ts";
import { classifyIntent } from "../src/core/search/intent.ts";
import { rerank } from "../src/core/search/two-pass.ts";
import { draftSkill } from "../src/core/skillify.ts";
import { proposeForSkill } from "../src/core/friction-propose.ts";
import { callHaiku } from "../src/core/llm/haiku.ts";
import { callSonnet } from "../src/core/llm/sonnet.ts";
import { CONTEXTUAL_LLM_LABEL, generateChunkContext } from "../src/core/search/contextual-llm.ts";

/** A tiny worst case: holds a fraction of a cent against a capped client. */
const SMALL = { input: "x", maxOutputTokens: 0 };

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const TITAN = "amazon.titan-embed-text-v2:0";

let tmp: string;
let storage: Storage;

interface LedgerRow {
  operation: string;
  spend_cents: number;
  model: string | null;
  provider: string | null;
}

async function ledger(): Promise<LedgerRow[]> {
  const r = await storage.engine().query<LedgerRow>(
    `SELECT operation, spend_cents::float8 AS spend_cents, model, provider
       FROM mcp_spend_log ORDER BY id`,
  );
  return r.rows;
}

/** Converse-shaped stub: one text block plus the usage Bedrock would report. */
function converseClient(
  text: string,
  usage: { inputTokens: number; outputTokens: number } | undefined = {
    inputTokens: 1000,
    outputTokens: 200,
  },
): BedrockRuntimeClient {
  return {
    send: mock(async () => ({
      output: { message: { content: [{ text }] } },
      ...(usage ? { usage } : {}),
    })),
  } as unknown as BedrockRuntimeClient;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-spend-attr-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  setSpendLedgerEngine(storage.engine());
});

afterEach(async () => {
  // The sink is module-global: leaving a closed engine wired would poison every
  // later test file in the same bun process.
  setSpendLedgerEngine(null);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("trackedInvoke", () => {
  it("books one labelled row carrying the call's actual cost", async () => {
    const out = await trackedInvoke({ operation: "think", model: HAIKU, worstCase: SMALL }, async (meter) => {
      meter.report({ inputTokens: 1_000_000, outputTokens: 200_000 });
      return "answer";
    });
    expect(out).toBe("answer");
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    // 1M input @ $1/1M + 200k output @ $5/1M = $2.00 = 200 cents.
    expect(rows[0]).toEqual({
      operation: "think",
      spend_cents: 200,
      model: HAIKU,
      provider: "bedrock",
    });
  });

  it("bills a call that reported usage and THEN threw", async () => {
    // The tokens were charged to the account whether or not the caller got an
    // answer out of them — booking on the success path alone loses that money.
    await expect(
      trackedInvoke({ operation: "embedding", model: HAIKU, worstCase: SMALL }, async (meter) => {
        meter.report({ inputTokens: 1_000_000, outputTokens: 0 });
        throw new Error("malformed response");
      }),
    ).rejects.toThrow("malformed response");
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("embedding");
    expect(rows[0]!.spend_cents).toBeCloseTo(100, 6);
  });

  it("books a $0 row for a call that threw before reporting usage", async () => {
    await expect(
      trackedInvoke({ operation: "query-expansion", model: HAIKU, worstCase: SMALL }, async () => {
        throw new Error("upstream down");
      }),
    ).rejects.toThrow("upstream down");
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("query-expansion");
    expect(rows[0]!.spend_cents).toBe(0);
  });

  it("books ONE row when the wrapped call retries internally", async () => {
    // The cachePoint fallback in callHaiku reports twice for one logical call;
    // the second report must replace the first, not add a row.
    await trackedInvoke({ operation: "enrich-thin", model: HAIKU, worstCase: SMALL }, async (meter) => {
      meter.report({ inputTokens: 500_000, outputTokens: 0 });
      meter.report({ inputTokens: 1_000_000, outputTokens: 0 });
      return null;
    });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spend_cents).toBeCloseTo(100, 6);
  });

  it("charges prompt-cache tokens at their real rates, not the flat input rate", async () => {
    await trackedInvoke({ operation: "enrich-thin", model: HAIKU, worstCase: SMALL }, async (meter) => {
      meter.report({
        inputTokens: 200,
        cacheWriteInputTokens: 8_000,
        cacheReadInputTokens: 20_000,
        outputTokens: 0,
      });
      return null;
    });
    // 200 + 8000*1.25 + 20000*0.1 = 12_200 effective input tokens.
    const expected = costUsd(HAIKU, { inputTokens: 12_200, outputTokens: 0 }) * 100;
    const rows = await ledger();
    expect(rows[0]!.spend_cents).toBeCloseTo(expected, 6);
    // Counting cache reads as plain input would bill ~2.3x this.
    expect(rows[0]!.spend_cents).toBeLessThan(
      costUsd(HAIKU, { inputTokens: 28_200, outputTokens: 0 }) * 100,
    );
  });

  it("swallows a ledger failure rather than breaking the paid path", async () => {
    const broken = {
      kind: "pglite",
      query: async () => {
        throw new Error("ledger table is gone");
      },
    } as unknown as Engine;
    setSpendLedgerEngine(broken);
    const out = await trackedInvoke({ operation: "think", model: HAIKU, worstCase: SMALL }, async (meter) => {
      meter.report({ inputTokens: 10, outputTokens: 1 });
      return "still answered";
    });
    expect(out).toBe("still answered");
  });

  it("is a SILENT passthrough before any engine is wired", async () => {
    // Silence is the point: a CLI process that never opens the DB would
    // otherwise log a bogus "ledger write failed" line on every paid call.
    setSpendLedgerEngine(null);
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    let out: number;
    try {
      out = await trackedInvoke({ operation: "think", model: HAIKU, worstCase: SMALL }, async (meter) => {
        meter.report({ inputTokens: 10, outputTokens: 1 });
        return 42;
      });
    } finally {
      console.warn = realWarn;
    }
    expect(out).toBe(42);
    expect(warnings).toEqual([]);
    expect(await ledger()).toHaveLength(0);
  });

  it("books an unpriced model's call at an unknown cost and says so out loud", async () => {
    // Attribution survives even when the cost can't be computed; the operator
    // gets a warning rather than a silently invented price.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      await trackedInvoke(
        { operation: "think", model: "global.amazon.nova-2-lite-v1:0", worstCase: SMALL },
        async (m) => {
          m.report({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
          return null;
        },
      );
    } finally {
      console.warn = realWarn;
    }
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    // NULL, not 0: a 0 reads as a free call, and this one was not.
    expect(rows[0]!.spend_cents).toBeNull();
    expect(rows[0]!.model).toBe("global.amazon.nova-2-lite-v1:0");
    expect(warnings.some((w) => /no pricing for model/.test(w))).toBe(true);
  });
});

describe("pricing", () => {
  it("prices embeddings on their own axis — input only, never a chat rate", () => {
    expect(priceFor(TITAN)).toEqual({ inputPer1M: 0.02, outputPer1M: 0 });
    // 1M embedded tokens is 2 cents, not the $1 a Haiku prompt of that size costs.
    expect(costUsd(TITAN, { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.02, 9);
    // The embedding table is consulted first on purpose: an embedder id that
    // happens to carry a chat family substring must not fall through to a chat
    // rate ~50x its real one.
    expect(priceFor("amazon.titan-embed-haiku-vNext")).toEqual({
      inputPer1M: 0.02,
      outputPer1M: 0,
    });
  });

  it("still refuses to spend against a model no table knows", () => {
    expect(priceFor("global.amazon.nova-2-lite-v1:0")).toBeNull();
    const b = new BudgetTracker(10, "facts-extract");
    expect(() => b.record("global.amazon.nova-2-lite-v1:0", { inputTokens: 1, outputTokens: 1 }))
      .toThrow(BudgetExhausted);
    expect(b.wouldExceed("global.amazon.nova-2-lite-v1:0", { inputTokens: 1, outputTokens: 1 }))
      .toBe(true);
  });

  it("leaves the chat ceiling exactly where it was", async () => {
    // Accounting must not move a cap: the tracker still throws at the same
    // spend, and it writes no ledger row of its own (that would double-book
    // the dollar `trackedInvoke` already wrote).
    const b = new BudgetTracker(0.001, "think");
    expect(() => b.record(HAIKU, { inputTokens: 2_000_000, outputTokens: 0 })).toThrow(
      BudgetExhausted,
    );
    expect(b.totalSpent()).toBeCloseTo(2.0, 6);
    expect(await ledger()).toHaveLength(0);
  });

  it("folds cache tokens into an equivalent uncached count", () => {
    expect(chargeableUsage({ inputTokens: 100, outputTokens: 7 })).toEqual({
      inputTokens: 100,
      outputTokens: 7,
    });
    expect(
      chargeableUsage({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 1000,
        cacheWriteInputTokens: 1000,
      }),
    ).toEqual({ inputTokens: 1350, outputTokens: 0 });
  });
});

describe("every invoke site carries a label", () => {
  it("embedding", async () => {
    const client = {
      send: mock(async () => ({
        body: new TextEncoder().encode(
          JSON.stringify({ embedding: new Array(1024).fill(0), inputTextTokenCount: 500_000 }),
        ),
      })),
    } as unknown as BedrockRuntimeClient;
    await embedText("hello world", { client });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("embedding");
    expect(rows[0]!.model).toBe(TITAN);
    // 500k tokens @ $0.02/1M = $0.01 = 1 cent.
    expect(rows[0]!.spend_cents).toBeCloseTo(1, 6);
  });

  it("embedding — a response Titan billed for but we can't store is still booked", async () => {
    const client = {
      send: mock(async () => ({
        body: new TextEncoder().encode(
          JSON.stringify({ embedding: new Array(512).fill(0), inputTextTokenCount: 500_000 }),
        ),
      })),
    } as unknown as BedrockRuntimeClient;
    await expect(embedText("hello", { client })).rejects.toThrow(/1024/);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("embedding");
    expect(rows[0]!.spend_cents).toBeCloseTo(1, 6);
  });

  it("query expansion", async () => {
    const out = await expandQuery("memrain master plan", {
      modelId: HAIKU,
      client: converseClient("the memrain blueprint\nmemrain roadmap"),
    });
    expect(out).toEqual(["the memrain blueprint", "memrain roadmap"]);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("query-expansion");
    expect(rows[0]!.spend_cents).toBeCloseTo(0.2, 6);
  });

  it("query expansion — a failed call books its attempt before failing open", async () => {
    const client = {
      send: mock(async () => {
        throw new Error("bedrock 503");
      }),
    } as unknown as BedrockRuntimeClient;
    expect(await expandQuery("memrain master plan", { client })).toEqual([]);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("query-expansion");
  });

  it("intent classification", async () => {
    const prev = process.env.MEMRAIN_INTENT_LLM;
    process.env.MEMRAIN_INTENT_LLM = "1";
    try {
      // A query no cheap heuristic answers, so the paid arm actually runs.
      const intent = await classifyIntent("memrain master plan", {
        client: converseClient("topic"),
      });
      expect(intent).toBe("topic");
    } finally {
      if (prev === undefined) delete process.env.MEMRAIN_INTENT_LLM;
      else process.env.MEMRAIN_INTENT_LLM = prev;
    }
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("intent-classify");
  });

  it("intent classification books nothing on the zero-LLM default path", async () => {
    const prev = process.env.MEMRAIN_INTENT_LLM;
    delete process.env.MEMRAIN_INTENT_LLM;
    try {
      expect(await classifyIntent("memrain master plan")).toBe("topic");
    } finally {
      if (prev !== undefined) process.env.MEMRAIN_INTENT_LLM = prev;
    }
    expect(await ledger()).toHaveLength(0);
  });

  it("two-pass rerank", async () => {
    const hits = [
      { chunkId: "a", documentId: "doc-a", score: 2, payload: { content: "x", title: "A", sourcePath: "a.md" } },
      { chunkId: "b", documentId: "doc-b", score: 1, payload: { content: "y", title: "B", sourcePath: "b.md" } },
    ];
    const out = await rerank("q", hits, { modelId: HAIKU, client: converseClient("[1,0]") });
    expect(out.map((h) => h.chunkId)).toEqual(["b", "a"]);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("rerank-two-pass");
    expect(rows[0]!.spend_cents).toBeCloseTo(0.2, 6);
  });

  it("two-pass rerank — a failed call books before returning the input order", async () => {
    const hits = [
      { chunkId: "a", documentId: "doc-a", score: 2, payload: { content: "x", title: "A", sourcePath: "a.md" } },
      { chunkId: "b", documentId: "doc-b", score: 1, payload: { content: "y", title: "B", sourcePath: "b.md" } },
    ];
    const client = {
      send: mock(async () => {
        throw new Error("bedrock 503");
      }),
    } as unknown as BedrockRuntimeClient;
    const out = await rerank("q", hits, { client });
    expect(out.map((h) => h.chunkId)).toEqual(["a", "b"]);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("rerank-two-pass");
  });

  it("skillify", async () => {
    await draftSkill("summarise my workouts", { client: converseClient("# a skill") });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("skillify");
  });

  it("friction propose", async () => {
    const client = converseClient(
      JSON.stringify({ rationale: "the how section misleads", suggestion: "# fixed" }),
    );
    await proposeForSkill("s", "deploy/skills/s.md", "# s", [], 3, { client });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("friction-propose");
  });

  it("contextual chunk context", async () => {
    // The index-time contextual call used to hide inside `utility-llm`, next to
    // every other unnamed Haiku call, so the write path's LLM cost could not be
    // told apart from the rest of the tier.
    const ctx = await generateChunkContext("the whole document", "one chunk of it", {
      client: converseClient("situates the chunk"),
      modelId: HAIKU,
    });
    expect(ctx).toBe("situates the chunk");
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe(CONTEXTUAL_LLM_LABEL);
  });

  it("the utility tier — a caller that names itself vs one that doesn't", async () => {
    await callHaiku(
      { system: "s", user: "u", maxTokens: 10 },
      { client: converseClient("ok"), modelId: HAIKU },
    );
    await callHaiku(
      { system: "s", user: "u", maxTokens: 10 },
      { client: converseClient("ok"), modelId: HAIKU, operation: "graph-rerank" },
    );
    expect((await ledger()).map((r) => r.operation)).toEqual(["utility-llm", "graph-rerank"]);
  });

  it("the utility tier books ONE row when the cachePoint retry fires", async () => {
    // A model/region that can't cache rejects the cachePoint and callHaiku
    // retries uncached. That is one logical call and must cost one row —
    // wrapping each attempt separately would double-book it.
    let attempt = 0;
    const client = {
      send: mock(async () => {
        if (++attempt === 1) {
          throw new ValidationException({ message: "no cachePoint here", $metadata: {} });
        }
        return {
          output: { message: { content: [{ text: "ok" }] } },
          usage: { inputTokens: 1000, outputTokens: 200 },
        };
      }),
    } as unknown as BedrockRuntimeClient;
    const res = await callHaiku(
      { system: "s", user: "u", maxTokens: 10, cachePrefix: "doc" },
      { client, modelId: HAIKU },
    );
    expect(res.text).toBe("ok");
    expect(attempt).toBe(2);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spend_cents).toBeCloseTo(0.2, 6);
  });

  it("the reasoning tier — a caller that names itself vs one that doesn't", async () => {
    const model = "eu.anthropic.claude-sonnet-4-6";
    await callSonnet(
      { system: "s", user: "u", maxTokens: 10 },
      { client: converseClient("ok"), modelId: model },
    );
    await callSonnet(
      { system: "s", user: "u", maxTokens: 10 },
      { client: converseClient("ok"), modelId: model, operation: "facts-extract" },
    );
    const rows = await ledger();
    expect(rows.map((r) => r.operation)).toEqual(["reasoning-llm", "facts-extract"]);
    // Sonnet: 1000 in @ $3/1M + 200 out @ $15/1M = $0.006 = 0.6 cents.
    expect(rows[0]!.spend_cents).toBeCloseTo(0.6, 6);
  });
});
