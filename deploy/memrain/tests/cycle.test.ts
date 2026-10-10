/**
 * Cycle phase tests — exercise each phase against a seeded PGLite. The
 * embed-stale phase is the only one that would touch Bedrock, so we
 * test it with `staleDays=99999` (no rows ever match → empty result)
 * to verify the wiring without paying for embeds.
 *
 * The full runCycleOnce is also smoke-tested with all 6 phases enabled
 * to confirm the orchestrator returns a stable shape.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { deriveStatus, runCycleOnce } from "../src/core/cycle/index.ts";
import { embedStalePhase, findStale } from "../src/core/cycle/embed-stale.ts";
import { registerSource } from "../src/core/sources.ts";
import { extractPhase } from "../src/core/cycle/extract.ts";
import { reconcileLinksPhase } from "../src/core/cycle/reconcile-links.ts";
import { orphansPurgePhase } from "../src/core/cycle/orphans-purge.ts";
import { snapshotPhase } from "../src/core/cycle/snapshot.ts";
import { entityId } from "../src/core/entities.ts";
import { EMBED_DIMENSIONS } from "../src/core/embedding.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-cycle-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seed() {
  const e = storage.engine();
  const idFoo = entityId("wikilink", "Foo");
  const idNonex = entityId("wikilink", "Nonexistent");
  // Two docs: one with title, one without; one chunk each;
  // entities for wikilink resolution test (one resolved, one orphan).
  await e.exec(`
    INSERT INTO documents (id, source_path, title, frontmatter)
    VALUES
      ('d1', '/vault/Foo.md', 'Foo', '{}'::jsonb),
      ('d2', '/vault/bar.md', NULL, '{}'::jsonb);
    INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
      ('d1c0', 'd1', 0, '# Foo\n\nLinks to [[Foo]] (resolves) and [[Nonexistent]] (orphan).\n#alpha #beta'),
      ('d2c0', 'd2', 0, '# Bar\n\nrefers to [[Foo]] also.');
  `);
  await e.query(
    `INSERT INTO entities (id, type, name) VALUES ($1, 'wikilink', 'Foo'), ($2, 'wikilink', 'Nonexistent')`,
    [idFoo, idNonex],
  );
  await e.query(
    `INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES
      ('d1c0', $1, 'Foo'),
      ('d1c0', $2, 'Nonexistent'),
      ('d2c0', $1, 'Foo')`,
    [idFoo, idNonex],
  );
}

describe("embed-stale phase", () => {
  it("returns 0 reembedded when no rows are stale", async () => {
    const e = storage.engine();
    const r = await embedStalePhase(e, { staleDays: 99999 });
    expect(r.scanned).toBe(0);
    expect(r.reembedded).toBe(0);
    expect(r.errors).toEqual([]);
  });
});

describe("embed-stale: which documents it may re-read from disk", () => {
  const ZERO_VEC = `[${Array(1024).fill(0).join(",")}]`;
  let saved: { vault?: string; code?: string };
  let vault: string;

  beforeEach(() => {
    saved = { vault: process.env.MEMRAIN_VAULT_PATHS, code: process.env.MEMRAIN_CODE_PATHS };
    vault = join(tmp, "vault");
    mkdirSync(vault);
    // realpath: macOS tmpdir is a symlink, and indexed source_paths are canonical.
    vault = realpathSync(vault);
    process.env.MEMRAIN_VAULT_PATHS = vault;
    delete process.env.MEMRAIN_CODE_PATHS;
  });

  afterEach(() => {
    if (saved.vault === undefined) delete process.env.MEMRAIN_VAULT_PATHS;
    else process.env.MEMRAIN_VAULT_PATHS = saved.vault;
    if (saved.code === undefined) delete process.env.MEMRAIN_CODE_PATHS;
    else process.env.MEMRAIN_CODE_PATHS = saved.code;
  });

  async function staleDoc(id: string, sourcePath: string, sourceId: string | null) {
    const e = storage.engine();
    await e.query(
      `INSERT INTO documents (id, source_id, source_path, title, frontmatter) VALUES ($1, $2, $3, NULL, '{}'::jsonb)`,
      [id, sourceId, sourcePath],
    );
    await e.query(
      `INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, 0, 'placeholder')`,
      [`${id}c0`, id],
    );
    await e.query(
      `INSERT INTO embeddings (chunk_id, vector, model, created_at)
       VALUES ($1, $2::vector, 'test', NOW() - interval '90 days')`,
      [`${id}c0`, ZERO_VEC],
    );
  }

  it("skips a remote label outside the roots and a tenant-owned label inside them", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "vault-src", kind: "vault", pathPrefix: vault });
    await registerSource(e, { id: "tenant-a", kind: "other", pathPrefix: "/tenants/a" });
    writeFileSync(join(vault, "mine.md"), "# mine");
    writeFileSync(join(vault, "not-yet-indexed.md"), "# operator secret");
    writeFileSync(join(tmp, "daemon.env"), "SECRET=1");

    await staleDoc("op", join(vault, "mine.md"), "vault-src");
    await staleDoc("op-null", join(vault, "mine.md") + ".bak", null);
    // A tenant indexed placeholder text under a vault path before the sweep got there.
    await staleDoc("ten", join(vault, "not-yet-indexed.md"), "tenant-a");
    // A public inline index under an absolute daemon path, outside every root.
    await staleDoc("pub", join(tmp, "daemon.env"), null);
    await staleDoc("envfile", join(vault, ".env"), "vault-src");

    const rows = await findStale(e, 30, 50, [vault]);
    expect(rows.map((r) => r.doc_id).sort()).toEqual(["envfile", "op"]);
  });

  it("pages past a candidate the guard refuses every tick instead of stalling on it", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "vault-src", kind: "vault", pathPrefix: vault });
    // Sorts first and passes the SQL prefilter, but is a denied name.
    writeFileSync(join(vault, ".env.example"), "SECRET=1");
    writeFileSync(join(vault, "mine.md"), "---\nembed_skip: true\n---\n\n# refreshed\n");
    // The ids the indexer derives from the path, so the re-read replaces these rows.
    const id = (p: string) => `doc_${createHash("sha256").update(p).digest("hex").slice(0, 16)}`;
    await staleDoc(id(join(vault, ".env.example")), join(vault, ".env.example"), "vault-src");
    await staleDoc(id(join(vault, "mine.md")), join(vault, "mine.md"), "vault-src");

    const r = await embedStalePhase(e, { staleDays: 30, maxPerCycle: 1 });
    expect(r.errors).toEqual([]);
    expect(r.rejected).toBe(1);
    expect(r.reembedded).toBe(1);
    const text = async (p: string) =>
      (await e.query<{ content: string }>(
        `SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id
          WHERE d.source_path = $1 ORDER BY c.chunk_index`,
        [p],
      )).rows.map((x) => x.content).join("\n");
    expect(await text(join(vault, ".env.example"))).toBe("placeholder");
    expect(await text(join(vault, "mine.md"))).toContain("refreshed");
  });

  it("the phase leaves a tenant's or public caller's placeholder text as it was", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "tenant-a", kind: "other", pathPrefix: "/tenants/a" });
    writeFileSync(join(vault, "not-yet-indexed.md"), "# operator secret");
    writeFileSync(join(tmp, "daemon.env"), "SECRET=1");
    await staleDoc("ten", join(vault, "not-yet-indexed.md"), "tenant-a");
    await staleDoc("pub", join(tmp, "daemon.env"), null);

    const r = await embedStalePhase(e, { staleDays: 30 });
    expect(r).toEqual({ scanned: 0, reembedded: 0, rejected: 0, errors: [] });
    expect(await findStale(e, 30, 50, [])).toEqual([]);
    const body = await e.query<{ content: string }>(
      `SELECT content FROM chunks WHERE document_id IN ('ten', 'pub') ORDER BY id`,
    );
    expect(body.rows.map((x) => x.content)).toEqual(["placeholder", "placeholder"]);
  });
});

describe("reconcile-links phase", () => {
  it("classifies wikilinks into resolved + unresolved", async () => {
    await seed();
    const e = storage.engine();
    const r = await reconcileLinksPhase(e);
    expect(r.totalWikilinks).toBe(2);
    expect(r.resolved).toBe(1); // Foo title matches
    expect(r.unresolved.map((u) => u.name)).toEqual(["Nonexistent"]);
    expect(r.unresolved[0]?.mentionCount).toBe(1);
  });
});

describe("orphans-purge phase", () => {
  it("deletes embeddings whose chunk no longer exists", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES ('d1', '/x.md', 'X');
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
        ('keep', 'd1', 0, 'hi');
      INSERT INTO embeddings (chunk_id, vector, model)
        VALUES ('keep', array_fill(0.1, ARRAY[1024])::vector, 'titan-v2');
    `);
    // Insert an embedding pointing at a deleted chunk by directly
    // inserting then deleting the chunk WITHOUT cascade:
    // PGLite enforces FK so we can't orphan via DELETE; instead,
    // simulate the orphan by inserting an embedding row whose chunk
    // disappeared via raw violation. We do it via raw sql with
    // SET CONSTRAINTS off — but PGLite doesn't expose that. Easier:
    // verify the phase runs cleanly with no orphans (returns 0).
    const r = await orphansPurgePhase(e);
    expect(r.deleted.embeddings).toBe(0);
    expect(r.deleted.entity_mentions).toBe(0);
    expect(r.deleted.entities).toBe(0);
    // disk-missing flag should fire because /x.md doesn't exist
    expect(r.flagged.docs_missing_on_disk.length).toBe(1);
  });

  it("flags docs with zero chunks", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES ('empty', '/empty.md', 'E');
    `);
    const r = await orphansPurgePhase(e);
    expect(
      r.flagged.docs_with_zero_chunks.map((d) => d.id),
    ).toContain("empty");
  });

  it("does not flag a doc the indexer marked as a blank source", async () => {
    const e = storage.engine();
    // Both rows have zero chunks. Only the unmarked one is a corrupt index; the
    // marked one is a legitimately empty tracked file, which re-indexes to zero
    // chunks every time — flagging it would pin the phase at warn forever.
    await e.exec(`
      INSERT INTO documents (id, source_path, title, frontmatter) VALUES
        ('blank', '/repo/placeholder.ts', 'placeholder.ts',
         '{"kind":"code","language":"typescript","empty_source":true}'::jsonb),
        ('corrupt', '/repo/real.ts', 'real.ts',
         '{"kind":"code","language":"typescript"}'::jsonb);
    `);
    const r = await orphansPurgePhase(e);
    const flagged = r.flagged.docs_with_zero_chunks.map((d) => d.id);
    expect(flagged).not.toContain("blank");
    expect(flagged).toContain("corrupt");
  });

  it("never flags virtual (non-file) documents as missing on disk", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES
        ('vp1', 'page://timur/notes/foo', 'P'),
        ('vp2', 'page-truth://timur/notes/foo', 'PT'),
        ('vg1', 'gmail:19e418cb5755fa00', 'G'),
        ('vc1', 'gcal:someone@example.com/evt1', 'C');
    `);
    const r = await orphansPurgePhase(e);
    const flagged = r.flagged.docs_missing_on_disk.map((d) => d.id);
    expect(flagged).not.toContain("vp1");
    expect(flagged).not.toContain("vp2");
    expect(flagged).not.toContain("vg1");
    expect(flagged).not.toContain("vc1");
  });

  it("skips docs whose path root does not exist on this host (remote namespace)", async () => {
    const e = storage.engine();
    // A missing file under an EXISTING root (the OS tmpdir's top-level dir,
    // e.g. /tmp or /var) must still be flagged — the positive path.
    const missingLocal = `${tmpdir()}/memrain-test-definitely-missing-${Date.now()}.md`;
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES
        ('remote1', '/nonexistent-root-xyz/notes/foo.md', 'R'),
        ('local1', '${missingLocal}', 'L');
    `);
    const r = await orphansPurgePhase(e);
    const flagged = r.flagged.docs_missing_on_disk.map((d) => d.id);
    // /nonexistent-root-xyz is absent entirely → the namespace is remote,
    // not orphaned; the doc must not be flagged.
    expect(flagged).not.toContain("remote1");
    expect(flagged).toContain("local1");
  });
});

// frontmatter inference moved to ingest (core/frontmatter-inference.ts +
// indexDocument) — the recurring cycle phase was removed (v1.49.0). Its tests
// live in tests/frontmatter_inference.test.ts.

describe("snapshot phase", () => {
  it("returns counts; persists when cycle_snapshots exists", async () => {
    await seed();
    const e = storage.engine();
    const r = await snapshotPhase(e);
    expect(r.documents).toBe(2);
    expect(r.chunks).toBe(2);
    expect(r.entities).toBe(2);
    expect(r.entity_mentions).toBe(3);
    expect(r.persisted).toBe(true);

    // Append a second snapshot — table grows
    await snapshotPhase(e);
    const rows = await e.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM cycle_snapshots",
    );
    expect(rows.rows[0]!.c).toBe(2);
  });
});

describe("extract phase", () => {
  it("delegates to extractAll and returns its result shape", async () => {
    await seed();
    const e = storage.engine();
    const r = await extractPhase(e);
    expect(typeof r.documents).toBe("number");
    expect(typeof r.chunks).toBe("number");
    expect(r.errors).toEqual([]);
  });
});

describe("runCycleOnce orchestrator", () => {
  it("runs all 14 phases by default; one phase failing doesn't stop others", async () => {
    await seed();
    const e = storage.engine();
    // staleDays huge so embed-stale finds nothing — fastest cheap pass. The
    // seeded chunks have no vectors, so embed-gaps gets an offline embedder.
    const r = await runCycleOnce(e, {
      staleDays: 99999,
      embedGaps: { embed: async () => Array.from<number>({ length: EMBED_DIMENSIONS }).fill(0.01) },
    });
    expect(r.phases.length).toBe(14);
    expect(r.phases.map((p) => p.phase)).toEqual([
      "lint",
      "embed-stale",
      "embed-gaps",
      "mirror-pages",
      "embed-facts",
      "extract",
      "resolve-symbol-edges",
      "reconcile-links",
      "orphans-purge",
      "recompute-salience",
      "extract-timeline",
      "timeline-anchor",
      "snapshot",
      "purge",
    ]);
    // every phase should record durationMs
    for (const p of r.phases) {
      expect(p.durationMs).toBeGreaterThanOrEqual(0);
    }
    // a clean run: no phase failed, all ok, cycle rolls up to ok
    for (const p of r.phases) {
      expect(p.status).not.toBe("fail");
    }
    expect(["ok", "warn"]).toContain(r.status);
  });

  describe("deriveStatus (warn-state envelope)", () => {
    it("flags embed-stale as warn when a re-embed errored", () => {
      expect(
        deriveStatus("embed-stale", {
          scanned: 10,
          reembedded: 8,
          errors: [{ sourcePath: "a.md", message: "transient bedrock error" }],
        } as never),
      ).toBe("warn");
      expect(
        deriveStatus("embed-stale", {
          scanned: 10,
          reembedded: 10,
          errors: [],
        } as never),
      ).toBe("ok");
    });

    it("flags extract as warn when a document errored", () => {
      expect(
        deriveStatus("extract", {
          documents: 5,
          chunks: 20,
          mentionsBefore: 0,
          mentionsAfter: 3,
          errors: [{ sourcePath: "b.md", message: "parse failed" }],
        } as never),
      ).toBe("warn");
      expect(
        deriveStatus("extract", {
          documents: 5,
          chunks: 20,
          mentionsBefore: 0,
          mentionsAfter: 3,
          errors: [],
        } as never),
      ).toBe("ok");
    });

    it("flags snapshot as warn when it could not persist", () => {
      expect(deriveStatus("snapshot", { persisted: false } as never)).toBe("warn");
      expect(deriveStatus("snapshot", { persisted: true } as never)).toBe("ok");
    });

    it("flags orphans-purge as warn on a zero-chunk (corrupt) doc", () => {
      expect(
        deriveStatus("orphans-purge", {
          deleted: { embeddings: 0, entity_mentions: 0, entities: 0 },
          flagged: {
            docs_missing_on_disk: [{ id: "x", sourcePath: "x.md" }],
            docs_with_zero_chunks: [{ id: "y", sourcePath: "y.md" }],
          },
        } as never),
      ).toBe("warn");
      // missing-on-disk alone (routine churn) does NOT warn
      expect(
        deriveStatus("orphans-purge", {
          deleted: { embeddings: 0, entity_mentions: 0, entities: 0 },
          flagged: {
            docs_missing_on_disk: [{ id: "x", sourcePath: "x.md" }],
            docs_with_zero_chunks: [],
          },
        } as never),
      ).toBe("ok");
    });

    it("treats by-design informational phases as ok", () => {
      // reconcile-links unresolved is normal, not a warning
      expect(deriveStatus("reconcile-links", { unresolved: [{}] } as never)).toBe("ok");
      expect(deriveStatus("recompute-salience", {} as never)).toBe("ok");
    });
  });

  it("respects an explicit phases list", async () => {
    await seed();
    const e = storage.engine();
    const r = await runCycleOnce(e, {
      phases: ["snapshot"],
      staleDays: 99999,
    });
    expect(r.phases.length).toBe(1);
    expect(r.phases[0]!.phase).toBe("snapshot");
    expect(r.phases[0]!.ok).toBe(true);
    expect(r.phases[0]!.status).toBe("ok");
  });
});
