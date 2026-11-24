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
import { deletePage, putPage } from "../src/core/pages.ts";
import { startBackgroundWork } from "../src/commands/serve.ts";
import { resolveQuiescence } from "../src/core/quiescence.ts";

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
  // Value: protects=two processes never run housekeeping (or a pre-Lite cycle) at once;
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

describe("housekeeping obeys the off-switches a pre-Lite cycle obeyed", () => {
  const SLUG = "notes/expired";
  const THREAD = "00000000-0000-4000-8000-0000000000d1";

  // A pre-Lite brain: a page soft-deleted far past its TTL and chat past its window.
  async function seedExpired(): Promise<void> {
    const e = storage.engine();
    await putPage(storage, { slug: SLUG, markdown_body: "gone a long time" });
    await deletePage(storage, SLUG);
    await e.query(`UPDATE pages SET deleted_at = NOW() - interval '400 days' WHERE slug = $1`, [SLUG]);
    await e.query(`INSERT INTO chat_threads (id, owner_key, source_id, title, updated_at) VALUES ($1, 'operator', 'default', 't', NOW() - interval '400 days')`, [THREAD]);
    await e.query(`INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES ($1, 'user', 'old', NOW() - interval '400 days')`, [THREAD]);
  }
  const pageRows = async () => (await storage.engine().query(`SELECT 1 FROM pages WHERE slug = $1`, [SLUG])).rows.length;
  const chatRows = async () => (await storage.engine().query(`SELECT 1 FROM chat_messages WHERE thread_id = $1`, [THREAD])).rows.length;
  const pause = (daemon: string) => storage.engine().query(
    `INSERT INTO daemon_controls (daemon, source_id, paused, paused_reason, paused_by) VALUES ($1, '*', true, 'held for the upgrade', 'ops')`,
    [daemon],
  );

  // Value: protects=the baseline the switches are measured against; fails_when=purge or
  // retention stops deleting expired rows; why_new=the switch cases below need a control; seam=none
  it("with no switch set, purges the expired page and the old chat", async () => {
    await seedExpired();
    const r = await runHousekeeping(storage, { env: {} });
    expect(r.errors).toEqual([]);
    expect(await pageRows()).toBe(0);
    expect(await chatRows()).toBe(0);
  });

  // Value: protects=an install that switched its pre-Lite cycle off keeps its expired rows after the
  // upgrade; fails_when=any one switch is ignored by a deleting step; why_new=housekeeping took
  // over the cycle's deletes; seam=env and daemon_controls rows as pre-Lite builds wrote them
  for (const [label, env, row] of [
    ["MEMRAIN_DAEMONS_DISABLED naming cycle", { MEMRAIN_DAEMONS_DISABLED: "notifications, cycle" }, null],
    ["MEMRAIN_CYCLE_SKIP_PHASES=purge", { MEMRAIN_CYCLE_SKIP_PHASES: "extract,purge" }, null],
    ["a paused row for every daemon", {}, "*"],
    ["a paused row for the cycle", {}, "cycle"],
  ] as const) {
    it(`keeps the expired page and the old chat under ${label}`, async () => {
      await seedExpired();
      if (row !== null) await pause(row);
      let swept = 0;
      const r = await runHousekeeping(storage, { env, sweepTokens: async () => ++swept });
      expect(r.errors).toEqual([]);
      expect(r.steps["purge"]).toMatchObject({ skipped: expect.any(String) });
      expect(r.steps["retention"]).toMatchObject({ skipped: expect.any(String) });
      expect(await pageRows()).toBe(1);
      expect(await chatRows()).toBe(1);
      // The token sweep ran outside the pre-Lite cycle and still runs.
      expect(swept).toBe(1);
    });
  }

  // Value: protects=a paused row for another daemon or one source leaves the cycle running, as in
  // pre-Lite; fails_when=the hold matches too broadly; why_new=same; seam=daemon_controls rows
  it("ignores a pause for another daemon", async () => {
    await seedExpired();
    await pause("connector_sync");
    await runHousekeeping(storage, { env: {} });
    expect(await pageRows()).toBe(0);
  });

  // Value: protects=skipping one phase leaves the others; fails_when=the skip list stops every
  // step; why_new=same; seam=env
  it("skips only the named phase", async () => {
    const r = await runHousekeeping(storage, { env: { MEMRAIN_CYCLE_SKIP_PHASES: "mirror-pages,embed-gaps" } });
    expect(r.steps["mirror_pages"]).toEqual({ skipped: "MEMRAIN_CYCLE_SKIP_PHASES" });
    expect(r.steps["embed_gaps"]).toEqual({ skipped: "MEMRAIN_CYCLE_SKIP_PHASES" });
    expect(r.steps["purge"]).not.toHaveProperty("skipped");
  });

  // Value: protects=MEMRAIN_CYCLE=0 and maintenance mode start no housekeeping at all;
  // fails_when=serve starts the timer anyway; why_new=same; seam=the start function is a spy
  it("starts nothing under MEMRAIN_CYCLE=0 or maintenance", () => {
    let started = 0;
    const deps = { startHousekeeping: () => { started++; return { stop: async () => {} }; } };
    expect(startBackgroundWork(storage, resolveQuiescence({ MEMRAIN_CYCLE: "0" }), undefined, deps)).toBeNull();
    expect(startBackgroundWork(storage, resolveQuiescence({ MEMRAIN_MAINTENANCE: "1" }), undefined, deps)).toBeNull();
    expect(started).toBe(0);
    expect(startBackgroundWork(storage, resolveQuiescence({}), undefined, deps)).not.toBeNull();
    expect(started).toBe(1);
  });
});

describe("chat retention", () => {
  // Value: protects=an expired first question does not outlive itself as the thread title;
  // fails_when=retention deletes messages without retitling their thread; why_new=pre-Lite retitled
  // in the same transaction; seam=none
  it("retitles a thread from its oldest remaining question, or clears the title", async () => {
    const e = storage.engine();
    const kept = "00000000-0000-4000-8000-0000000000e1";
    const emptied = "00000000-0000-4000-8000-0000000000e2";
    await e.query(
      `INSERT INTO chat_threads (id, owner_key, source_id, title) VALUES ($1, 'operator', 'default', 'expired secret question'),
         ($2, 'operator', 'default', 'another expired question')`,
      [kept, emptied],
    );
    await e.query(
      `INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES
         ($1, 'user', 'expired secret question', NOW() - interval '400 days'),
         ($1, 'user', 'a  fresh   question', NOW()),
         ($2, 'user', 'another expired question', NOW() - interval '400 days'),
         ($2, 'assistant', 'a fresh answer', NOW())`,
      [kept, emptied],
    );
    const r = await runHousekeeping(storage, { env: {} });
    expect(r.steps["retention"]).toMatchObject({ chat_messages: 2 });
    const titles = await e.query<{ id: string; title: string | null }>(
      `SELECT id::text AS id, title FROM chat_threads WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[kept, emptied]],
    );
    expect(titles.rows).toEqual([{ id: kept, title: "a fresh question" }, { id: emptied, title: null }]);
  });
});
