/**
 * The fact-withdraw lock keeps its pre-rename key, so an old writer and the
 * migration 120 trigger (and a new writer and the old trigger) still meet on
 * one advisory lock. Two real Postgres connections, ordered by watching
 * pg_locks for the waiter rather than by sleeping. Postgres-only: needs
 * MEMRAIN_TEST_POSTGRES_URL (a scratch database is created per run). The key
 * text itself is checked on every run.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres, { type Sql } from "postgres";
import { runMigrations } from "../src/core/migrate.ts";
import { pgTestEngine } from "./helpers/pg-test-engine.ts";
import { lockWithdrawals, withdrawLockKey } from "../src/core/fact-withdrawals.ts";
import { openPostgres119, PG_URL, type Db } from "./helpers/migration-120.ts";

describe("withdrawLockKey", () => {
  it("is the pre-rename key text for every source id", () => {
    for (const id of ["default", "tenant-a", "a:b", "ünï", "", "x".repeat(300)]) {
      expect(withdrawLockKey(id)).toBe(`memex:fact-withdraw:${id}`);
    }
  });
});

describe.skipIf(!PG_URL)("fact-withdraw lock across the rename (Postgres)", () => {
  let db: Db & { url: string };
  let a: Sql;
  let b: Sql;
  let observer: Sql;

  beforeAll(async () => {
    db = (await openPostgres119(PG_URL!)) as Db & { url: string };
    await runMigrations(db.engine);
    const conn = () => postgres(db.url, { max: 1, onnotice: () => {} });
    a = conn();
    b = conn();
    observer = conn();
  });
  afterAll(async () => {
    await Promise.all([a.end({ timeout: 5 }), b.end({ timeout: 5 }), observer.end({ timeout: 5 })]);
    await db.close();
  });

  /** Resolves once some session waits for `mode` on the advisory key `key`. */
  async function waiterOn(key: string, mode: "ShareLock" | "ExclusiveLock"): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const r = await observer`
        SELECT 1 FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted AND mode = ${mode}
           AND objid::bigint = (hashtext(${key})::bigint & 4294967295)`;
      if (r.length > 0) return;
      if (Date.now() > deadline) throw new Error(`no ${mode} waiter on ${key}`);
      await new Promise((res) => setTimeout(res, 5));
    }
  }

  function gate(): { open: () => void; wait: Promise<void> } {
    let open!: () => void;
    const wait = new Promise<void>((res) => (open = res));
    return { open, wait };
  }

  const insertFact = (sql: Sql, source: string, fact: string) =>
    sql<{ forgotten: boolean; id: number }[]>`
      INSERT INTO entity_facts (entity_slug, fact, source_id)
      VALUES ('people/race', ${fact}, ${source})
      RETURNING id, forgotten_at IS NOT NULL AS forgotten`;

  async function source(id: string): Promise<void> {
    await observer`INSERT INTO sources (id, kind, path_prefix) VALUES (${id}, 'other', ${`${id}/`}) ON CONFLICT DO NOTHING`;
  }

  it("(a) a v1.163 forget holding the lock blocks the 120 trigger; the insert lands forgotten", async () => {
    const src = "race-a";
    await source(src);
    const key = `memex:fact-withdraw:${src}`;
    const locked = gate();
    const release = gate();
    const writer = a.begin(async (tx) => {
      await tx`INSERT INTO fact_withdrawals (source_id, visibility, entity_slug, claim_key, reason)
               VALUES (${src}, 'private', 'people/race', memex_fact_claim_key('Sails boats'), 'user')`;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      locked.open();
      await release.wait;
    });
    await locked.wait;
    let settled = false;
    const insert = insertFact(b, src, "sails  BOATS").then((r) => {
      settled = true;
      return r;
    });
    await waiterOn(key, "ShareLock");
    expect(settled).toBe(false);
    release.open();
    await writer;
    expect((await insert)[0]!.forgotten).toBe(true);
  });

  it("(b) an insert holding the shared lock is retired by the v1.163 forget's post-grant sweep", async () => {
    const src = "race-b";
    await source(src);
    const key = `memex:fact-withdraw:${src}`;
    const inserted = gate();
    const release = gate();
    let rowId = 0;
    const inserter = b.begin(async (tx) => {
      const r = await insertFact(tx as unknown as Sql, src, "Keeps bees");
      rowId = r[0]!.id;
      expect(r[0]!.forgotten).toBe(false);
      inserted.open();
      await release.wait;
    });
    await inserted.wait;
    const sweep = (tx: Sql) => tx`
      UPDATE entity_facts
         SET forgotten_at = NOW(), forgotten_cause = 'forget', forgotten_reason = 'withdrawn'
       WHERE source_id = ${src} AND visibility = 'private' AND entity_slug = 'people/race'
         AND memex_fact_claim_key(fact) = memex_fact_claim_key('keeps bees')
         AND forgotten_at IS NULL AND dimension IS NULL
       RETURNING id`;
    const writer = a.begin(async (tx) => {
      await tx`INSERT INTO fact_withdrawals (source_id, visibility, entity_slug, claim_key, reason)
               VALUES (${src}, 'private', 'people/race', memex_fact_claim_key('keeps bees'), 'user')`;
      const early = await sweep(tx as unknown as Sql);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const late = await sweep(tx as unknown as Sql);
      return { early: early.length, late: late.map((r) => r.id) };
    });
    await waiterOn(key, "ExclusiveLock");
    release.open();
    await inserter;
    const r = await writer;
    expect(r.early).toBe(0);
    expect(r.late).toEqual([rowId]);
  });

  it("(c) the new TS lockWithdrawals blocks the legacy trigger function, re-attached", async () => {
    const src = "race-c";
    await source(src);
    const key = withdrawLockKey(src);
    await observer.unsafe(`
      DROP TRIGGER entity_facts_withdrawn_on_insert ON entity_facts;
      CREATE TRIGGER entity_facts_withdrawn_on_insert BEFORE INSERT ON entity_facts FOR EACH ROW
        WHEN (NEW.forgotten_at IS NULL AND NEW.dimension IS NULL)
        EXECUTE FUNCTION memex_fact_withdrawn_on_insert();`);
    const engine = pgTestEngine({ url: db.url, max: 1 });
    try {
      const locked = gate();
      const release = gate();
      const writer = engine.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO fact_withdrawals (source_id, visibility, entity_slug, claim_key, reason)
           VALUES ($1, 'private', 'people/race', memrain_fact_claim_key('Climbs rocks'), 'user')`,
          [src],
        );
        await lockWithdrawals(tx, [src]);
        locked.open();
        await release.wait;
      });
      await locked.wait;
      let settled = false;
      const insert = insertFact(b, src, "climbs rocks").then((r) => {
        settled = true;
        return r;
      });
      await waiterOn(key, "ShareLock");
      expect(settled).toBe(false);
      release.open();
      await writer;
      expect((await insert)[0]!.forgotten).toBe(true);
    } finally {
      await engine.close();
      await observer.unsafe(`
        DROP TRIGGER entity_facts_withdrawn_on_insert ON entity_facts;
        CREATE TRIGGER entity_facts_withdrawn_on_insert BEFORE INSERT ON entity_facts FOR EACH ROW
          WHEN (NEW.forgotten_at IS NULL AND NEW.dimension IS NULL)
          EXECUTE FUNCTION memrain_fact_withdrawn_on_insert();`);
    }
  });
});
