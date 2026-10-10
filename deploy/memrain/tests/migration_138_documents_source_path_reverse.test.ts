/**
 * Migration 138 — reversed source_path index: up, down and up again, and the
 * code-citation lookup uses it instead of scanning documents.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { CODE_REF_LOOKUP_SQL, codeRefLookupParams } from "../src/core/links.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-mig138-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function hasIndex(): Promise<boolean> {
  const r = await storage.engine().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'documents' AND indexname = 'documents_source_path_rev_idx'`,
  );
  return r.rows.length === 1 && r.rows[0]!.indexdef.includes("reverse(source_path) text_pattern_ops");
}

describe("migration 138", () => {
  it("the code-citation lookup reads the index rather than every document", async () => {
    const e = storage.engine();
    await e.query(
      `INSERT INTO documents (id, source_path, frontmatter)
       SELECT 'd' || g, '/repo/src/mod' || g || '/file_' || g || '.ts', '{"kind":"code"}'::jsonb
         FROM generate_series(1, 5000) g`,
    );
    await e.query(`ANALYZE documents`);
    const plan = await e.transaction(async (tx) => {
      // The PGLite engine turns sequential scans off for its vector indexes;
      // turn them back on so the planner has the scan to prefer.
      await tx.query(`SET LOCAL enable_seqscan = on`);
      const r = await tx.query<{ "QUERY PLAN": string }>(
        `EXPLAIN ${CODE_REF_LOOKUP_SQL}`,
        codeRefLookupParams("mod42/file_42.ts"),
      );
      return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("documents_source_path_rev_idx");

    const hits = async (path: string): Promise<number> =>
      (await e.query(CODE_REF_LOOKUP_SQL, codeRefLookupParams(path))).rows.length;
    expect(await hits("mod42/file_42.ts")).toBe(1);
    expect(await hits("/repo/src/mod42/file_42.ts")).toBe(1);
    // `_` is literal, and a suffix only matches at a path separator.
    expect(await hits("mod42/filex42.ts")).toBe(0);
    expect(await hits("ile_42.ts")).toBe(0);
  });

  it("creates the index, reverts, and re-applies", async () => {
    const e = storage.engine();
    expect(await hasIndex()).toBe(true);
    const later = discoverMigrations().map((m) => m.id).filter((id) => id > 138).sort((a, b) => b - a);
    for (const id of later) await revertMigration(e, id);
    await revertMigration(e, 138);
    expect(await hasIndex()).toBe(false);

    const again = await runMigrations(e);
    expect(again.applied.map((m) => m.id)).toEqual([138, ...later.reverse()]);
    expect(await hasIndex()).toBe(true);
  });

  it("refuses to run its down when it is not the latest migration", async () => {
    await expect(revertMigration(storage.engine(), 138)).rejects.toThrow();
    expect(await hasIndex()).toBe(true);
  });
});
