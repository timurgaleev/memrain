/**
 * Deletion-reconcile — the sweep is mtime-incremental, so a note DELETED from
 * the vault used to leave its document + chunks stranded in the DB (false
 * evidence). `reindex --reconcile-deletes` closes that gap by soft-deleting the
 * documents under the swept vault root whose file is gone.
 *
 * These run offline: every seeded document's `last_indexed_mtime` is set far in
 * the future so the walk SKIPS all files (no `indexFile`, no Bedrock). We then
 * delete a file from disk and assert reconcile retires exactly that document —
 * and, critically, that it NEVER touches a doc outside the swept root or a doc
 * when reconcile is OFF.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { sweepVault } from "../src/core/sweep.ts";
import { reconcileDeletedDocuments } from "../src/core/reconcile-deletes.ts";
import { visibilityClause } from "../src/core/visibility.ts";

/** Same natural key the indexer/sweep derive — replicated so seeded rows line
 *  up with what the walk looks up, letting every file skip (mtime up to date). */
function docId(sourcePath: string): string {
  return `doc_${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}`;
}

const FUTURE_MTIME = 9_999_999_999_999; // >> any real file mtime → always skip

let tmp: string;
let storage: Storage;

/** Seed a document + one chunk keyed to `sourcePath`, pre-indexed (so the walk
 *  skips it) and live (visible). */
