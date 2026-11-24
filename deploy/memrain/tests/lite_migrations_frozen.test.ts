/**
 * The schema is frozen at v0.25.0: every migration and down file is byte for
 * byte the one that release shipped, and no migration id goes past 196. The
 * migrator records ids only and never compares SQL (migrate.ts), so an edited
 * file would reach a fresh install while every existing brain keeps the old
 * schema. The manifest was taken with `git show v0.25.0:<path>`.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { discoverMigrations } from "../src/core/migrate.ts";
import manifest from "./fixtures/lite_migrations_v0.25.0.json";

const CORE = resolve(import.meta.dir, "../src/core");
const LAST_FROZEN_ID = 196;

function onDisk(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const dir of ["migrations", "migrations-down"]) {
    for (const name of readdirSync(resolve(CORE, dir)).sort()) {
      const bytes = readFileSync(resolve(CORE, dir, name));
      files[`${dir}/${name}`] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  return files;
}

describe("migrations frozen at v0.25.0", () => {
  // Value: protects=an existing pre-Lite brain and a fresh install end on the same schema;
  // fails_when=a migration or down file is edited, added or removed; why_new=the migrator
  // compares ids only, so nothing else notices an edited file; seam=none
  it("every migration and down file matches the v0.25.0 manifest byte for byte", () => {
    expect(onDisk()).toEqual(manifest.files);
  });

  // Value: protects=the frozen schema boundary; fails_when=a migration above 196 lands;
  // why_new=same as above; seam=none
  it("no migration id is above 196", () => {
    const ids = discoverMigrations().map((m) => m.id);
    expect(ids.filter((id) => id > LAST_FROZEN_ID)).toEqual([]);
    expect(Math.max(...ids)).toBe(LAST_FROZEN_ID);
  });
});
