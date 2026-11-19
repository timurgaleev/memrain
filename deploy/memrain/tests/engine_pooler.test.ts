/**
 * Pooler mode (MEMRAIN_PG_POOLER=pgbouncer). A transaction-mode pooler passes
 * no session startup parameter through and hands each transaction a different
 * server session, so in that mode the engine sends no timeouts at connect (the
 * tenant roles carry them), refuses a login role, and runs migrations and any
 * DDL only over MEMRAIN_POSTGRES_DIRECT_URL. With the flag unset the options
 * postgres-js receives are exactly what they were before pooler mode existed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { buildPostgresOptions, PostgresEngine } from "../src/core/engine/postgres.ts";
import { makeEngine } from "../src/core/engine/factory.ts";
import { PoolerMigrationRefusedError, withDirectEngine } from "../src/core/engine/direct.ts";
import type { Engine, QueryResult } from "../src/core/engine/interface.ts";
import { revertMigration, runMigrations } from "../src/core/migrate.ts";
import { Storage } from "../src/core/storage.ts";
import type { Config } from "../src/core/config.ts";

const ENV = [
  "MEMRAIN_PG_POOLER",
  "MEMRAIN_PG_PREPARE",
  "MEMRAIN_POSTGRES_DIRECT_URL",
  "MEMRAIN_POSTGRES_URL",
  "MEMRAIN_PG_POOL_MAX",
  "MEMRAIN_PG_STATEMENT_TIMEOUT_MS",
  "MEMRAIN_PG_APPLICATION_NAME",
];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

const URL_ = "postgres://u:p@db.invalid:5432/brain?sslmode=require";
const PG_CONFIG = { database: { type: "postgres", url: URL_ } } as unknown as Config;

/** The options with the notice handler swapped for a marker, so they compare as data. */
function plain(o: ReturnType<typeof buildPostgresOptions>): Record<string, unknown> {
  expect(typeof o.onnotice).toBe("function");
  return { ...o, onnotice: "fn" };
}

describe("postgres-js options without a pooler", () => {
  it("are byte-for-byte the options the engine always sent", () => {
    expect(plain(buildPostgresOptions({ url: URL_ }))).toEqual({
      max: 10,
      ssl: "require",
      idle_timeout: 30,
      connect_timeout: 10,
      connection: { statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000 },
      onnotice: "fn",
    });
    expect(plain(buildPostgresOptions({
      url: "postgres://u:p@h/db?sslmode=disable",
      max: 4,
      statementTimeoutMs: 5_000,
      applicationName: "memrain:acme:serve",
      role: "tenant_acme_owner",
    }))).toEqual({
      max: 4,
      ssl: false,
      idle_timeout: 30,
      connect_timeout: 10,
      connection: {
        statement_timeout: 5_000,
        idle_in_transaction_session_timeout: 60_000,
        application_name: "memrain:acme:serve",
        role: "tenant_acme_owner",
      },
      onnotice: "fn",
    });
  });

  it("the factory ignores the pooler-only knobs while the pooler is off", () => {
    process.env["MEMRAIN_PG_PREPARE"] = "0";
    process.env["MEMRAIN_POSTGRES_DIRECT_URL"] = "postgres://u:p@direct.invalid/brain";
    const e = makeEngine(PG_CONFIG) as PostgresEngine;
    try {
      expect(e.pooler).toBeUndefined();
      expect(plain(e.options())).toEqual(plain(buildPostgresOptions({ url: URL_ })));
    } finally {
      void e.close();
    }
  });
});

describe("pooler mode", () => {
  it("sends no session startup parameter but application_name", () => {
    const o = buildPostgresOptions({ url: URL_, pooler: "pgbouncer", applicationName: "memrain:acme:serve" });
    expect(o.connection).toEqual({ application_name: "memrain:acme:serve" });
    expect("prepare" in o).toBe(false);
  });

  it("turns prepared statements off only when asked", () => {
    expect(buildPostgresOptions({ url: URL_, pooler: "pgbouncer", prepare: false }).prepare).toBe(false);
  });

  it("refuses a login role, which only a session can hold", () => {
    expect(() => new PostgresEngine({ url: URL_, pooler: "pgbouncer", role: "tenant_acme_owner" }))
      .toThrow(/pooler/);
  });

  it("the factory reads MEMRAIN_PG_POOLER, MEMRAIN_PG_PREPARE and the direct URL", () => {
    process.env["MEMRAIN_PG_POOLER"] = "pgbouncer";
    process.env["MEMRAIN_PG_PREPARE"] = "0";
    process.env["MEMRAIN_POSTGRES_DIRECT_URL"] = "postgres://u:p@direct.invalid/brain";
    const e = makeEngine(PG_CONFIG) as PostgresEngine;
    try {
      expect(e.pooler).toBe("pgbouncer");
      expect(e.options().prepare).toBe(false);
      expect(e.options().connection).toEqual({});
    } finally {
      void e.close();
    }
  });

  it("the factory refuses a pooler it does not know", () => {
    process.env["MEMRAIN_PG_POOLER"] = "pgcat";
    expect(() => makeEngine(PG_CONFIG)).toThrow(/MEMRAIN_PG_POOLER/);
  });
});

