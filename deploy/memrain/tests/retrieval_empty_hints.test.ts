import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";
import { estTokens } from "../src/core/search/token-budget.ts";

describe("retrieval diagnostics and budget candidates", () => {
  let db: Awaited<ReturnType<ReturnType<typeof storageEngines>[number]["open"]>>;
  beforeAll(async () => {
    db = await storageEngines(undefined)[0]!.open();
    for (let n = 0; n < 35; n++) {
      const text = `Garden planning subject ${n} with a unique approach ${n * 17}.`;
      await writeDocumentTransaction(db.storage, { documentId: `hint-${n}`, sourcePath: `/hints/${n}.md`,
        title: `Garden ${n}`, frontmatter: {}, embeddingModel: "deterministic-test", sourceId: "default" },
      [{ text, entities: [], embedding: deterministicEmbed(text) }]);
    }
  });
  afterAll(async () => { await db.close(); });
  const call = async (name: string, args: Record<string, unknown>, opts: DispatchOptions = {}) => {
    const result = await dispatchTool(db.storage, { name, arguments: { q: "garden", ...args } }, { embedQuery: deterministicEmbedQuery, ...opts });
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0]!.text);
  };

  for (const name of ["search", "query"]) {
    it(`${name} distinguishes a healthy miss, degraded retrieval and an empty grant`, async () => {
      const missing = await call(name, { q: "garden empty healthy", since: "2999-01-01" });
      expect(missing.hits).toEqual([]);
      expect(missing.hint.status).toBe("retrieval_healthy");
      expect(missing.hint.try.length).toBeGreaterThan(0);
      const failed = await call(name, { q: "garden empty degraded", since: "2999-01-01" }, { embedQuery: async () => { throw new Error("test embed failure"); } });
      expect(failed.hits).toEqual([]);
      expect(failed.hint.status).toBe("retrieval_degraded");
      expect(failed.hint.reasons).toContain("vector_arm_failed");
      const old = process.env.MEMRAIN_TENANT_FAIL_CLOSED;
      process.env.MEMRAIN_TENANT_FAIL_CLOSED = "1";
      try {
        const empty = await call(name, {}, { authInfo: { token: "test", clientId: "no-grant", scopes: ["read"], allowedSources: [], isPublic: false } });
        expect(empty).toMatchObject({ hits: [], hint: { status: "grant_sources_empty" } });
        expect(JSON.stringify(empty.hint)).not.toMatch(/default|hint-|garden|source_ids/);
      } finally {
        if (old === undefined) delete process.env.MEMRAIN_TENANT_FAIL_CLOSED;
        else process.env.MEMRAIN_TENANT_FAIL_CLOSED = old;
      }
    });
  }

  it("a budget without k can return more than twenty hits; explicit k and default width stay unchanged", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const ordinary = await call("query", {});
      const budgeted = await call("query", { token_budget: 10000 });
      const explicit = await call("query", { token_budget: 10000, k: 3 });
      expect(ordinary.hits).toHaveLength(20);
      expect(budgeted.hits.length).toBeGreaterThan(20);
      expect(explicit.hits).toHaveLength(3);
      expect(budgeted.hits.reduce((sum: number, hit: { content: string; title: string }) => sum + estTokens(hit.content) + estTokens(hit.title), 0)).toBeLessThanOrEqual(10000);
      expect(budgeted.hits.slice(0, 20)).toEqual(ordinary.hits);
      expect(budgeted.hint).toBeUndefined();
    } finally { clock.mockRestore(); }
  });
});
