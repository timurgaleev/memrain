/**
 * The code sweep retires the documents of deleted files (core/code-prune.ts):
 * soft delete with a provenance row, never on a walk it cannot trust, never
 * past the valve, never outside code documents; a restore brings the document
 * back with its chunks, and a file that returns revives its document.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { sweepCodeRoots } from "../src/core/sweep-code.ts";
import { normalizeSourcePath } from "../src/core/indexer.ts";
import { registerSource } from "../src/core/sources.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { codeDefs } from "../src/core/code-graph.ts";
import { getChunksForSource } from "../src/core/chunks-read.ts";
import { restoreDocuments, softDeleteDocuments } from "../src/core/destructive-guard.ts";
import { codePruneAutoEnabled, restoreCodePrunes } from "../src/core/code-prune.ts";
import { runCodePrune } from "../src/commands/code-prune.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";

setDefaultTimeout(120000);

const tmp = mkdtempSync(join(tmpdir(), "memrain-code-prune-"));
let storage: Storage;

beforeAll(async () => {
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  _resetParsersForTests();
});

const fileOf = (dir: string, i: number) => join(dir, "src", `f${i}.ts`);
const body = (tag: string, i: number) => `// ${tag}word${i}\nexport function ${tag}Fn${i}(): number {\n  return ${i};\n}\n`;

/** A repo of `n` files `src/f<i>.ts`, each defining `<tag>Fn<i>` with a unique comment word. */
function makeRepo(tag: string, n: number): string {
  const dir = join(tmp, tag);
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(fileOf(dir, i), body(tag, i));
  return dir;
}

async function docOf(path: string): Promise<{ id: string; deleted_at: string | null } | undefined> {
  const r = await storage.engine().query<{ id: string; deleted_at: string | null }>(
    "SELECT id, deleted_at::text AS deleted_at FROM documents WHERE source_path = $1",
    [normalizeSourcePath(path)],
  );
  return r.rows[0];
}
/** Keyword search returns chunk ids (`<doc id>_c<n>`). */
const found = async (token: string, docId: string) =>
  (await keywordSearch(storage.engine(), token, 10)).some((c) => c.startsWith(`${docId}_`));
const chunkCount = async (id: string) => (await storage.engine().query<{ n: number }>(
  "SELECT count(*)::int AS n FROM chunks WHERE document_id = $1", [id])).rows[0]!.n;
const liveDocs = async (dir: string) => (await storage.engine().query<{ n: number }>(
  "SELECT count(*)::int AS n FROM documents WHERE deleted_at IS NULL AND left(source_path, length($1)) = $1",
  [`${normalizeSourcePath(dir)}/`])).rows[0]!.n;