/** An engine that records every statement and answers none of them. */
function recordingEngine(pooler?: "pgbouncer"): Engine & { sql: string[] } {
  const sql: string[] = [];
  const e: Engine & { sql: string[] } = {
    kind: "postgres",
    sql,
    async ready() { sql.push("<ready>"); },
    async query<T>(text: string): Promise<QueryResult<T>> { sql.push(text); return { rows: [] }; },
    async exec(text: string) { sql.push(text); },
    async close() {},
    async transaction<T>(fn: (tx: Engine) => Promise<T>) { return fn(e); },
  };
  if (pooler) Object.assign(e, { pooler });
  return e;
}

describe("migrations through a pooler", () => {
  it("runMigrations refuses a pooled engine before any SQL", async () => {
    const e = recordingEngine("pgbouncer");
    const err = await runMigrations(e).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(PoolerMigrationRefusedError);
    expect((err as PoolerMigrationRefusedError).code).toBe("pooler_migration_refused");
    expect(e.sql).toEqual([]);
  });

  it("revertMigration refuses a pooled engine before any SQL", async () => {
    const e = recordingEngine("pgbouncer");
    await expect(revertMigration(e, 175)).rejects.toBeInstanceOf(PoolerMigrationRefusedError);
    expect(e.sql).toEqual([]);
  });

  it("Storage.init without a direct URL refuses before the first SQL", async () => {
    const e = recordingEngine("pgbouncer");
    const err = await new Storage(e).init().catch((x: unknown) => x);
    expect(err).toBeInstanceOf(PoolerMigrationRefusedError);
    expect(e.sql).toEqual([]);
  });

  it("a pooled PostgresEngine without a direct URL is refused before it connects", async () => {
    const e = new PostgresEngine({ url: "postgres://u:p@127.0.0.1:1/brain?sslmode=disable", pooler: "pgbouncer" });
    try {
      await expect(new Storage(e).init()).rejects.toBeInstanceOf(PoolerMigrationRefusedError);
    } finally {
      await e.close();
    }
  });

  it("withDirectEngine hands a direct engine over the direct URL and closes it", async () => {
    const pooled = new PostgresEngine({
      url: "postgres://u:p@pooler.invalid:6432/brain?sslmode=disable",
      pooler: "pgbouncer",
      directUrl: "postgres://u:p@direct.invalid:5432/brain?sslmode=disable",
      applicationName: "memrain:acme:serve",
    });
    let seen: PostgresEngine | null = null;
    try {
      await withDirectEngine(pooled, async (d) => {
        seen = d as PostgresEngine;
        expect(d).not.toBe(pooled);
        expect(d.pooler).toBeUndefined();
        expect((d as PostgresEngine).options().connection).toMatchObject({
          statement_timeout: 30_000,
          application_name: "memrain:acme:serve",
        });
      });
      expect(seen).not.toBeNull();
    } finally {
      await pooled.close();
    }
  });

  it("withDirectEngine passes an unpooled engine through", async () => {
    const e = recordingEngine();
    expect(await withDirectEngine(e, async (d) => d)).toBe(e);
  });
});

describe("pending migrations are checked before any DDL", () => {
  it("a fully migrated database sees no DDL at all", async () => {
    const { discoverMigrations } = await import("../src/core/migrate.ts");
    const ids = discoverMigrations().map((m) => ({ id: m.id }));
    const sql: string[] = [];
    const e: Engine = {
      kind: "postgres",
      async ready() {},
      async query<T>(text: string): Promise<QueryResult<T>> {
        sql.push(text);
        if (/to_regclass/.test(text)) return { rows: [{ present: true, named: true }] as T[] };
        if (/FROM migrations/.test(text)) return { rows: ids as T[] };
        return { rows: [] };
      },
      async exec(text: string) { sql.push(text); },
      async close() {},
      async transaction<T>(fn: (tx: Engine) => Promise<T>) { return fn(e); },
    };
    const r = await runMigrations(e);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toBe(ids.length);
    expect(sql.filter((s) => /\b(CREATE|ALTER|DROP)\b/i.test(s))).toEqual([]);
  });
});
