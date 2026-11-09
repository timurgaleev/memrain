import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink, traverseGraph } from "../src/core/links.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`bounded graph walk (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const nodes = Array.from({ length: 30 }, (_, i) => `dense/n${String(i).padStart(2, "0")}`);
  beforeAll(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "walk-other", kind: "vault", pathPrefix: "/walk-other" });
    for (const slug of [...nodes, "sparse/start", "sparse/a", "sparse/b", "sparse/journal", "life/diary/hidden"]) {
      await putPage(db.storage, { slug, type: slug.endsWith("journal") ? "journal" : "note" });
    }
    await db.storage.engine().query(`INSERT INTO links (source_slug, target_slug, type)
      SELECT a.slug, b.slug, 'related_to' FROM unnest($1::text[]) a(slug) CROSS JOIN unnest($1::text[]) b(slug) WHERE a.slug <> b.slug`, [nodes]);
    for (const target of ["sparse/a", "sparse/b", "sparse/journal", "life/diary/hidden"]) {
      await addLink(db.storage, { source_slug: "sparse/start", target_slug: target, type: "related_to" });
    }
    await db.storage.engine().query("INSERT INTO links (source_slug, target_slug, type, source_id) VALUES ('sparse/start', 'foreign/only', 'related_to', 'walk-other')");
  });
  afterAll(async () => { await db.close(); });
  const walk = async (limit: number) => {
    const result = await dispatchTool(db.storage, { name: "traverse_graph", arguments: { start_slug: "sparse/start", max_depth: 1, limit } },
      { authInfo: { token: "test", clientId: "test", scopes: ["read"], sourceId: "default", allowedSources: ["default"], isPublic: false } });
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0]!.text);
  };

  it("reports truncation only for eligible nodes after the source and diary fences", async () => {
    const full = await walk(2);
    expect(full).toMatchObject({ hits: [{ slug: "sparse/a", depth: 1 }, { slug: "sparse/b", depth: 1 }], truncated: false });
    const limited = await walk(1);
    expect(limited.truncated).toBe(true);
    expect(limited.hits).toHaveLength(1);
    expect(limited.hint).toContain("max_depth");
    expect(JSON.stringify(limited)).not.toContain("foreign");
  });

  it("matches reference BFS on a 30-node clique at depth six without enumerating paths", async () => {
    const reference = new Map<string, number>([[nodes[0]!, 0]]);
    let frontier = [nodes[0]!];
    for (let depth = 1; depth <= 6 && frontier.length; depth++) {
      const next = nodes.filter(n => !reference.has(n) && frontier.some(from => from !== n));
      for (const n of next) reference.set(n, depth);
      frontier = next;
    }
    const expected = [...reference].filter(([, depth]) => depth > 0).map(([slug, depth]) => ({ slug, depth }));
    for (const direction of ["outbound", "inbound", "both"] as const) {
      expect(await traverseGraph(db.storage, nodes[0]!, { direction, maxDepth: 6, limit: 100 })).toEqual(expected);
    }
  }, 10_000);
});
