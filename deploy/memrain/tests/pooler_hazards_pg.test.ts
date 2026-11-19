/**
 * What transaction-mode pooling does to session state, measured through the
 * PgBouncer image hosting runs (deploy/pgbouncer). scripts/test-pg.sh with
 * TEST_PG_POOLER=1 sets MEMRAIN_TEST_PGBOUNCER_URL; no other run has a pooler,
 * so the file runs only there.
 *
 * Each case uses a fresh database, so its pool starts empty. Sequential work
 * then lands on one server session, and a second session only opens while the
 * first is busy in a transaction. That makes both failure shapes
 * deterministic: state leaking to another client on the same server session,
 * and state missing on a different one. scripts/scope-lint.ts refuses every
 * construct shown leaking here; the transaction-scoped forms it allows are
 * shown working.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import postgres from "postgres";
import { PostgresEngine } from "../src/core/engine/postgres.ts";

setDefaultTimeout(60_000);

const WORK_MEM = "SELECT current_setting('work_mem') AS v";
const POOLED = process.env["MEMRAIN_TEST_PGBOUNCER_URL"];
const DIRECT = process.env["MEMRAIN_TEST_POSTGRES_DIRECT_URL"];

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

if (POOLED && DIRECT) {
  const dbName = `hazards_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
  const opened: PostgresEngine[] = [];
  const admin = new PostgresEngine({ url: DIRECT, max: 1 });

  /** A pooled engine of one client connection on the case's database. */
  function client(prepare?: boolean): PostgresEngine {
    const e = new PostgresEngine({
      url: withDatabase(POOLED!, dbName),
      max: 1,
      pooler: "pgbouncer",
      directUrl: withDatabase(DIRECT!, dbName),
      ...(prepare === false ? { prepare: false } : {}),
    });
    opened.push(e);
    return e;
  }

  /** Server backend pid of the session the next statement lands on. */
  async function backend(e: PostgresEngine): Promise<number> {
    return (await e.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  }

  /** Run `fn` while `holder` keeps one server session busy in a transaction. */
  async function whileHeld<T>(holder: PostgresEngine, fn: () => Promise<T>): Promise<{ result: T; heldPid: number }> {
    let release!: () => void;
    let heldPid = 0;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const started = new Promise<void>((r) => { ready = r; });
    const held = holder.transaction(async (tx) => {
      heldPid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      ready();
      await gate;
    });
    await started;
    try {
      return { result: await fn(), heldPid };
    } finally {
      release();
      await held;
    }
  }

  beforeAll(async () => {
    await admin.exec(`CREATE DATABASE ${dbName}`);
  });

  afterAll(async () => {
    for (const e of opened) await e.close();
    await admin.exec(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.close();
  });

  describe("through PgBouncer in transaction mode", () => {
    for (const prepare of [true, false]) {
      it(`prepared statements stay correct across clients (prepare: ${prepare})`, async () => {
        const a = client(prepare);
        const b = client(prepare);
        const c = client(prepare);
        expect(a.options().prepare).toBe(prepare ? undefined : false);
        const runs = Array.from({ length: 60 }, (_, i) => [a, b, c][i % 3]!.query<{ n: number; s: string }>(
          "SELECT $1::int * 2 AS n, $2::text AS s", [i, `v${i}`],
        ));
        const rows = (await Promise.all(runs)).map((r) => r.rows[0]);
        expect(rows).toEqual(Array.from({ length: 60 }, (_, i) => ({ n: i * 2, s: `v${i}` })));
        // Different statement texts on the same server sessions do not mix plans.
        expect((await b.query<{ t: string }>("SELECT $1::text || '!' AS t", ["x"])).rows[0]!.t).toBe("x!");
        expect((await c.query<{ n: number }>("SELECT $1::int + 1 AS n", [41])).rows[0]!.n).toBe(42);
      });
    }

    it("a session SET leaks to the next client on that server session; SET LOCAL does not", async () => {
      const a = client();
      const b = client();
      const pidA = await backend(a);
      await a.exec("SET work_mem = '7MB'");
      expect(await backend(b)).toBe(pidA);
      expect((await b.query<{ v: string }>(WORK_MEM)).rows[0]!.v).toBe("7MB");
      await b.exec("RESET work_mem");

      await a.transaction(async (tx) => {
        await tx.exec("SET LOCAL work_mem = '9MB'");
        expect((await tx.query<{ v: string }>(WORK_MEM)).rows[0]!.v).toBe("9MB");
      });
      expect(await backend(b)).toBe(pidA);
      expect((await b.query<{ v: string }>(WORK_MEM)).rows[0]!.v).not.toBe("9MB");
    });

    it("a session advisory lock is held by the server session, not the client; an xact lock works", async () => {
      const a = client();
      const b = client();
      const key = 7_310_042;
      const pidA = await backend(a);
      expect((await a.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [key])).rows[0]!.ok).toBe(true);
      // Another client lands on the same server session and "acquires" the
      // lock a holds: the lock no longer excludes anyone.
      expect(await backend(b)).toBe(pidA);
      expect((await b.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [key])).rows[0]!.ok).toBe(true);
      await b.query("SELECT pg_advisory_unlock_all()");

      // The transaction-scoped lock excludes the other client and ends with
      // its transaction.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => { locked = r; });
      const holder = a.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock($1)", [key]);
        locked();
        await gate;
      });
      await isLocked;
      const other = await b.transaction((tx) => tx.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [key]));
      expect(other.rows[0]!.ok).toBe(false);
      release();
      await holder;
      const after = await b.transaction((tx) => tx.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [key]));
      expect(after.rows[0]!.ok).toBe(true);
    });

    it("LISTEN through the pooler never hears a NOTIFY the database sends", async () => {
      const channel = `hazard_${process.pid}`;
      const heard: string[] = [];
      const direct = postgres(withDatabase(DIRECT!, dbName), { max: 1, onnotice: () => {} });
      const pooled = postgres(withDatabase(POOLED!, dbName), { max: 1, onnotice: () => {} });
      const heardDirect: string[] = [];
      try {
        const l1 = await direct.listen(channel, (p) => { heardDirect.push(p); });
        const pooledListen = await pooled.listen(channel, (p) => { heard.push(p); }).then(
          (l) => l,
          () => null,
        );
        const notifier = new PostgresEngine({ url: withDatabase(DIRECT!, dbName), max: 1 });
        try {
          await notifier.query("SELECT pg_notify($1, 'ping')", [channel]);
        } finally {
          await notifier.close();
        }
        await new Promise((r) => setTimeout(r, 1500));
        expect(heardDirect).toEqual(["ping"]);
        expect(heard).toEqual([]);
        await l1.unlisten();
        if (pooledListen) await pooledListen.unlisten().catch(() => {});
      } finally {
        await direct.end({ timeout: 5 });
        await pooled.end({ timeout: 5 });
      }
    });

    it("a TEMP TABLE is missing on the next server session; ON COMMIT DROP inside a transaction works", async () => {
      const a = client();
      const holder = client();
      const pidA = await backend(a);
      await a.exec("CREATE TEMP TABLE hazard_tmp (x int)");
      const { result, heldPid } = await whileHeld(holder, () =>
        a.query("SELECT count(*) FROM hazard_tmp").then(() => "found", (e: Error) => e.message));
      expect(heldPid).toBe(pidA);
      expect(result).toMatch(/hazard_tmp.*does not exist/);
      await a.exec("DISCARD TEMP");

      const n = await a.transaction(async (tx) => {
        await tx.exec("CREATE TEMP TABLE hazard_tx (x int) ON COMMIT DROP");
        await tx.exec("INSERT INTO hazard_tx VALUES (1), (2)");
        return (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM hazard_tx")).rows[0]!.n;
      });
      expect(n).toBe(2);
    });

    it("a WITH HOLD cursor is missing on the next server session", async () => {
      const a = client();
      const holder = client();
      const pidA = await backend(a);
      await a.exec("DECLARE hazard_cur CURSOR WITH HOLD FOR SELECT generate_series(1, 3) AS n");
      const { result, heldPid } = await whileHeld(holder, () =>
        a.query("FETCH 1 FROM hazard_cur").then(() => "fetched", (e: Error) => e.message));
      expect(heldPid).toBe(pidA);
      expect(result).toMatch(/hazard_cur.*does not exist/);
      await a.exec("CLOSE ALL");
    });

    it("DISCARD from one client wipes state another client put on the shared server session", async () => {
      const a = client();
      const b = client();
      const pidA = await backend(a);
      await a.exec("CREATE TEMP TABLE hazard_mine (x int)");
      expect(await backend(b)).toBe(pidA);
      await b.exec("DISCARD ALL");
      expect(await backend(a)).toBe(pidA);
      const r = await a.query("SELECT count(*) FROM hazard_mine").then(() => "found", (e: Error) => e.message);
      expect(r).toMatch(/hazard_mine.*does not exist/);
      // The pooler re-prepares its tracked statements after DISCARD ALL.
      expect((await a.query<{ n: number }>("SELECT $1::int AS n", [5])).rows[0]!.n).toBe(5);
    });
  });
}
