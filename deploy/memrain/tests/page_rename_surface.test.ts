import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { getPage, pageVersions, putPage, renamePage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { addFact } from "../src/core/facts.ts";
import { addTag, getTags } from "../src/core/tags.ts";
import { putRawData, getRawData } from "../src/core/raw-data.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import { isPublicMcpToolForbidden } from "../src/http/public_guard.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`page rename surface (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const authInfo = { token: "test", clientId: "rename-client", scopes: ["read", "write"], sourceId: "rename-own", isPublic: false };
  beforeEach(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "rename-own", kind: "vault", pathPrefix: "/rename-own" });
    await registerSource(db.storage.engine(), { id: "rename-other", kind: "vault", pathPrefix: "/rename-other" });
    await putPage(db.storage, { slug: "notes/old", markdown_body: "Keep all content", source_id: "rename-own" });
  });
  afterEach(async () => { await db.close(); });
  const rename = async (args: Record<string, unknown> = {}, opts: DispatchOptions = { authInfo }) => {
    const result = await dispatchTool(db.storage, { name: "page_rename", arguments: { from: "notes/old", to: "notes/new", expected_version: 1, ...args } }, opts);
    return { ...JSON.parse(result.content[0]!.text), isError: result.isError };
  };

  it("carries data and history, redirects old reads and removes only the owned mirrors", async () => {
    const e = db.storage.engine();
    await addFact(db.storage, { entity_slug: "notes/old", fact: "Preserved fact", source_id: "rename-own" });
    await addTag(db.storage, "notes/old", "keep");
    await putRawData(db.storage, "notes/old", "manual", { keep: true });
    await e.query("INSERT INTO timeline_events (slug, occurred_at, event, source_id) VALUES ('notes/old', NOW(), 'Preserved event', 'rename-own')");
    await e.query(`INSERT INTO documents (id, source_path, source_id) VALUES
      ('rename-body', 'page://rename-own/notes/old', 'rename-own'),
      ('rename-truth', 'page-truth://rename-own/notes/old', 'rename-own'),
      ('rename-foreign', 'page://notes/old', 'rename-other')`);
    const result = await rename();
    expect(result).toMatchObject({ ok: true, renamed: true });
    expect(result.isError).toBeFalsy();
    const page = await getPage(db.storage, "notes/old", ["rename-own"]);
    expect(page).toMatchObject({ slug: "notes/new", markdown_body: "Keep all content" });
    expect((await pageVersions(db.storage, "notes/new"))[1]?.body_snapshot).toBe("Keep all content");
    expect((await e.query<{ written_by_principal: string }>("SELECT written_by_principal FROM page_versions WHERE slug = 'notes/new' ORDER BY version_n DESC LIMIT 1")).rows[0]?.written_by_principal).toBe("client:rename-client");
    expect((await e.query("SELECT entity_slug, fact FROM entity_facts")).rows).toEqual([{ entity_slug: "notes/new", fact: "Preserved fact" }]);
    expect((await e.query("SELECT slug, event FROM timeline_events")).rows).toEqual([{ slug: "notes/new", event: "Preserved event" }]);
    expect(await getTags(db.storage, "notes/new")).toContain("keep");
    expect((await getRawData(db.storage, "notes/new"))[0]?.data).toEqual({ keep: true });
    expect((await e.query("SELECT id FROM documents")).rows).toEqual([{ id: "rename-foreign" }]);
  });

  it("preserves distinct manual and derived inbound edges when moving their target", async () => {
    await putPage(db.storage, { slug: "notes/ref", markdown_body: "Ref", source_id: "rename-own" });
    await db.storage.engine().query(`INSERT INTO links (source_slug, target_slug, type, source_id, link_source) VALUES
      ('notes/ref', 'notes/old', 'mentions', 'rename-own', 'manual'),
      ('notes/ref', 'notes/new', 'mentions', 'rename-own', 'markdown')`);
    expect((await renamePage(db.storage, "notes/old", "notes/new")).renamed).toBe(true);
    expect((await db.storage.engine().query("SELECT target_slug, link_source FROM links ORDER BY link_source")).rows).toEqual([
      { target_slug: "notes/new", link_source: "manual" }, { target_slug: "notes/new", link_source: "markdown" },
    ]);
  });

  it("refuses a stale version without moving any rows", async () => {
    await putPage(db.storage, { slug: "notes/old", markdown_body: "A newer body", source_id: "rename-own" });
    const result = await rename();
    expect(result).toMatchObject({ isError: true, error: "version_conflict", current_version: 2 });
    expect((await getPage(db.storage, "notes/old"))?.markdown_body).toBe("A newer body");
    expect(await getPage(db.storage, "notes/new")).toBeNull();
    expect((await pageVersions(db.storage, "notes/old"))).toHaveLength(2);
    expect((await db.storage.engine().query("SELECT * FROM slug_aliases")).rows).toEqual([]);
  });

  it("refuses importer sources and importer history even after a manual edit", async () => {
    await db.storage.engine().query("UPDATE sources SET kind = 'github' WHERE id = 'rename-own'");
    expect(await rename()).toMatchObject({ isError: true, error: "importer_managed" });
    await db.storage.engine().query("UPDATE sources SET kind = 'vault' WHERE id = 'rename-own'");
    await db.storage.engine().query("UPDATE page_versions SET written_by = 'transcripts-ingest' WHERE slug = 'notes/old'");
    await putPage(db.storage, { slug: "notes/old", markdown_body: "Edited by hand", source_id: "rename-own", written_by: "operator" });
    expect(await rename({ expected_version: 2 })).toMatchObject({ isError: true, error: "importer_managed" });
    expect((await getPage(db.storage, "notes/old"))?.slug).toBe("notes/old");
    expect(await getPage(db.storage, "notes/new")).toBeNull();
  });

  it("requires version, owns the source and fences both slug arguments", async () => {
    expect(await rename({ expected_version: undefined })).toMatchObject({ isError: true, error: "invalid_params" });
    for (const args of [{ to: "outside/new" }, { from: "outside/old" }]) {
      expect((await rename(args, { authInfo: { ...authInfo, boundSlugPrefixes: ["notes/"] } })).isError).toBe(true);
    }
    const foreign = await rename({}, { authInfo: { ...authInfo, sourceId: "rename-other" } });
    expect(foreign).toMatchObject({ renamed: false });
    expect(JSON.stringify(foreign)).not.toContain("Keep all content");
    expect((await getPage(db.storage, "notes/old"))?.slug).toBe("notes/old");
    expect(isPublicMcpToolForbidden("page_rename")).toBe(true);
  });

  it("cannot turn a hidden diary into a readable note or create a malformed slug", async () => {
    await putPage(db.storage, { slug: "life/diary/entry", type: "note", markdown_body: "Private", source_id: "rename-own" });
    expect((await rename({ from: "life/diary/entry" })).isError).toBe(true);
    await db.storage.engine().query("UPDATE pages SET type = ' journal ' WHERE slug = 'notes/old'");
    expect((await rename()).isError).toBe(true);
    await db.storage.engine().query("UPDATE pages SET type = 'note' WHERE slug = 'notes/old'");
    expect(await rename({ to: "notes/bad--name" })).toMatchObject({ isError: true, error: "invalid_params" });
    expect((await getPage(db.storage, "notes/old"))?.slug).toBe("notes/old");
  });
});
