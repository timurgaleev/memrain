/**
 * Migration 137 — index on code_edges_symbol.from_symbol_qualified: up, down
 * and up again.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-mig137-"));
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
      WHERE tablename = 'code_edges_symbol' AND indexname = 'code_edges_symbol_from_sym_idx'`,
  );
  return r.rows.length === 1 && r.rows[0]!.indexdef.includes("(from_symbol_qualified)");
}

describe("migration 137", () => {
  it("indexes the calling symbol, reverts, and re-applies", async () => {
    const e = storage.engine();
    expect(await hasIndex()).toBe(true);

    const later = discoverMigrations().map((m) => m.id).filter((id) => id > 137).sort((a, b) => b - a);
    for (const id of later) await revertMigration(e, id);
    await revertMigration(e, 137);
    expect(await hasIndex()).toBe(false);

    const again = await runMigrations(e);
    expect(again.applied.map((m) => m.id)).toEqual([137, ...later.reverse()]);
    expect(await hasIndex()).toBe(true);
  });

  it("refuses to run its down when it is not the latest migration", async () => {
    await expect(revertMigration(storage.engine(), 137)).rejects.toThrow();
    expect(await hasIndex()).toBe(true);
  });
});
