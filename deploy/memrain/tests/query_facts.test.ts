import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact } from "../src/core/facts.ts";
import { putPage, deletePage, getPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { deterministicEmbed } from "./det-embed.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`query facts ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  const auth: AuthInfo = { token: "test", clientId: "query-facts", sourceId: "query-a", allowedSources: ["query-a"], scopes: ["read"], isPublic: false };
  const call = async (q: string, extra: Record<string, unknown> = {}, remote = false) => {
    const r = await dispatchTool(db.storage, { name: "query", arguments: { q, expand: false, ...extra } }, { embedQuery: async () => [], ...(remote ? { authInfo: auth } : {}) });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    return JSON.parse(r.content[0]!.text);
  };
  beforeAll(async () => {
    db = await engine.open();
    for (const id of ["query-a", "query-b"]) await registerSource(db.storage.engine(), { id, kind: "vault", pathPrefix: `/${id}` });
    for (const fact of ["Revenue growth quarter forecast improved", "Revenue growth quarter stable", "Revenue quarter forecast unchanged", "Revenue growth only"]) {
      await addFact(db.storage, { entity_slug: "projects/forecast", fact, visibility: "world" });
    }
    await addFact(db.storage, { entity_slug: "projects/count", fact: "The count is 12" });
    await addFact(db.storage, { entity_slug: "projects/count", fact: "The countersigned report is ready" });
    await putPage(db.storage, { slug: "notes/journal-origin", type: "journal", markdown_body: "journal", source_id: "query-a" });
    await putPage(db.storage, { slug: "notes/deleted-origin", markdown_body: "gone", source_id: "query-a" });
    await deletePage(db.storage, "notes/deleted-origin");
    await putPage(db.storage, { slug: "notes/held-origin", markdown_body: "Checking your browser before accessing example.com. Cloudflare Ray ID: 8badf00d", source_id: "query-a" });
    await indexPageIntoSearch(db.storage, (await getPage(db.storage, "notes/held-origin"))!, { embedFn: async text => deterministicEmbed(text) });
    for (const [fact, visibility, source_id, source_slug] of [
      ["quartz hidden-private", "private", "query-a", undefined],
      ["quartz hidden-foreign", "world", "query-b", undefined],
      ["quartz hidden-diary", "world", "query-a", "notes/journal-origin"],
      ["quartz hidden-deleted", "world", "query-a", "notes/deleted-origin"],
      ["quartz hidden-held", "world", "query-a", "notes/held-origin"],
      ["quartz retained-claim", "world", "query-a", undefined],
    ] as const) await addFact(db.storage, { entity_slug: "projects/quartz", fact, visibility, source_id, source_slug, valid_from: "2025-10-01", written_by_principal: "client:external" });
  });
  afterAll(async () => { await db.close(); });
  it("returns up to three sufficiently matching ledger facts separately from chunks", async () => {
    const r = await call("What is the revenue growth quarter forecast?");
    expect(r.facts).toHaveLength(3);
    expect(r.facts[0].fact).toBe("Revenue growth quarter forecast improved");
    expect(r.facts.every((f: any) => f.follow_up === "entity_facts" && typeof f.fact_id === "number")).toBe(true);
    expect(r.facts.some((f: any) => f.fact === "Revenue growth only")).toBe(false);
    expect(r.hint).toBeUndefined();
    expect(r.hits).toEqual([]);
  });
  it("matches whole lexemes, not substrings, and ignores function-word-only queries", async () => {
    expect((await call("count")).facts.map((f: any) => f.fact)).toEqual(["The count is 12"]);
    expect((await call("what is the")).facts).toEqual([]);
  });
  it("filters private, foreign, diary and held origins before LIMIT and frames external facts", async () => {
    for (const extra of [{}, { refine: "quartz" }]) {
      const r = await call("quartz", extra, true);
      expect(r.facts).toHaveLength(1);
      expect(r.facts[0]).toMatchObject({ entity_slug: "projects/quartz", valid_from: "2025-10-01", trust: "external" });
      expect(r.facts[0].fact).toContain('<external_content trust="external">');
      expect(r.facts[0].fact).toContain("retained-claim");
      expect(JSON.stringify(r)).not.toContain("hidden-");
      expect(r.hint).toBeUndefined();
    }
    expect((await call("quartz", { token_budget: 1 }, true)).facts).toEqual([]);
  });
});
