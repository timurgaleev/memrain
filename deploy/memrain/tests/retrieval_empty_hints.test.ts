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

  for (const name of ["search"]) {
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

});
