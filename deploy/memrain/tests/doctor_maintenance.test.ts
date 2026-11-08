import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { checkCyclePhaseHealth, checkMaintenanceHeld } from "../src/core/doctor-maintenance.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`maintenance diagnostics ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("shows only phases whose most recent status failed", async () => {
    await db.storage.engine().exec(`INSERT INTO cycle_phase_runs (phase, last_status) VALUES ('lint', 'ok'), ('embed-gaps', 'warn'), ('extract-atoms', 'fail')`);
    const result = await checkCyclePhaseHealth(db.storage.engine());
    expect(result).toMatchObject({ ok: true, status: "warn" });
    expect(result.detail).toContain("1 phase(s) last failed: extract-atoms");
    expect(result.detail).not.toContain("embed-gaps");
    await db.storage.engine().exec(`UPDATE cycle_phase_runs SET last_status = 'ok' WHERE phase = 'extract-atoms'`);
    expect(await checkCyclePhaseHealth(db.storage.engine())).toMatchObject({ status: "ok" });
  });
  it("counts only active retry holds and live embeddable chunks at the failure threshold", async () => {
    await db.storage.engine().exec(`INSERT INTO synth_failures (doc_id, phase, content_hash, model, attempts, kind, next_eligible_at) VALUES
      ('held', 'atoms', 'h', 'm', 3, 'unparseable', now() + interval '1 day'),
      ('expired', 'takes', 'h', 'm', 3, 'truncated', now() - interval '1 day'),
      ('early', 'takes', 'h', 'm', 2, 'truncated', now() + interval '1 day')`);
    await db.storage.engine().exec(`INSERT INTO documents (id, source_path, deleted_at) VALUES
      ('live', 'live.md', NULL), ('deleted', 'deleted.md', now()), ('early', 'early.md', NULL)`);
    await db.storage.engine().exec(`INSERT INTO chunks (id, document_id, chunk_index, content, embed_failures) VALUES
      ('live-c', 'live', 0, 'DO NOT PRINT', 3), ('deleted-c', 'deleted', 0, 'DELETED BODY', 3), ('early-c', 'early', 0, 'EARLY BODY', 2)`);
    const result = await checkMaintenanceHeld(db.storage.engine());
    expect(result).toMatchObject({ ok: true, status: "warn" });
    expect(result.detail).toContain("atoms=1");
    expect(result.detail).not.toContain("takes=");
    expect(result.detail).toContain("chunks=1");
    expect(result.detail).not.toContain("BODY");
    expect(result.detail).not.toContain("DO NOT PRINT");
    await db.storage.engine().exec(`UPDATE synth_failures SET next_eligible_at = now() - interval '1 day'; UPDATE chunks SET embed_failures = 0;`);
    expect(await checkMaintenanceHeld(db.storage.engine())).toMatchObject({ status: "ok" });
  });
});
