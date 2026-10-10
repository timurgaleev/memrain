/**
 * Migration 132 — the entity_facts chunk dedup key includes the speaker: up,
 * down (refused while two speakers share a chunk claim) and up again.
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
  tmp = mkdtempSync(join(tmpdir(), "memrain-mig132-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function indexes(): Promise<string[]> {
  const r = await storage.engine().query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'entity_facts' AND indexname LIKE 'entity_facts_dedup%' ORDER BY indexname`,
  );
  return r.rows.map((x) => x.indexname);
}

const base = { entity_slug: "people/a", fact: "Ship on Friday.", source_chunk_id: "c1" };

describe("migration 132", () => {
  it("swaps the speaker-blind index for one with the speaker, reverts and re-applies", async () => {
    const e = storage.engine();
    expect(await indexes()).toEqual(["entity_facts_dedup_speaker_idx"]);
    await addFact(storage, { ...base, attributed_to: "user" });

    const later = discoverMigrations().map((m) => m.id).filter((id) => id > 132).sort((a, b) => b - a);
    for (const id of later) await revertMigration(e, id);
    await revertMigration(e, 132);
    expect(await indexes()).toEqual(["entity_facts_dedup_idx"]);

    const again = await runMigrations(e);
    expect(again.applied.map((m) => m.id)).toEqual([132, ...later.reverse()]);
    expect(await indexes()).toEqual(["entity_facts_dedup_speaker_idx"]);
  });

  it("refuses its down while two speakers hold the same chunk claim", async () => {
    const e = storage.engine();
    await addFact(storage, { ...base, written_by: "w1", attributed_to: "user" });
    await addFact(storage, { ...base, written_by: "w2", attributed_to: "assistant" });
    const later = discoverMigrations().map((m) => m.id).filter((id) => id > 132).sort((a, b) => b - a);
    for (const id of later) await revertMigration(e, id);
    await expect(revertMigration(e, 132)).rejects.toThrow();
    expect(await indexes()).toEqual(["entity_facts_dedup_speaker_idx"]);
  });
});
