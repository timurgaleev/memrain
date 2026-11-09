import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { runImport } from "../src/commands/import.ts";
import { runExport } from "../src/commands/export.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`import pages (${engine.name})`, () => {
  let opened: Awaited<ReturnType<typeof engine.open>>;
  let dir: string;
  beforeAll(async () => { opened = await engine.open(); dir = mkdtempSync(join(tmpdir(), "import-pages-")); });
  afterAll(async () => { await opened?.close(); rmSync(dir, { recursive: true, force: true }); });
  const file = (folder: string, slug: string, body = "Restored body") => {
    const root = join(dir, folder); mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, `${slug}.md`), `---\ntitle: "A: \\"quoted\\" title"\ntype: note\n---\n\n${body}\n`);
    return root;
  };
  it("refuses the entire batch when any live or deleted slug already exists", async () => {
    const s = opened.storage;
    for (const slug of ["notes/live", "notes/deleted"]) await putPage(s, { slug, markdown_body: "Keep this" });
    await s.engine().query("UPDATE pages SET deleted_at = NOW() WHERE slug = 'notes/deleted'");
    const root = file("conflict", "notes/live"); file("conflict", "notes/deleted"); file("conflict", "notes/new");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runImport({ dir: root, source: "default", storage: s })).toBe(1);
      const planHash = JSON.parse(String(log.mock.calls.at(-1)![0])).plan_hash;
      expect(await runImport({ dir: root, source: "default", apply: true, planHash, storage: s })).toBe(1);
      expect((await s.engine().query("SELECT slug FROM pages WHERE slug = 'notes/new'")).rows).toHaveLength(0);
      expect((await s.engine().query<{ markdown_body: string }>("SELECT markdown_body FROM pages WHERE slug = 'notes/deleted'")).rows[0]?.markdown_body).toBe("Keep this");
    } finally { log.mockRestore(); }
  });
  it("round-trips exported punctuation, literal scalars and body whitespace into a new source", async () => {
    const s = opened.storage;
    await s.engine().query("INSERT INTO sources (id, kind, path_prefix) VALUES ('copy', 'other', 'tenant:copy')");
    for (const [slug, title] of [["notes/multiline", "Line one\nLine two"], ["notes/quoted", 'A: "quoted" title'], ["notes/literal", "true"]]) await putPage(s, { slug: slug!, title, markdown_body: "\nBody\n\n" });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const root = join(dir, "roundtrip"); await runExport({ dir: root, storage: s });
      // Restrict the fixture to the two new pages; exports retain the slugs.
      rmSync(join(root, "notes/live.md"));
      await s.engine().query("DELETE FROM pages WHERE slug IN ('notes/quoted', 'notes/literal', 'notes/multiline')");
      expect(await runImport({ dir: root, source: "copy", storage: s })).toBe(0);
      const planHash = JSON.parse(String(log.mock.calls.at(-1)![0])).plan_hash;
      expect(await runImport({ dir: root, source: "copy", apply: true, planHash, storage: s })).toBe(0);
      const rows = (await s.engine().query("SELECT title, markdown_body, source_id FROM pages WHERE source_id = 'copy' ORDER BY slug")).rows;
      expect(rows).toEqual([{ title: "true", markdown_body: "\nBody\n\n", source_id: "copy" }, { title: "Line one\nLine two", markdown_body: "\nBody\n\n", source_id: "copy" }, { title: 'A: "quoted" title', markdown_body: "\nBody\n\n", source_id: "copy" }]);
    } finally { log.mockRestore(); }
  });
  it("refuses symlinks before any page write", async () => {
    const root = file("symlink", "notes/safe");
    symlinkSync(join(root, "notes/safe.md"), join(root, "notes/link.md"));
    await expect(runImport({ dir: root, source: "default", apply: true, storage: opened.storage })).rejects.toThrow("symbolic links");
    expect((await opened.storage.engine().query("SELECT slug FROM pages WHERE slug = 'notes/safe'")).rows).toHaveLength(0);
  });
  it("expected version zero refuses a preexisting row even without a version chain", async () => {
    const s = opened.storage;
    await putPage(s, { slug: "notes/legacy", markdown_body: "Keep legacy" });
    await s.engine().query("DELETE FROM page_versions WHERE slug = 'notes/legacy'");
    await expect(putPage(s, { slug: "notes/legacy", markdown_body: "Replace", expectedVersion: 0 })).rejects.toThrow();
    expect((await s.engine().query<{ markdown_body: string }>("SELECT markdown_body FROM pages WHERE slug = 'notes/legacy'")).rows[0]?.markdown_body).toBe("Keep legacy");
  });
});
