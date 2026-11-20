/**
 * Every migration from 120 on ships a down file of the same name, so the
 * latest one can always be reverted with `memrain migrate down`.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { discoverMigrations, findDownMigration } from "../src/core/migrate.ts";

// 120 is the first migration that shipped a down file; the ones before it never had one.
const FIRST_WITH_DOWN = 120;
const DOWN_DIR = resolve(import.meta.dir, "../src/core/migrations-down");

describe("migration down files", () => {
  // Value: protects=every new migration can be reverted; fails_when=a migration lands without
  // its down file, or the down file is named differently; why_new=only single migrations were
  // tested up-down-up, nothing caught a missing one; seam=none
  it("every migration from 120 on has exactly one down file with its name", () => {
    const missing: string[] = [];
    for (const m of discoverMigrations().filter((m) => m.id >= FIRST_WITH_DOWN)) {
      try {
        const down = findDownMigration(m.id);
        if (down.name !== m.name) missing.push(`${m.filename}: down file is named ${down.filename}`);
      } catch (err) {
        missing.push(`${m.filename}: ${(err as Error).message}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // Value: protects=a down file always undoes a migration that exists; fails_when=a migration is
  // renamed or dropped and its down file stays behind; why_new=same as above; seam=none
  it("every down file belongs to a migration of the same name", () => {
    const ups = new Map(discoverMigrations().map((m) => [m.id, m.name]));
    const orphans = readdirSync(DOWN_DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => {
        const m = /^(\d+)_([\w-]+)\.down\.sql$/.exec(f);
        return !m || Number(m[1]) < FIRST_WITH_DOWN || ups.get(Number(m[1])) !== m[2];
      });
    expect(orphans).toEqual([]);
  });
});
