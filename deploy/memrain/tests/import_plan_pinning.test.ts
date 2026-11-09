import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storageEngines } from "./helpers/storage-engines.ts";
import { runImport } from "../src/commands/import.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`import plan pinning (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  let root: string;
  beforeAll(async () => { db = await open(); root = mkdtempSync(join(tmpdir(), "pinned-import-")); });
  afterAll(async () => { await db.close(); rmSync(root, { recursive: true, force: true }); });
  function fixture(id: string, body = "Preserved export") {
    const dir = join(root, id); mkdirSync(join(dir, "notes"), { recursive: true });
    writeFileSync(join(dir, `notes/${id}.md`), `---\ntitle: Export\ntype: note\n---\n\n${body}\n`);
    return dir;
  }
  const run = (dir: string, apply = false, planHash?: string) =>
    runImport({ dir, source: "default", apply, planHash, storage: db.storage });
  async function preview(dir: string) {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try { expect(await run(dir)).toBe(0); return JSON.parse(String(log.mock.calls.at(-1)![0])); }
    finally { log.mockRestore(); }
  }
  const rows = () => db.storage.engine().query("SELECT * FROM pages ORDER BY slug");

  it("requires a reviewed plan before writing any imported page", async () => {
    const dir = fixture("nohash");
    const before = (await rows()).rows;
    await expect(run(dir, true)).rejects.toThrow("plan hash");
    expect((await rows()).rows).toEqual(before);
  });
  it("refuses changed bytes before the first page create", async () => {
    const dir = fixture("changed");
    const plan = await preview(dir);
    fixture("changed", "Changed since preview");
    const before = (await rows()).rows;
    await expect(run(dir, true, plan.plan_hash)).rejects.toThrow("stale");
    expect((await rows()).rows).toEqual(before);
  });
  it("pins file bytes even when frontmatter normalizes to the same values", async () => {
    const dir = fixture("format");
    const plan = await preview(dir);
    writeFileSync(join(dir, "notes/format.md"), '---\ntitle: "Export"\ntype: "note"\n---\n\nPreserved export\n');
    await expect(run(dir, true, plan.plan_hash)).rejects.toThrow("stale");
  });
  it("creates exactly the reviewed normalized manifest and reports exact slugs", async () => {
    const dir = fixture("valid");
    const plan = await preview(dir);
    expect(plan.plan_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.manifest).toEqual([{ slug: "notes/valid", title: "Export", type: "note", body_hash: expect.any(String), file_hash: expect.any(String) }]);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await run(dir, true, plan.plan_hash)).toBe(0);
      expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ created: 1, created_slugs: ["notes/valid"], plan_hash: plan.plan_hash });
    } finally { log.mockRestore(); }
    expect((await db.storage.engine().query("SELECT markdown_body FROM pages WHERE slug='notes/valid'")).rows).toEqual([{ markdown_body: "Preserved export" }]);
  });

  it("rolls back an import when its required secret audit fails and reports exact creates", async () => {
    const dir = fixture("auditfail", "Credential: " + "ghp_" + "Ab12".repeat(10));
    const plan = await preview(dir);
    const before = (await rows()).rows;
    const versions = (await db.storage.engine().query("SELECT * FROM page_versions ORDER BY slug,version_n")).rows;
    await db.storage.engine().exec("ALTER TABLE ingest_log ADD CONSTRAINT reject_import_audit CHECK (NOT (source_type='secret-redacted' AND source_ref='notes/auditfail'))");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(run(dir, true, plan.plan_hash)).rejects.toThrow("reject_import_audit");
      expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ ok: false, created: 0, created_slugs: [], error: "import_stopped" });
      expect((await rows()).rows).toEqual(before);
      expect((await db.storage.engine().query("SELECT * FROM page_versions ORDER BY slug,version_n")).rows).toEqual(versions);
    } finally {
      log.mockRestore();
      await db.storage.engine().exec("ALTER TABLE ingest_log DROP CONSTRAINT reject_import_audit");
    }
    expect(await run(dir, true, plan.plan_hash)).toBe(0);
    expect((await db.storage.engine().query("SELECT source_type FROM ingest_log WHERE source_ref='notes/auditfail'")).rows)
      .toEqual([{ source_type: "secret-redacted" }]);
  });
});