async function seedDoc(sourcePath: string, body: string): Promise<void> {
  const id = docId(sourcePath);
  await storage.raw().query(
    `INSERT INTO documents (id, source_path, title, frontmatter, last_indexed_mtime)
     VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
    [id, sourcePath, sourcePath, FUTURE_MTIME],
  );
  await storage.raw().query(
    `INSERT INTO chunks (id, document_id, chunk_index, content)
     VALUES ($1, $2, 0, $3)`,
    [`${id}_c0`, id, body],
  );
}

async function deletedAt(sourcePath: string): Promise<string | null> {
  const r = await storage.raw().query<{ deleted_at: string | null }>(
    `SELECT deleted_at FROM documents WHERE id = $1`,
    [docId(sourcePath)],
  );
  return r.rows[0]?.deleted_at ?? null;
}

/** Count chunks of `sourcePath` that would surface in search (visibility gate —
 *  the exact filter spliced into every ranking arm). */
async function visibleChunks(sourcePath: string): Promise<number> {
  const r = await storage.raw().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE d.id = $1 AND ${visibilityClause("d")}`,
    [docId(sourcePath)],
  );
  return r.rows[0]?.n ?? 0;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-reconcile-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("reindex deletion-reconcile", () => {
  it("soft-deletes a removed file's doc, keeps the survivors live + searchable", async () => {
    const a = join(tmp, "a.md");
    const b = join(tmp, "b.md");
    const c = join(tmp, "c.md");
    for (const [p, t] of [[a, "alpha"], [b, "bravo"], [c, "charlie"]] as const) {
      writeFileSync(p, `# ${t}`);
      await seedDoc(p, t);
    }

    // The vault loses c.md.
    rmSync(c);

    const res = await sweepVault(storage, { vault: tmp, reconcileDeletes: true });

    // Walk skipped all three (mtime up to date) — no re-index happened.
    expect(res.reindexed).toBe(0);
    // Exactly the removed doc was reconciled.
    expect(res.reconciled).toBe(1);
    expect(res.reconciledPaths).toEqual([c]);

    // c is soft-deleted and no longer surfaces; a & b stay live + searchable.
    expect(await deletedAt(c)).not.toBeNull();
    expect(await visibleChunks(c)).toBe(0);
    expect(await deletedAt(a)).toBeNull();
    expect(await deletedAt(b)).toBeNull();
    expect(await visibleChunks(a)).toBe(1);
    expect(await visibleChunks(b)).toBe(1);
  });

  it("reconcile OFF (default) leaves a removed file's doc untouched", async () => {
    const a = join(tmp, "a.md");
    const c = join(tmp, "c.md");
    writeFileSync(a, "# alpha");
    writeFileSync(c, "# charlie");
    await seedDoc(a, "alpha");
    await seedDoc(c, "charlie");

    rmSync(c);

    // No reconcileDeletes flag → the incremental sweep must NOT delete anything.
    const res = await sweepVault(storage, { vault: tmp });
    expect(res.reconciled).toBeUndefined();
    expect(await deletedAt(c)).toBeNull();
    expect(await visibleChunks(c)).toBe(1);
  });

  it("scopes to the swept root — a missing doc under ANOTHER root is never retired", async () => {
    // In-root file that still exists (must survive) …
    const inRoot = join(tmp, "keep.md");
    writeFileSync(inRoot, "# keep");
    await seedDoc(inRoot, "keep");

    // … and a doc from a DIFFERENT source root whose file is also gone. A
    // partial/other-root sweep must never read that as "delete me".
    const otherRoot = mkdtempSync(join(tmpdir(), "memrain-other-"));
    const otherDoc = join(otherRoot, "gone.md"); // never created on disk
    await seedDoc(otherDoc, "gone");

    try {
      const res = await sweepVault(storage, { vault: tmp, reconcileDeletes: true });
      // Nothing under `tmp` is missing → zero reconciled …
      expect(res.reconciled).toBe(0);
      // … and the missing out-of-root doc is untouched.
      expect(await deletedAt(otherDoc)).toBeNull();
      expect(await visibleChunks(otherDoc)).toBe(1);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("reconcile helper is separator-safe: /vaultX is not under /vault", async () => {
    // A sibling root sharing a name prefix must not be swept by a /vault run.
    const sibling = `${tmp}X`;
    mkdirSync(sibling, { recursive: true });
    const siblingDoc = join(sibling, "note.md"); // missing on disk
    await seedDoc(siblingDoc, "sibling");

    try {
      const rec = await reconcileDeletedDocuments(storage.raw(), tmp);
      expect(rec.reconciled).toBe(0);
      expect(await deletedAt(siblingDoc)).toBeNull();
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe("reconcile safety guards", () => {
  async function countDeleted(): Promise<number> {
    const r = await storage.raw().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM documents WHERE deleted_at IS NOT NULL`,
    );
    return r.rows[0]?.n ?? 0;
  }

  /** Seed `total` docs under `root` with their files on disk, then remove the
   *  first `missing` files. */
  async function seedVault(root: string, total: number, missing: number): Promise<void> {
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < total; i++) {
      const p = join(root, `n${i}.md`);
      writeFileSync(p, `# n${i}`);
      await seedDoc(p, `n${i}`);
    }
    for (let i = 0; i < missing; i++) rmSync(join(root, `n${i}.md`));
  }

  it("refuses when the root does not exist and deletes nothing", async () => {
    // An unmounted vault: every doc under it looks "missing on disk".
    const doc = join(tmp, "gone", "a.md");
    await seedDoc(doc, "a");
    await expect(
      reconcileDeletedDocuments(storage.raw(), join(tmp, "gone")),
    ).rejects.toMatchObject({ code: "root_missing" });
    expect(await deletedAt(doc)).toBeNull();
  });

  it("refuses 60 of 100 missing documents without the flag", async () => {
    const root = join(tmp, "vault");
    await seedVault(root, 100, 60);
    await expect(
      reconcileDeletedDocuments(storage.raw(), root),
    ).rejects.toMatchObject({
      code: "mass_delete_refused",
      message: expect.stringMatching(/^60 of 100 documents under .* are missing; pass --allow-mass-delete/),
    });
    expect(await countDeleted()).toBe(0);
    const r = await reconcileDeletedDocuments(storage.raw(), root, { allowMassDelete: true });
    expect(r.reconciled).toBe(60);
    expect(await countDeleted()).toBe(60);
  });

  it("retires 2 of 100 missing documents without the flag", async () => {
    const root = join(tmp, "vault");
    await seedVault(root, 100, 2);
    const r = await reconcileDeletedDocuments(storage.raw(), root);
    expect(r.reconciled).toBe(2);
  });

  it("refuses 49 of 50 missing documents in a small vault", async () => {
    const root = join(tmp, "vault");
    await seedVault(root, 50, 49);
    await expect(
      reconcileDeletedDocuments(storage.raw(), root),
    ).rejects.toMatchObject({
      code: "mass_delete_refused",
      message: expect.stringMatching(/^49 of 50 documents under .* are missing; pass --allow-mass-delete.*; e\.g\. .*n0\.md/),
    });
    expect(await countDeleted()).toBe(0);
  });

  it("retires the one missing document of two without the flag", async () => {
    const root = join(tmp, "vault");
    await seedVault(root, 2, 1);
    const r = await reconcileDeletedDocuments(storage.raw(), root);
    expect(r.reconciled).toBe(1);
  });

  it("sweepVault with a missing root reports an error instead of a clean empty walk", async () => {
    await seedDoc(join(tmp, "gone", "a.md"), "a");
    const r = await sweepVault(storage, { vault: join(tmp, "gone"), reconcileDeletes: true });
    expect(r.errors.map((e) => e.message)).toContainEqual(
      expect.stringMatching(/not a readable directory/),
    );
    expect(r.reconciled ?? 0).toBe(0);
    expect(await countDeleted()).toBe(0);
  });

  it("sweepVault skips reconcile when the walk found no files at all", async () => {
    const root = join(tmp, "vault");
    await seedVault(root, 3, 3);
    const r = await sweepVault(storage, { vault: root, reconcileDeletes: true });
    expect(r.scanned).toBe(0);
    expect(r.errors.map((e) => e.message)).toContainEqual(
      expect.stringMatching(/no files/),
    );
    expect(r.reconciled ?? 0).toBe(0);
    expect(await countDeleted()).toBe(0);
  });

  it("sweepVault passes allowMassDelete through to the reconcile", async () => {
    const root = join(tmp, "vault");
    await seedVault(root, 100, 60);
    await expect(
      sweepVault(storage, { vault: root, reconcileDeletes: true }),
    ).rejects.toMatchObject({ code: "mass_delete_refused" });
    const r = await sweepVault(storage, { vault: root, reconcileDeletes: true, allowMassDelete: true });
    expect(r.reconciled).toBe(60);
  });
});
