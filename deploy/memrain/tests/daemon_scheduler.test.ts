import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { _resetHandlersForTesting, registerHandler } from "../src/core/jobs/handlers.ts";
import { _resetDaemonsForTesting, registerDaemon, type DaemonSpec } from "../src/core/daemons/registry.ts";
import { readControls, resumeDaemon, pauseDaemon } from "../src/core/daemons/controls.ts";
import { DaemonScheduler, enqueueDueDaemons, registerDaemonHandler } from "../src/core/daemons/scheduler.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";

const ON = { MEMRAIN_DAEMONS: "1" } as NodeJS.ProcessEnv;
const BERLIN = "Europe/Berlin";
/** 07:30 in Berlin on 2026-11-15 (CET, UTC+1). */
const MORNING = new Date("2026-11-15T06:30:00Z");
const WINDOW_ID = "daemon:probe:default:2026-11-15T07:00@Europe/Berlin";

const probe = (over: Partial<DaemonSpec> = {}): DaemonSpec => ({
  name: "probe",
  kind: "daemon_probe",
  schedule: { cron: "0 7 * * *", timezone: BERLIN },
  lane: "short",
  paid: false,
  defaultEnabled: true,
  ...over,
});

/** The probe's outcome; built-in daemons (connector_sync) report alongside it. */
const probeOutcome = (results: Array<{ daemon: string; outcome: string }>) => results.find(r => r.daemon === "probe")?.outcome;

const jobIds = async (e: Engine) =>
  (await e.query<{ id: string }>(`SELECT id FROM jobs WHERE kind = 'daemon_probe' ORDER BY id`)).rows.map(r => r.id);

beforeEach(() => {
  _resetDaemonsForTesting();
  _resetHandlersForTesting();
  registerHandler("daemon_probe", async () => ({}));
});
afterEach(() => {
  _resetDaemonsForTesting();
  _resetHandlersForTesting();
});

