import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { hybridSearch, QueryEmbedDeadlineError } from "../src/core/search/hybrid.ts";
import type { SearchMeta } from "../src/core/search/search-meta.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`search diagnostics (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const embedQuery = async (text: string) => deterministicEmbed(text);
  beforeAll(async () => {
    db = await open();
    await db.storage.engine().query("INSERT INTO sources(id,kind,path_prefix) VALUES ('diag-foreign','other','/diag-foreign/')");
    for (const [slug, principal, source] of [
      ["atoms/proved", "operator", "default"], ["atoms/spoofed", "client:spoof", "default"],
      ["atoms/legacy", null, "default"], ["atoms/stale", "operator", "default"],
      ["atoms/foreign", "operator", "diag-foreign"],
    ] as const) {
      const input = { slug, markdown_body: `Juniper diagnostic ${slug}`, title: "Juniper diagnostics", source_id: source, written_by: "extract-atoms", written_by_principal: principal ?? undefined };
      const result = await putPage(db.storage, input);
      await indexPageIntoSearch(db.storage, { ...input, content_hash: result.content_hash }, { embedFn: embedQuery });
    }
    await putPage(db.storage, { slug: "atoms/stale", markdown_body: "Changed after mirror", written_by: "extract-atoms", written_by_principal: "operator" });
    for (const [id, meta, source] of [
      ["pending", {}, "default"], ["skipped", { embed_skip: true }, "default"],
      ["code", { kind: "code" }, "default"], ["held", { quarantine: {} }, "default"],
      ["foreign", {}, "diag-foreign"], ["archived", {}, "default"], ["deleted", {}, "default"],
    ] as const) {
      await db.storage.engine().query("INSERT INTO documents(id,source_path,source_id,frontmatter) VALUES($1,$2,$3,$4::text::jsonb)", [id, `/diag/${id}`, source, JSON.stringify(meta)]);
      await db.storage.engine().query("INSERT INTO chunks(id,document_id,chunk_index,content) VALUES($1,$2,0,'Juniper pending diagnostic')", [`diag-${id}`, id]);
    }
    await db.storage.engine().query("UPDATE documents SET archived = true WHERE id = 'archived'");
    await db.storage.engine().query("UPDATE documents SET deleted_at = NOW() WHERE id = 'deleted'");
  });
  afterAll(async () => { await db.close(); });
  async function search(args: Record<string, unknown>, options: DispatchOptions = {}) {
    const result = await dispatchTool(db.storage, { name: "search", arguments: { q: "Juniper", source_ids: ["default"], ...args } }, { embedQuery, ...options });
    expect(result.isError, result.content[0]!.text).toBeFalsy();
    return JSON.parse(result.content[0]!.text);
  }
  function pendingProbe(onCount: () => void) {
    const engine = db.storage.engine();
    const observed = new Proxy(engine, { get(target, key) {
      if (key === "query") return (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT count(*)::int AS n") && sql.includes("NOT EXISTS (SELECT 1 FROM embeddings")) onCount();
        return target.query(sql, params);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return new Proxy(db.storage, { get(target, key) {
      if (key === "engine") return () => observed;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  function finiteIntervals(timings: Record<string, number>) {
    for (const value of Object.values(timings)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(Object.entries(timings).filter(([key]) => key !== "total").reduce((sum, [, value]) => sum + value, 0))
      .toBeLessThanOrEqual(timings.total!);
  }
  it("labels only currently proved internal generation, preserving source boundaries and scores", async () => {
    const result = await search({ explain: true });
    const hit = (slug: string) => result.hits.find((row: { sourcePath: string }) => row.sourcePath === `page://${slug}`);
    expect(hit("atoms/proved").generated).toBe(true);
    for (const slug of ["atoms/spoofed", "atoms/legacy", "atoms/stale"]) expect(hit(slug).generated).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("atoms/foreign");
    const cached = await search({});
    expect(cached.hits.find((row: { sourcePath: string }) => row.sourcePath === "page://atoms/proved").generated).toBe(true);
  });
  it("reports finite monotonic stages and only eligible pending embeddings for operator explain", async () => {
    const result = await search({ explain: true });
    expect(result.meta.pending_embeddings).toBe(1);
    expect(result.meta.timings_ms.total).toBeGreaterThan(0);
    expect(result.meta.timings_ms.retrieval).toBeGreaterThanOrEqual(0);
    for (const value of Object.values(result.meta.timings_ms)) expect(Number.isFinite(value)).toBe(true);
    const normal = await search({});
    expect(normal.meta.timings_ms).toBeUndefined();
    const authInfo = { clientId: "diag-reader", scopes: ["read"], sourceId: "default", allowedSources: ["default"] } as DispatchOptions["authInfo"];
    for (const options of [{ authInfo }, { isPublic: true }]) {
      const remote = await search({ explain: true }, options);
      expect(remote.meta.timings_ms).toBeUndefined();
      expect(remote.meta.pending_embeddings).toBeUndefined();
    }
  });
  it("measures refinement once without duplicate embedding counts or diagnostic work for other callers", async () => {
    let counts = 0;
    let embeddings = 0;
    const storage = pendingProbe(() => { counts++; });
    const args = { q: "Juniper diagnostics", refine: "Juniper diagnostic", source_ids: ["default"], k: 5 };
    const options = { embedQuery: async (text: string) => { embeddings++; return deterministicEmbed(text); } };
    const result = await dispatchTool(storage, { name: "query", arguments: { ...args, explain: true } }, options);
    expect(result.isError, result.content[0]!.text).toBeFalsy();
    const value = JSON.parse(result.content[0]!.text);
    expect(value.hits.length).toBeGreaterThan(0);
    expect(value.meta?.pending_embeddings).toBe(1);
    expect(counts).toBe(1);
    expect(embeddings).toBe(2);
    expect(value.meta.timings_ms.refinement).toBeGreaterThan(0);
    expect(value.meta.timings_ms.projection).toBeGreaterThanOrEqual(0);
    expect(value.meta.timings_ms.retrieval).toBeUndefined();
    expect(value.meta.timings_ms.ranking).toBeUndefined();
    expect(JSON.stringify(value)).not.toContain("diag-foreign");
    finiteIntervals(value.meta.timings_ms);
    const plain = await dispatchTool(storage, { name: "query", arguments: args }, options);
    expect(JSON.parse(plain.content[0]!.text).meta).toBeUndefined();
    const authInfo = { clientId: "refine-reader", scopes: ["read"], sourceId: "default", allowedSources: ["default"] } as DispatchOptions["authInfo"];
    for (const context of [{ authInfo }, { isPublic: true }]) {
      const remote = await dispatchTool(storage, { name: "query", arguments: { ...args, explain: true } }, { ...options, ...context });
      expect(remote.content[0]!.text).not.toContain("timings_ms");
      expect(remote.content[0]!.text).not.toContain("pending_embeddings");
    }
    expect(counts).toBe(1);
  });
  it("keeps unavailable pending counts unknown and timers finite on degraded search and refinement", async () => {
    for (const [name, refine] of [["search", undefined], ["query", undefined], ["query", "pending"]] as const) {
      let counts = 0;
      const storage = pendingProbe(() => { counts++; throw new Error("fixture count unavailable"); });
      const result = await dispatchTool(storage, { name, arguments: {
        q: "Juniper pending", explain: true, source_ids: ["default"], ...(refine ? { refine } : {}),
      } }, { embedQuery: async () => { throw new QueryEmbedDeadlineError("fixture embed deadline"); } });
      expect(result.isError, result.content[0]!.text).toBeFalsy();
      const value = JSON.parse(result.content[0]!.text);
      expect(value.hits.length).toBeGreaterThan(0);
      expect(value.meta?.pending_embeddings).toBeNull();
      expect(value.meta.degraded).toContain("embed_timeout");
      finiteIntervals(value.meta.timings_ms);
      expect(counts).toBe(1);
    }
  });
  it("reports diagnostics on an actual cache hit without another query embedding", async () => {
    const q = "Juniper pending diagnostic";
    let embeddings = 0;
    const seen: SearchMeta[] = [];
    const options = { k: 5, sourceIds: ["default"], noExpansion: true, noTelemetry: true, diagnostics: true,
      embedQuery: async (text: string) => { embeddings++; return deterministicEmbed(text); },
      onMeta: (meta: SearchMeta) => { seen.push(meta); } };
    const fresh = await hybridSearch(db.storage, q, options);
    expect(seen[0]?.cache).toBe("miss");
    expect(seen[0]?.degraded).toEqual([]);
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      ready = (await db.storage.engine().query("SELECT 1 FROM query_cache WHERE query = $1", [q])).rows.length > 0;
      if (!ready) await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    const cached = await hybridSearch(db.storage, q, options);
    expect(cached.map(hit => hit.chunkId)).toEqual(fresh.map(hit => hit.chunkId));
    expect(seen[1]?.cache).toBe("hit");
    expect(seen[1]?.pending_embeddings).toBe(1);
    finiteIntervals(seen[1]!.timings_ms!);
    expect(embeddings).toBe(1);
  });
});
