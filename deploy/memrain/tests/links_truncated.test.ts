import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`bounded links ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => {
    db = await engine.open();
    for (const slug of ["people/target", "notes/one", "notes/two", "life/diary/private"]) await putPage(db.storage, { slug, type: "note" });
    for (const slug of ["notes/one", "notes/two", "life/diary/private"]) await addLink(db.storage, { source_slug: slug, target_slug: "people/target", type: "mentions" });
    await db.storage.engine().query(`UPDATE links SET written_at = '2026-01-01'`);
  });
  afterAll(async () => { await db.close(); });
  async function call(name: string, limit: number, remote = false) {
    const args = name === "get_links" ? { slug: "people/target", limit } : { name: "people/target", limit };
    const r = await dispatchTool(db.storage, { name, arguments: args }, remote ? { isPublic: true } : { isPublic: false });
    return JSON.parse(r.content.find(c => c.type === "text")!.text!);
  }
  it("uses a stable edge-id tie break and detects the extra visible row", async () => {
    const first = await call("get_links", 1);
    expect(first.truncated).toBe(true);
    expect(first.groups[0].links.map((l: { source_slug: string }) => l.source_slug)).toEqual(["life/diary/private"]);
    expect((await call("get_links", 3)).truncated).toBe(false);
    expect((await call("backlinks", 1)).truncated).toBe(true);
    expect((await call("backlinks", 3)).truncated).toBe(false);
  });
  it("filters diary edges before the limit and does not count them as overflow", async () => {
    for (const name of ["get_links", "backlinks"]) {
      const result = await call(name, 2, true);
      expect(result.truncated).toBe(false);
      expect(JSON.stringify(result)).not.toContain("life/diary");
      if (name === "get_links") expect(result.groups[0].links).toHaveLength(2);
      else expect(result.hits).toHaveLength(2);
      expect((await call(name, 1, true)).truncated).toBe(true);
    }
  });
});
