/**
 * Migration 122 — secret_audit_runs and page_versions.scrubbed_at: up, down
 * and up again.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-mig122-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function shape(): Promise<{ table: boolean; column: boolean }> {
  const e = storage.engine();
  const t = await e.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'secret_audit_runs'`);
  const c = await e.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'page_versions' AND column_name = 'scrubbed_at'`,
  );
  return { table: t.rows.length > 0, column: c.rows.length > 0 };
}

describe("migration 122", () => {
  it("adds the run table and the scrub stamp, reverts keeping versions, and re-applies", async () => {
    const e = storage.engine();
    await putPage(storage, { slug: "notes/a", type: "note", markdown_body: "x" });
    await e.query(`INSERT INTO secret_audit_runs (scan_version) VALUES (2)`);
    expect(await shape()).toEqual({ table: true, column: true });

    const later = discoverMigrations().map((m) => m.id).filter((id) => id > 122).sort((a, b) => b - a);
    for (const id of later) await revertMigration(e, id);
    await revertMigration(e, 122);
    expect(await shape()).toEqual({ table: false, column: false });
    const n = await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM page_versions`);
    expect(n.rows[0]!.n).toBe(1);

    const again = await runMigrations(e);
    expect(again.applied.map((m) => m.id)).toEqual([122, ...later.reverse()]);
    expect(await shape()).toEqual({ table: true, column: true });
  });

  it("refuses to run its down when it is not the latest migration", async () => {
    await expect(revertMigration(storage.engine(), 122)).rejects.toThrow();
    expect(await shape()).toEqual({ table: true, column: true });
  });
});