describe("daemon scheduler kill switch", () => {
  it("does nothing, and touches no database, unless MEMRAIN_DAEMONS=1", async () => {
    registerDaemon(probe());
    const engine = { query: () => { throw new Error("queried"); }, transaction: () => { throw new Error("queried"); } } as unknown as Engine;
    const s = new DaemonScheduler(engine, { env: {} as NodeJS.ProcessEnv });
    expect(await s.tickOnce(MORNING)).toEqual({ status: "disabled" });
    expect(await new DaemonScheduler(engine, { env: { MEMRAIN_DAEMONS: "0" } as NodeJS.ProcessEnv }).tickOnce(MORNING))
      .toEqual({ status: "disabled" });
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`daemon scheduler (${name})`, () => {
  it("queues one job per window, however many ticks land in it", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      registerDaemon(probe());
      await enqueueDueDaemons(e, MORNING, { env: ON });
      await enqueueDueDaemons(e, new Date(MORNING.getTime() + 60_000), { env: ON });
      expect(await jobIds(e)).toEqual([WINDOW_ID]);
      const row = (await readControls(e)).find(r => r.daemon === "probe")!;
      expect(row.last_window).toBe("2026-11-15T07:00@Europe/Berlin");
    } finally { await db.close(); }
  });

  it("elects one leader among schedulers sharing a database", async () => {
    const db = await open();
    const e = db.storage.engine();
    const a = new DaemonScheduler(e, { env: ON });
    const b = new DaemonScheduler(e, { env: ON });
    try {
      registerDaemon(probe());
      const ra = await a.tickOnce(MORNING);
      const rb = await b.tickOnce(MORNING);
      expect([ra.status, rb.status].sort()).toEqual(["not_leader", "ran"]);
      expect(await jobIds(e)).toEqual([WINDOW_ID]);
      expect(a.health().leader).toBe(true);
      expect(b.health().leader).toBe(false);
    } finally {
      await a.stop();
      await b.stop();
      await db.close();
    }
  });

  it("queues nothing for a paused daemon or under a global pause, and resumes", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      registerDaemon(probe());
      await pauseDaemon(e, { daemon: "probe", by: "cli", reason: "maintenance" });
      expect((await enqueueDueDaemons(e, MORNING, { env: ON })).find(r => r.daemon === "probe")?.outcome).toBe("paused");
      await resumeDaemon(e, { daemon: "probe", by: "cli" });
      await pauseDaemon(e, { daemon: "*", by: "cli" });
      await enqueueDueDaemons(e, MORNING, { env: ON });
      expect(await jobIds(e)).toEqual([]);
      await resumeDaemon(e, { daemon: "*", by: "cli" });
      await enqueueDueDaemons(e, MORNING, { env: ON });
      expect(await jobIds(e)).toEqual([WINDOW_ID]);
    } finally { await db.close(); }
  });

  it("after three days down queues only the latest window, and none once it is too old", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      registerDaemon(probe());
      const late = new Date("2026-11-15T13:30:00Z"); // 14:30 Berlin, 7.5 h after the window
      expect(probeOutcome(await enqueueDueDaemons(e, late, { env: ON }))).toBe("window_too_old");
      expect(await jobIds(e)).toEqual([]);
      await enqueueDueDaemons(e, MORNING, { env: ON });
      expect(await jobIds(e)).toEqual([WINDOW_ID]);
    } finally { await db.close(); }
  });

  it("auto-pauses after five failed runs in a row, says so once, and counts afresh after resume", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      registerDaemon(probe());
      for (let d = 10; d < 15; d++) {
        await e.query(
          `INSERT INTO jobs (id, kind, status, created_at) VALUES ($1, 'daemon_probe', 'failed', NOW() - ($2 || ' minutes')::interval)`,
          [`daemon:probe:default:2026-11-${d}T07:00@Europe/Berlin`, String(30 - d)],
        );
      }
      const lines: string[] = [];
      const log = (_level: string, msg: string) => void lines.push(msg);
      expect(probeOutcome(await enqueueDueDaemons(e, MORNING, { env: ON, log }))).toBe("auto_paused");
      expect(probeOutcome(await enqueueDueDaemons(e, MORNING, { env: ON, log }))).toBe("paused");
      expect(lines.filter(l => l.includes("auto-paused"))).toHaveLength(1);
      const row = (await readControls(e)).find(r => r.daemon === "probe")!;
      expect(row.paused).toBe(true);
      expect(row.paused_reason).toBe("auto:failures");
      expect(await jobIds(e)).not.toContain(WINDOW_ID);

      await resumeDaemon(e, { daemon: "probe", by: "cli" });
      expect(probeOutcome(await enqueueDueDaemons(e, MORNING, { env: ON, log }))).toBe("queued");
      expect(await jobIds(e)).toContain(WINDOW_ID);
    } finally { await db.close(); }
  });

  it("a malformed cron or zone override skips that daemon instead of failing the tick", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      registerDaemon(probe());
      registerDaemon(probe({ name: "other", kind: "daemon_probe" }));
      await e.query(`INSERT INTO daemon_controls (daemon, source_id, timezone) VALUES ('probe', '*', 'Mars/Olympus')`);
      await e.query(`INSERT INTO daemon_controls (daemon, source_id, cron) VALUES ('other', '*', '61 * * * *')`);
      const r = await enqueueDueDaemons(e, MORNING, { env: ON });
      expect(Object.fromEntries(r.filter(x => x.daemon !== "connector_sync").map(x => [x.daemon, x.outcome]))).toEqual({ other: "bad_schedule", probe: "bad_schedule" });
    } finally { await db.close(); }
  });

  it("a run already queued when the daemon is paused is skipped, not run", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const spec = probe({ kind: "daemon_probe_wrapped" });
      registerDaemon(spec);
      let ran = 0;
      registerDaemonHandler(e, spec, async () => { ran++; return {}; }, { env: ON });
      await enqueueDueDaemons(e, MORNING, { env: ON });
      await pauseDaemon(e, { daemon: "probe", by: "cli" });
      const queue = new Queue(e);
      await new Worker(queue, { logger: () => {} }).drainOnce();
      expect(ran).toBe(0);
      const job = (await queue.get(WINDOW_ID))!;
      expect(job.status).toBe("succeeded");
      expect(job.result).toEqual({ skipped: "paused" });

      await resumeDaemon(e, { daemon: "probe", by: "cli" });
      await e.query(`UPDATE jobs SET status = 'pending' WHERE id = $1`, [WINDOW_ID]);
      await new Worker(queue, { logger: () => {} }).drainOnce();
      expect(ran).toBe(1);
    } finally { await db.close(); }
  });

  it("refuses a paid daemon when no brain-wide daily cap is set", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      registerDaemon(probe({ paid: true }));
      expect(probeOutcome(await enqueueDueDaemons(e, MORNING, { env: ON }))).toBe("no_brain_cap");
      expect(probeOutcome(await enqueueDueDaemons(e, MORNING, { env: { ...ON, MEMRAIN_DAILY_BUDGET_USD: "2" } }))).toBe("queued");
    } finally { await db.close(); }
  });

  it("honours the per-daemon env kill switch and a daemon without a handler", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      registerDaemon(probe());
      registerDaemon(probe({ name: "orphan", kind: "daemon_unregistered" }));
      const r = await enqueueDueDaemons(e, MORNING, { env: { ...ON, MEMRAIN_DAEMONS_DISABLED: "probe" } });
      expect(Object.fromEntries(r.filter(x => x.daemon !== "connector_sync").map(x => [x.daemon, x.outcome]))).toEqual({ probe: "env_disabled", orphan: "no_handler" });
      expect(await jobIds(e)).toEqual([]);
    } finally { await db.close(); }
  });
});

if (process.env.MEMRAIN_TEST_POSTGRES_URL) describe("daemon scheduler across two processes (Postgres)", () => {
  it("two schedulers racing on one database in one window queue one job", async () => {
    const pg = storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL).find(x => x.name === "Postgres")!;
    const db = await pg.open();
    const e = db.storage.engine();
    const url = new URL(process.env.MEMRAIN_TEST_POSTGRES_URL!);
    url.pathname = `/${(await e.query<{ name: string }>("SELECT current_database() AS name")).rows[0]!.name}`;
    const other = new PostgresEngine({ url: url.toString(), max: 2 });
    try {
      registerDaemon(probe());
      await Promise.all([enqueueDueDaemons(e, MORNING, { env: ON }), enqueueDueDaemons(other, MORNING, { env: ON })]);
      expect(await jobIds(e)).toEqual([WINDOW_ID]);
    } finally {
      await other.close();
      await db.close();
    }
  });
});
