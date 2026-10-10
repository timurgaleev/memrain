/**
 * Migration 130 — entity_facts.attributed_to: up, down and up again.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addFact } from "../src/core/facts.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-mig130-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function hasColumn(): Promise<boolean> {
  const r = await storage.engine().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'entity_facts' AND column_name = 'attributed_to'`,
  );
  return r.rows.length > 0;
}

describe("migration 130", () => {
  it("adds a checked column, reverts cleanly keeping the rows, and re-applies", async () => {
    const e = storage.engine();
    await addFact(storage, { entity_slug: "people/a", fact: "said by the user", attributed_to: "user" });
    await addFact(storage, { entity_slug: "people/a", fact: "said by the assistant", attributed_to: "assistant" });
    expect(await hasColumn()).toBe(true);
    await expect(
      e.query(`INSERT INTO entity_facts (entity_slug, fact, attributed_to) VALUES ('people/a', 'x', 'bot')`),
    ).rejects.toThrow();

    // A down is only defined on top of its own migration.
    const later = discoverMigrations().map((m) => m.id).filter((id) => id > 130).sort((a, b) => b - a);
    for (const id of later) await revertMigration(e, id);
    await revertMigration(e, 130);
    expect(await hasColumn()).toBe(false);
    const n = await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM entity_facts`);
    expect(n.rows[0]!.n).toBe(2);

    const again = await runMigrations(e);
    expect(again.applied.map((m) => m.id)).toEqual([130, ...later.reverse()]);
    expect(await hasColumn()).toBe(true);
  });

  it("refuses to run its down when it is not the latest migration", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO migrations (id, name) VALUES (9999, 'fake')`);
    await expect(revertMigration(e, 130)).rejects.toThrow();
    expect(await hasColumn()).toBe(true);
  });
});
