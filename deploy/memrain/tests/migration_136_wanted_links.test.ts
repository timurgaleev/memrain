/**
 * Migration 136 — the wanted_links table: up, down and up again.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { syncWikilinksForPage } from "../src/core/links.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-mig136-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function hasTable(): Promise<boolean> {
  const r = await storage.engine().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = 'wanted_links'`,
  );
  return r.rows[0]!.n === 1;
}

describe("migration 136", () => {
  it("creates wanted_links, reverts and re-applies", async () => {
    const e = storage.engine();
    expect(await hasTable()).toBe(true);
    await putPage(storage, { slug: "notes/a", markdown_body: "[[Nobody Yet]]" });
    await syncWikilinksForPage(storage, "notes/a", "[[Nobody Yet]]");

    const later = discoverMigrations().map((m) => m.id).filter((id) => id > 136).sort((a, b) => b - a);
    for (const id of later) await revertMigration(e, id);
    await revertMigration(e, 136);
    expect(await hasTable()).toBe(false);

    const again = await runMigrations(e);
    expect(again.applied.map((m) => m.id)).toEqual([136, ...later.reverse()]);
    expect(await hasTable()).toBe(true);
    await syncWikilinksForPage(storage, "notes/a", "[[Nobody Yet]]");
    const rows = await e.query<{ target_slug: string }>(`SELECT target_slug FROM wanted_links`);
    expect(rows.rows.map((r) => r.target_slug)).toEqual(["nobody-yet"]);
  });
});
