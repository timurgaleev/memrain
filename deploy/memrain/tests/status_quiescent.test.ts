/**
 * `status --quiescent`: exit 0 only when nothing can write on its own. Each
 * blocker alone flips it to exit 3: a running job, a leased job, a live cycle
 * lock row of either brand, a live worker heartbeat of either brand, and
 * maintenance off with a background switch on. Expired rows never block.
 * The DB checks run on PGLite and, when MEMRAIN_TEST_POSTGRES_URL points at a
 * scratch database, on Postgres too.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { PostgresEngine } from "../src/core/engine/postgres.ts";
import { pgTestEngine } from "./helpers/pg-test-engine.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { MAINTENANCE_ENV, JOBS_WORKER_ENV } from "../src/core/quiescence.ts";
import {
  quiescentFailures,
  readQuiescence,
  runStatus,
} from "../src/commands/status.ts";

const PG_URL = process.env.MEMRAIN_TEST_POSTGRES_URL;
const MAINT = { [MAINTENANCE_ENV]: "1" };

type Seed = { label: string; seed: (e: Engine) => Promise<void>; clean: (e: Engine) => Promise<void> };

async function runningJob(e: Engine, leaseSql: string): Promise<string> {
  const job = await new Queue(e).enqueue({ kind: "quiescence_probe" });
  await e.query(
    `UPDATE jobs SET status = 'running', started_at = NOW(), lock_until = ${leaseSql} WHERE id = $1`,
    [job.id],
  );
  return job.id;
}

const cycleRow = (id: string, ttl: string): Seed => ({
  label: `${ttl.startsWith("-") ? "an expired" : "a live"} ${id} row`,
  seed: async (e) => {
    await e.query(
      `INSERT INTO cycle_locks (id, holder_pid, holder_host, ttl_expires_at)
       VALUES ($1, 1, 'elsewhere', NOW() + $2::interval)`,
      [id, ttl],
    );
  },
  clean: async (e) => {
    await e.query(`DELETE FROM cycle_locks WHERE id = $1`, [id]);
  },
});

const workerRow = (id: string, ageSeconds: number): Seed => ({
  label: `${ageSeconds > 60 ? "an expired" : "a live"} ${id} heartbeat`,
  seed: async (e) => {
    await e.query(
      `INSERT INTO worker_lock (id, holder, heartbeat_at, ttl_seconds)
       VALUES ($1, 'elsewhere', NOW() - ($2 || ' seconds')::interval, 60)`,
      [id, String(ageSeconds)],
    );
  },
  clean: async (e) => {
    await e.query(`DELETE FROM worker_lock WHERE id = $1`, [id]);
  },
});

function jobSeed(label: string, leaseSql: string): Seed {
  let id = "";
  return {
    label,
    seed: async (e) => {
      id = await runningJob(e, leaseSql);
    },
    clean: async (e) => {
      await e.query(`DELETE FROM jobs WHERE id = $1`, [id]);
    },
  };
}

const BLOCKERS: Array<[Seed, string]> = [
  [jobSeed("a running job with an expired lease", "NOW() - interval '1 hour'"), "jobs_running=1"],
  [jobSeed("a leased job", "NOW() + interval '1 hour'"), "jobs_leased=1"],
  [cycleRow("memex-cycle", "1 hour"), "live_cycle_locks=1"],
  [cycleRow("memrain-cycle", "1 hour"), "live_cycle_locks=1"],
  [cycleRow("memex-cycle:embed", "1 hour"), "live_cycle_locks=1"],
  [workerRow("memex-jobs-worker", 0), "live_worker_lock=1"],
  [workerRow("memrain-jobs-worker", 0), "live_worker_lock=1"],
];

const HARMLESS: Seed[] = [
  cycleRow("memex-cycle", "-1 hour"),
  cycleRow("memrain-cycle", "-1 hour"),
  workerRow("memex-jobs-worker", 3600),
  // Another lock kind in the shared table is not background work of ours.
  cycleRow("some-other-lock", "1 hour"),
];

function dbCases(engine: () => Engine, kind: "pglite" | "postgres") {
  it("a quiet database in maintenance passes, with every field present", async () => {
    const s = await readQuiescence(engine(), MAINT);
    expect(Object.keys(s).sort()).toEqual(
      [
        "maintenance", "code_sweep", "jobs_worker", "cycle", "jobs_running", "jobs_leased",
        "live_cycle_locks", "live_worker_lock", "other_db_sessions",
      ].sort(),
    );
    expect(s).toMatchObject({
      maintenance: true,
      code_sweep: false,
      jobs_worker: false,
      cycle: false,
      jobs_running: 0,
      jobs_leased: 0,
      live_cycle_locks: 0,
      live_worker_lock: 0,
    });
    if (kind === "postgres") expect(typeof s.other_db_sessions).toBe("number");
    else expect(s.other_db_sessions).toBeNull();
    expect(quiescentFailures(s)).toEqual([]);
  });

  for (const [blocker, expected] of BLOCKERS) {
    it(`${blocker.label} blocks`, async () => {
      const e = engine();
      await blocker.seed(e);
      try {
        const failures = quiescentFailures(await readQuiescence(e, MAINT));
        expect(failures).toContain(expected);
      } finally {
        await blocker.clean(e);
      }
    });
  }

  for (const h of HARMLESS) {
    it(`${h.label} does not block`, async () => {
      const e = engine();
      await h.seed(e);
      try {
        expect(quiescentFailures(await readQuiescence(e, MAINT))).toEqual([]);
      } finally {
        await h.clean(e);
      }
    });
  }

  it("maintenance off with a background switch on blocks", async () => {
    const s = await readQuiescence(engine(), { [JOBS_WORKER_ENV]: "0" });
    expect(quiescentFailures(s)).toEqual(["maintenance off and a background switch on"]);
  });

  it("all three switches off without maintenance passes", async () => {
    const s = await readQuiescence(engine(), {
      MEMRAIN_BOOT_CODE_SWEEP: "0",
      MEMRAIN_JOBS_WORKER: "0",
      MEMRAIN_CYCLE: "0",
    });
    expect(quiescentFailures(s)).toEqual([]);
  });
}

describe("quiescence status on PGLite", () => {
  let dir: string;
  let storage: Storage;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "memrain-status-quiescent-"));
    storage = new Storage({ dbPath: dir });
    await storage.init();
  });
  afterAll(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });
  dbCases(() => storage.engine(), "pglite");
});

describe.skipIf(!PG_URL)("quiescence status on Postgres", () => {
  let pg: PostgresEngine;
  beforeAll(async () => {
    pg = pgTestEngine({ url: PG_URL! });
    await new Storage(pg).init();
  });
  afterAll(async () => {
    await pg.close();
  });
  dbCases(() => pg, "postgres");
});

describe("memrain status --quiescent (end to end)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "memrain-status-quiescent-cli-"));
  const cfgDir = join(tmp, ".memex");
  const cfgPath = join(cfgDir, "config.json");
  const saved = process.env[MAINTENANCE_ENV];

  beforeAll(() => {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        database: { type: "pglite", path: join(cfgDir, "brain.pglite") },
        embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
        storage: {},
      }),
    );
  });

  afterAll(() => {
    if (saved === undefined) delete process.env[MAINTENANCE_ENV];
    else process.env[MAINTENANCE_ENV] = saved;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function run(maintenance: string | undefined, quiescent: boolean) {
    if (maintenance === undefined) delete process.env[MAINTENANCE_ENV];
    else process.env[MAINTENANCE_ENV] = maintenance;
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
    try {
      const code = await runStatus({ configPath: cfgPath, quiescent });
      return { code, json: JSON.parse(out.join("\n")) as { quiescence: Record<string, unknown> }, err };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  it("exits 0 in maintenance on a quiet brain", async () => {
    const r = await run("1", true);
    expect(r.code).toBe(0);
    expect(r.json.quiescence.maintenance).toBe(true);
  });

  it("exits 3 and names the failing item with maintenance off", async () => {
    const r = await run(undefined, true);
    expect(r.code).toBe(3);
    expect(r.err.join("\n")).toContain("maintenance off and a background switch on");
  });

  it("plain status never fails on quiescence and still reports the block", async () => {
    const r = await run(undefined, false);
    expect(r.code).toBe(0);
    expect(r.json.quiescence.jobs_worker).toBe(true);
  });
});