describe("code sweep prune", () => {
  // Value: protects=a deleted file's symbols leave search, code_def and get_chunks, its rows stay, and the
  // sweep id restores it intact; fails_when=the sweep leaves the document live, hard-deletes it, or the restore
  // loses chunks.
  it("soft-deletes a deleted file's document with provenance, and restore brings it back intact", async () => {
    const dir = makeRepo("alpha", 6);
    await sweepCodeRoots(storage, { paths: [dir], prune: true });
    const doc = (await docOf(fileOf(dir, 0)))!;
    const chunks = await chunkCount(doc.id);
    expect(chunks).toBeGreaterThan(0);
    expect(await found("alphaword0", doc.id)).toBe(true);
    expect((await codeDefs(storage.engine(), "alphaFn0")).count).toBe(1);

    unlinkSync(fileOf(dir, 0));
    const r = await sweepCodeRoots(storage, { paths: [dir], prune: true });
    expect(r.prune?.pruned).toBe(1);
    const sweepId = r.prune!.sweep_id!;
    expect(sweepId).toMatch(/^cp-/);

    const gone = (await docOf(fileOf(dir, 0)))!;
    expect(gone.deleted_at).not.toBeNull();
    expect(await chunkCount(doc.id)).toBe(chunks);
    expect(await found("alphaword0", doc.id)).toBe(false);
    expect((await codeDefs(storage.engine(), "alphaFn0")).count).toBe(0);
    expect(await getChunksForSource(storage, normalizeSourcePath(fileOf(dir, 0)))).toEqual([]);
    // The other files are untouched.
    expect((await codeDefs(storage.engine(), "alphaFn1")).count).toBe(1);

    const prov = await storage.engine().query<{ trigger: string; reason: string; same: boolean; root: string }>(
      `SELECT p.trigger, p.reason, p.root, p.pruned_at = d.deleted_at AS same
         FROM code_prunes p JOIN documents d ON d.id = p.document_id WHERE p.sweep_id = $1`,
      [sweepId],
    );
    expect(prov.rows).toEqual([{ trigger: "sweep", reason: "file_missing", root: normalizeSourcePath(dir), same: true }]);

    const back = await restoreCodePrunes(storage.engine(), { sweepId }, "cli");
    expect(back).toEqual({ restored: [doc.id], purged: [], superseded: [] });
    expect((await docOf(fileOf(dir, 0)))!.deleted_at).toBeNull();
    expect(await chunkCount(doc.id)).toBe(chunks);
    expect((await codeDefs(storage.engine(), "alphaFn0")).count).toBe(1);
    expect(await found("alphaword0", doc.id)).toBe(true);

    // The operator restored it on purpose: the automatic pass leaves it alone.
    const again = await sweepCodeRoots(storage, { paths: [dir], prune: true });
    expect(again.prune?.pruned).toBe(0);
    expect(again.prune?.roots[0]?.held).toBe(1);
    expect((await docOf(fileOf(dir, 0)))!.deleted_at).toBeNull();
  });

  // Value: protects=an unmounted checkout never wipes the index; fails_when=a missing root reads as "every file deleted".
  it("deletes nothing when the root is missing", async () => {
    const dir = makeRepo("bravo", 4);
    await sweepCodeRoots(storage, { paths: [dir], prune: true });
    const moved = `${dir}-away`;
    renameSync(dir, moved);
    try {
      const r = await sweepCodeRoots(storage, { paths: [dir], prune: true });
      expect(r.prune?.roots[0]).toEqual({ root: normalizeSourcePath(dir), status: "withheld", reason: "root_missing" });
      expect(await liveDocs(dir)).toBe(4);
    } finally {
      renameSync(moved, dir);
    }
  });

  // Value: protects=an empty mount point never wipes the index; fails_when=a root that exists but shows no
  // files is pruned.
  it("deletes nothing when the walk sees no files", async () => {
    const dir = makeRepo("charlie", 4);
    await sweepCodeRoots(storage, { paths: [dir], prune: true });
    for (let i = 0; i < 4; i++) unlinkSync(fileOf(dir, i));
    const r = await sweepCodeRoots(storage, { paths: [dir], prune: true });
    expect(r.prune?.roots[0]?.reason).toBe("empty_walk");
    expect(await liveDocs(dir)).toBe(4);
  });

  // Value: protects=a partly unreadable checkout never wipes what it could not see; fails_when=a walk that
  // skipped an unreadable directory still prunes.
  it.skipIf(process.getuid?.() === 0)("deletes nothing when part of the walk was unreadable", async () => {
    const dir = makeRepo("delta", 6);
    mkdirSync(join(dir, "locked"));
    writeFileSync(join(dir, "locked", "x.ts"), "export function deltaLocked() {}\n");
    await sweepCodeRoots(storage, { paths: [dir], prune: true });
    unlinkSync(fileOf(dir, 0));
    chmodSync(join(dir, "locked"), 0o000);
    try {
      const r = await sweepCodeRoots(storage, { paths: [dir], prune: true });
      expect(r.prune?.roots[0]?.reason).toBe("walk_errors");
      expect(await liveDocs(dir)).toBe(7);
    } finally {
      chmodSync(join(dir, "locked"), 0o755);
    }
  });

  // Value: protects=the valve withholds a mass deletion and only the explicit CLI override passes it;
  // fails_when=the sweep retires 30% of a root, or the override does not work.
  it("withholds a pass over the valve; code prune --apply --allow-mass-delete retires it", async () => {
    const dir = makeRepo("echo", 10);
    await sweepCodeRoots(storage, { paths: [dir], prune: true });
    for (let i = 0; i < 3; i++) unlinkSync(fileOf(dir, i));
    const r = await sweepCodeRoots(storage, { paths: [dir], prune: true });
    expect(r.prune?.roots[0]).toMatchObject({ status: "withheld", reason: "mass_delete", live: 10, missing: 3 });
    expect(await liveDocs(dir)).toBe(10);

    await runCodePrune({ paths: dir, apply: true, storage });
    expect(await liveDocs(dir)).toBe(10);
    await runCodePrune({ paths: dir, apply: true, allowMassDelete: true, storage });
    expect(await liveDocs(dir)).toBe(7);
    const trig = await storage.engine().query<{ trigger: string }>(
      "SELECT DISTINCT trigger FROM code_prunes WHERE root = $1", [normalizeSourcePath(dir)]);
    expect(trig.rows).toEqual([{ trigger: "cli" }]);
  });

  // Value: protects=only code documents of the root's own code source are pruned; fails_when=a note, a page
  // mirror, or a row another source wrote under the root is soft-deleted.
  it("never touches non-code documents or rows another source owns", async () => {
    const dir = makeRepo("foxtrot", 8);
    const root = normalizeSourcePath(dir);
    await registerSource(storage.engine(), { id: "foxtrot-code", kind: "code", pathPrefix: `${root}/` });
    await registerSource(storage.engine(), { id: "foxtrot-notes", kind: "vault", pathPrefix: `${root}/notes/` });
    await registerSource(storage.engine(), { id: "foxtrot-other", kind: "code", pathPrefix: "/elsewhere/" });
    await sweepCodeRoots(storage, { paths: [dir], prune: true });
    await storage.engine().query(
      `INSERT INTO documents (id, source_id, source_path, title, frontmatter) VALUES
         ('fx_note', NULL, $1, 'n', '{}'::jsonb),
         ('fx_vault_code', 'foxtrot-notes', $2, 'v', '{"kind":"code"}'::jsonb),
         ('fx_foreign', 'foxtrot-other', $3, 'o', '{"kind":"code"}'::jsonb),
         ('fx_page', NULL, 'page://foxtrot/x', 'p', '{"kind":"code"}'::jsonb)`,
      [`${root}/src/gone.md`, `${root}/notes/gone.ts`, `${root}/src/foreign.ts`],
    );
    unlinkSync(fileOf(dir, 0));
    const r = await sweepCodeRoots(storage, { paths: [dir], prune: true });
    expect(r.prune?.pruned).toBe(1);
    const left = await storage.engine().query<{ id: string }>(
      "SELECT id FROM documents WHERE id LIKE 'fx_%' AND deleted_at IS NULL ORDER BY id");
    expect(left.rows.map((x) => x.id)).toEqual(["fx_foreign", "fx_note", "fx_page", "fx_vault_code"]);
  });

  // Value: protects=a deleted file that comes back is searchable again; fails_when=the indexer's no-revive rule
  // leaves the returned file's document deleted.
  it("revives a pruned document when its file comes back", async () => {
    const dir = makeRepo("golf", 6);
    await sweepCodeRoots(storage, { paths: [dir], prune: true });
    unlinkSync(fileOf(dir, 1));
    expect((await sweepCodeRoots(storage, { paths: [dir], prune: true })).prune?.pruned).toBe(1);
    writeFileSync(fileOf(dir, 1), body("golf", 1));
    const r = await sweepCodeRoots(storage, { paths: [dir], prune: true });
    expect(r.restored).toBe(1);
    expect((await docOf(fileOf(dir, 1)))!.deleted_at).toBeNull();
    expect((await codeDefs(storage.engine(), "golfFn1")).count).toBe(1);
    const by = await storage.engine().query<{ restored_by: string }>(
      "SELECT restored_by FROM code_prunes WHERE source_path = $1", [normalizeSourcePath(fileOf(dir, 1))]);
    expect(by.rows).toEqual([{ restored_by: "file_returned" }]);
  });

  // Value: protects=a file restored with an old mtime and new content is re-read, not served from its old
  // chunks; fails_when=the revived document is left to the mtime skip.
  it("re-indexes a returned file even when its mtime is older than the index", async () => {
    const dir = makeRepo("juliet", 6);
    await sweepCodeRoots(storage, { paths: [dir], prune: true });
    unlinkSync(fileOf(dir, 3));
    expect((await sweepCodeRoots(storage, { paths: [dir], prune: true })).prune?.pruned).toBe(1);
    writeFileSync(fileOf(dir, 3), "export function julietReturned(): number {\n  return 3;\n}\n");
    const old = new Date("2001-01-01T00:00:00Z");
    utimesSync(fileOf(dir, 3), old, old);
    const r = await sweepCodeRoots(storage, { paths: [dir], prune: true });
    expect(r.restored).toBe(1);
    expect((await codeDefs(storage.engine(), "julietReturned")).count).toBe(1);
    expect((await codeDefs(storage.engine(), "julietFn3")).count).toBe(0);
  });

  // Value: protects=restore never resurrects a document deleted later by another path; fails_when=the restore
  // keys on the document id alone.
  it("does not restore a document deleted again by something else", async () => {
    const dir = makeRepo("hotel", 6);
    await sweepCodeRoots(storage, { paths: [dir], prune: true });
    unlinkSync(fileOf(dir, 2));
    const sweepId = (await sweepCodeRoots(storage, { paths: [dir], prune: true })).prune!.sweep_id!;
    const id = (await docOf(fileOf(dir, 2)))!.id;
    await restoreDocuments(storage.engine(), { documentId: id });
    await softDeleteDocuments(storage.engine(), { documentId: id });
    const r = await restoreCodePrunes(storage.engine(), { sweepId }, "cli");
    expect(r).toEqual({ restored: [], purged: [], superseded: [id] });
    expect((await docOf(fileOf(dir, 2)))!.deleted_at).not.toBeNull();
  });

  // Value: protects=MEMRAIN_CODE_PRUNE=0 turns the automatic pass off; fails_when=the switch is ignored.
  it("leaves deleted files alone when pruning is off", async () => {
    expect(codePruneAutoEnabled({ MEMRAIN_CODE_PRUNE: "0" })).toBe(false);
    expect(codePruneAutoEnabled({})).toBe(true);
    const dir = makeRepo("india", 6);
    await sweepCodeRoots(storage, { paths: [dir], prune: false });
    unlinkSync(fileOf(dir, 0));
    const r = await sweepCodeRoots(storage, { paths: [dir], prune: false });
    expect(r.prune).toBeUndefined();
    expect(await liveDocs(dir)).toBe(6);
  });
});
