/**
 * The hourly housekeeping `serve` runs in place of the job worker, daemons and
 * maintenance cycle: one run at a time under the `memrain-cycle` lock, every
 * step attempted, and its finish recorded for the doctor.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { CYCLE_LOCK_ID, tryAcquireDbLock } from "../src/core/db-lock.ts";
import { chatRetentionDays, lastHousekeepingRun, runHousekeeping } from "../src/core/housekeeping.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-housekeeping-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("housekeeping", () => {
  // Value: protects=two processes never run housekeeping (or a 2.x cycle) at once;
  // fails_when=the run ignores a held memrain-cycle lock; why_new=housekeeping replaces the cycle; seam=none
  it("does nothing while another holder has the lock", async () => {
    const held = await tryAcquireDbLock(storage.engine(), CYCLE_LOCK_ID, 30);
    expect(held).not.toBeNull();
    try {
      let swept = 0;
      const r = await runHousekeeping(storage, { sweepTokens: async () => ++swept });
      expect(r).toEqual({ ran: false, reason: "locked", steps: {}, errors: [] });
      expect(swept).toBe(0);
      expect(await lastHousekeepingRun(storage.engine())).toBeNull();
    } finally {
      await held!.release();
    }
  });

  // Value: protects=every step runs and the finish is recorded, and the lock is released
  // after; fails_when=a step is skipped, the record is missing, or the lock leaks;
  // why_new=same; seam=sweepTokens stands in for the OAuth provider
  it("runs every step, records the finish and releases the lock", async () => {
    const e = storage.engine();
    await e.query(
      `INSERT INTO mcp_spend_reservations (reservation_id, client_id, estimated_cents, model, provider, status, expires_at)
       VALUES ('r-stale', 'memrain_brain', 1, 'm', 'bedrock', 'pending', NOW() - interval '1 hour')`,
    );
    const thread = "00000000-0000-4000-8000-0000000000c1";
    await e.query(`INSERT INTO chat_threads (id, owner_key, source_id, title, updated_at) VALUES ($1, 'operator', 'default', 't', NOW() - interval '400 days')`, [thread]);
    await e.query(`INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES ($1, 'user', 'old', NOW() - interval '400 days')`, [thread]);
    let swept = 0;
    const r = await runHousekeeping(storage, { sweepTokens: async () => { swept++; return 3; } });
    expect(r.ran).toBe(true);
    expect(r.errors).toEqual([]);
    expect(Object.keys(r.steps)).toEqual(["purge", "mirror_pages", "embed_gaps", "tokens", "reservations", "retention"]);
    expect(r.steps["tokens"]).toEqual({ swept: 3 });
    expect(r.steps["reservations"]).toEqual({ expired: 1 });
    expect(r.steps["retention"]).toMatchObject({ chat_messages: 1, chat_threads: 1 });
    expect(swept).toBe(1);
    const last = await lastHousekeepingRun(e);
    expect(last?.errors).toBe(0);
    expect(Number.isFinite(Date.parse(last!.finishedAt))).toBe(true);
    const again = await tryAcquireDbLock(e, CYCLE_LOCK_ID, 30);
    expect(again).not.toBeNull();
    await again!.release();
  });

  // Value: protects=a step that throws is reported and the rest still run; fails_when=one
  // failure aborts the run; why_new=same; seam=sweepTokens throws
  it("records a failing step and runs the rest", async () => {
    const r = await runHousekeeping(storage, { sweepTokens: async () => { throw new Error("sweep down"); } });
    expect(r.ran).toBe(true);
    expect(r.errors).toEqual(["tokens: sweep down"]);
    expect(r.steps["retention"]).toBeDefined();
    expect((await lastHousekeepingRun(storage.engine()))?.errors).toBe(1);
  });

  // Value: protects=chat history keeps its retention window; fails_when=the env parse
  // changes; why_new=same; seam=env
  it("reads MEMRAIN_CHAT_RETENTION_DAYS, 0 keeping everything", () => {
    expect(chatRetentionDays({})).toBe(90);
    expect(chatRetentionDays({ MEMRAIN_CHAT_RETENTION_DAYS: "0" })).toBeNull();
    expect(chatRetentionDays({ MEMRAIN_CHAT_RETENTION_DAYS: "30" })).toBe(30);
    expect(chatRetentionDays({ MEMRAIN_CHAT_RETENTION_DAYS: "x" })).toBe(90);
  });
});
