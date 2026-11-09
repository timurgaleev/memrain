import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import { setSpendLedgerEngine, trackedInvoke } from "../src/core/budget.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { withRequestCost } from "../src/core/request-cost.ts";
import type { Engine } from "../src/core/engine/interface.ts";

describe("request-local MCP cost", () => {
  let db: Awaited<ReturnType<ReturnType<typeof storageEngines>[number]["open"]>>;
  beforeAll(async () => {
    db = await storageEngines(undefined)[0]!.open();
    await indexPageIntoSearch(db.storage, { slug: "notes/cost", title: "Cost sample", markdown_body: "A cedar forest." }, {
      embedFn: async text => deterministicEmbed(text),
    });
  });
  afterAll(async () => { setSpendLedgerEngine(null); await db.close(); });
  async function search(q: string, embedQuery: DispatchOptions["embedQuery"], extra: DispatchOptions = {}) {
    const result = await dispatchTool(db.storage, { name: "search", arguments: { q, explain: true } }, { embedQuery, ...extra });
    expect(result.isError).toBeFalsy();
    return result;
  }
  const paid = (q: string, tokens: number, model = "amazon.titan-embed-text-v2:0") =>
    trackedInvoke({ operation: "query-embedding", model, worstCase: { input: q, maxOutputTokens: 0 } }, async meter => {
      await Promise.resolve();
      meter.report({ inputTokens: tokens, outputTokens: 0 });
      return deterministicEmbed(q);
    });
  it("counts actual calls without a ledger and isolates parallel requests", async () => {
    setSpendLedgerEngine(null);
    const results = await Promise.all([100, 500].map(tokens => search(`forest ${tokens}`, q => paid(q, tokens))));
    for (const [i, tokens] of [100, 500].entries()) {
      expect(results[i]!._meta?.cost).toEqual({ calls: 1, known_usd: (tokens / 1e6) * 0.02, unknown_calls: 0, usd: (tokens / 1e6) * 0.02 });
    }
  });
  it("keeps unpriced usage and timed-out attempts unknown", async () => {
    const unpriced = await search("unknown forest", q => paid(q, 100, "unpriced-fixture"));
    expect(unpriced._meta?.cost).toEqual({ calls: 1, known_usd: 0, unknown_calls: 1, usd: null });
    const timed = await search("timeout forest", q => trackedInvoke({ operation: "query-embedding", model: "amazon.titan-embed-text-v2:0", worstCase: { input: q, maxOutputTokens: 0 } }, async () => {
      const error = new Error("request timed out"); error.name = "TimeoutError"; throw error;
    }));
    expect(timed._meta?.cost).toEqual({ calls: 1, known_usd: 0, unknown_calls: 1, usd: null });
  });
  it("retains exact reported cost when the durable ledger fails", async () => {
    setSpendLedgerEngine({ kind: "pglite", query: async () => { throw new Error("fixture ledger unavailable"); } } as unknown as Engine);
    try {
      const result = await search("ledger failure forest", q => paid(q, 250));
      expect(result._meta?.cost).toEqual({ calls: 1, known_usd: (250 / 1e6) * 0.02, unknown_calls: 0, usd: (250 / 1e6) * 0.02 });
    } finally { setSpendLedgerEngine(null); }
  });
  it("keeps an in-flight call unknown in the returned snapshot after later settlement", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let pending: Promise<number[]> | undefined;
    const result = await withRequestCost(async () => {
      pending = trackedInvoke({ operation: "query-embedding", model: "amazon.titan-embed-text-v2:0", worstCase: { input: "pending", maxOutputTokens: 0 } }, async meter => {
        entered.resolve();
        await release.promise;
        meter.report({ inputTokens: 250, outputTokens: 0 });
        return deterministicEmbed("pending");
      });
      await entered.promise;
      return "reply before model";
    });
    expect(result.cost).toEqual({ calls: 1, known_usd: 0, unknown_calls: 1, usd: null });
    release.resolve();
    await pending;
    expect(result.cost.usd).toBeNull();
  });
  it("counts nested calls once in the parent while retaining the child's own total", async () => {
    let childCost: unknown;
    const outer = await search("nested forest", async q => {
      childCost = (await search("inner forest", text => paid(text, 300)))._meta?.cost;
      return paid(q, 100);
    });
    expect(childCost).toMatchObject({ calls: 1, usd: (300 / 1e6) * 0.02 });
    expect(outer._meta?.cost).toMatchObject({ calls: 2, usd: (300 / 1e6) * 0.02 + (100 / 1e6) * 0.02 });
  });
  it("omits costs without paid calls and never exposes costs to tenants or public ingress", async () => {
    const free = await search("free forest", async q => deterministicEmbed(q));
    expect(free._meta?.cost).toBeUndefined();
    for (const options of [{ isPublic: true }, { authInfo: { clientId: "reader", scopes: ["read"], sourceId: "default", allowedSources: ["default"] } as DispatchOptions["authInfo"] }]) {
      const result = await search("private costs", q => paid(q, 100), options);
      expect(result._meta?.cost).toBeUndefined();
    }
  });
  it("does not start or charge a metered call when a real cached ranking serves the request", async () => {
    let sends = 0;
    const q = "cedar forest";
    const request = { name: "search", arguments: { q, k: 5 } };
    const options = { embedQuery: (text: string) => {
      sends++;
      return paid(text, 100);
    } };
    const fresh = await dispatchTool(db.storage, request, options);
    expect(fresh.isError).toBeFalsy();
    const first = JSON.parse(fresh.content[0]!.text);
    expect(first.hits.length).toBeGreaterThan(0);
    expect(first.meta.cache).toBe("miss");
    expect(first.meta.degraded).toEqual([]);
    expect(fresh._meta?.cost).toMatchObject({ calls: 1, unknown_calls: 0 });
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      ready = (await db.storage.engine().query("SELECT 1 FROM query_cache WHERE query = $1", [q])).rows.length > 0;
      if (!ready) await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    const cached = await dispatchTool(db.storage, request, options);
    expect(cached.isError).toBeFalsy();
    const value = JSON.parse(cached.content[0]!.text);
    expect(value.meta.cache).toBe("hit");
    expect(value.hits.map((hit: { chunkId: string }) => hit.chunkId)).toEqual(first.hits.map((hit: { chunkId: string }) => hit.chunkId));
    expect(sends).toBe(1);
    expect(cached._meta?.cost).toBeUndefined();
  });
  it("serializes compact JSON without changing numbers or payload", async () => {
    const result = await search("compact forest", async q => deterministicEmbed(q));
    const text = result.content[0]!.text;
    const value = JSON.parse(text);
    expect(text).toBe(JSON.stringify(value));
    expect(Buffer.byteLength(text)).toBeLessThan(Buffer.byteLength(JSON.stringify(value, null, 2)));
    expect(value.hits[0].score).toBe(JSON.parse(JSON.stringify(value)).hits[0].score);
  });
});
