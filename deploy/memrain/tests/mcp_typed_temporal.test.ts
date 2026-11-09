import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import { putPage } from "../src/core/pages.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`typed and temporal MCP (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const authInfo = { clientId: "typed-reader", scopes: ["read", "write"], sourceId: "default", allowedSources: ["default"] } as DispatchOptions["authInfo"];
  beforeAll(async () => {
    db = await open();
    for (const slug of ["notes/left", "notes/right"]) await putPage(db.storage, { slug, markdown_body: slug });
    await db.storage.engine().query(`INSERT INTO entity_facts(entity_slug,fact,claim_metric,claim_value,claim_unit,claim_period,valid_from,written_by_principal,source_id,visibility)
      VALUES ('notes/left','Revenue <outside> 100','revenue',100,'USD','monthly','2026-11-01','client:typed-reader','default','world'),
      ('notes/left','Revenue 120','revenue',120,'USD','monthly','2026-11-02',NULL,'default','world')`);
  });
  afterAll(async () => { await db.close(); });
  async function call(name: string, args: Record<string, unknown>) {
    const result = await dispatchTool(db.storage, { name, arguments: args }, { authInfo });
    expect(result.isError, result.content[0]!.text).toBeFalsy();
    return JSON.parse(result.content[0]!.text);
  }
  it("reads typed groups with framed claims, exact decimals and no legacy scans", async () => {
    const result = await call("find_contradictions", { mode: "typed", entity_slug: "notes/left" });
    expect(result.mode).toBe("typed");
    expect(result.typed).toHaveLength(1);
    expect(result.typed[0].claims.map((claim: { value: string }) => claim.value)).toEqual(["100", "120"]);
    expect(result.typed[0].claims[0].fact).toContain('<external_content trust="external">');
    expect(result.typed[0].claims[0].fact).toContain("&lt;outside&gt;");
    expect(result.contradictions).toBeUndefined();
    for (const invalid of [{ mode: "typed", slug: "notes" }, { mode: "typed", severity: "high" }, { entity_slug: "notes/left" }]) {
      const denied = await dispatchTool(db.storage, { name: "find_contradictions", arguments: invalid }, { authInfo });
      expect(denied.isError).toBe(true);
      expect(JSON.parse(denied.content[0]!.text).error).toBe("invalid_params");
    }
  });
  it("sets a manual interval and applies half-open dates across every graph read", async () => {
    await call("link", { source_slug: "notes/left", target_slug: "notes/right", type: "related_to", valid_from: "2026-11-01", valid_until: "2026-12-01" });
    for (const [tool, args, field] of [
      ["graph_neighbors", { slug: "notes/left" }, "links"],
      ["graph_query", { source_slug: "notes/left", type: "related_to" }, "links"],
      ["traverse_graph", { start_slug: "notes/left" }, "hits"],
      ["get_links", { slug: "notes/left" }, "groups"],
    ] as const) {
      expect((await call(tool, { ...args, status: "active", as_of: "2026-11-30" }))[field].length).toBeGreaterThan(0);
      expect((await call(tool, { ...args, status: "active", as_of: "2026-12-01" }))[field]).toEqual([]);
      expect((await call(tool, { ...args, status: "expired", as_of: "2026-12-01" }))[field].length).toBeGreaterThan(0);
    }
  });
});
