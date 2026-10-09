/**
 * Shared fixture for the migration 120 tests: a database migrated through 119
 * and seeded with the data a pre-rename brain holds, on PGLite and, when
 * MEMRAIN_TEST_POSTGRES_URL is set, on a scratch Postgres database of its own
 * (created and dropped here, so the shared test database is never reverted).
 * Manifests come from the shipped data-manifest.sql: psql on Postgres, the
 * test runner on PGLite.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../../src/core/engine/pglite.ts";
import { PostgresEngine } from "../../src/core/engine/postgres.ts";
import type { Engine } from "../../src/core/engine/interface.ts";
import { runMigrations } from "../../src/core/migrate.ts";
import { MANIFEST_SQL, runManifestScript } from "./manifest-script.ts";

export const PG_URL = process.env.MEMRAIN_TEST_POSTGRES_URL;
export const MIGRATIONS_DIR = join(import.meta.dir, "../../src/core/migrations");
export const UP_120_FILE = join(MIGRATIONS_DIR, "120_memrain_rename.sql");
export const DOWN_120_FILE = join(import.meta.dir, "../../src/core/migrations-down/120_memrain_rename.down.sql");
export const UP_120_SQL = readFileSync(UP_120_FILE, "utf8");
export const DOWN_120_SQL = readFileSync(DOWN_120_FILE, "utf8");

/** The lines migration 120 may change, as the upgrade guide filters them. */
export const EXPECTED_120 =
  /^(?:table\tmigrations\t|function\tmemrain_fact_|trigger\tentity_facts\.entity_facts_withdrawn_on_insert\t)/;

/** A directory holding the shipped migrations up to `maxId` (symlinks). */
export function migrationsThrough(maxId: number): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mig-through-"));
  for (const f of readdirSync(MIGRATIONS_DIR)) {
    const m = /^(\d+)_/.exec(f);
    if (m && Number(m[1]) <= maxId) symlinkSync(join(MIGRATIONS_DIR, f), join(dir, f));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Apply the shipped migrations up to and including 120, and no later one: the
 * 120 down refuses unless 120 is the latest applied migration.
 */
export async function migrateTo120(e: Engine): ReturnType<typeof runMigrations> {
  const through = migrationsThrough(120);
  try {
    return await runMigrations(e, through.dir);
  } finally {
    through.cleanup();
  }
}

export interface Db {
  kind: "pglite" | "postgres";
  /** Current engine; `reopen()` replaces it, so read it each time. */
  engine: Engine;
  manifest: () => Promise<string>;
  /** Run the down file as `psql -1 -f` does: one transaction, nothing else. */
  runDownFile: () => Promise<void>;
  /** Close and open the engine again (Postgres: frees its connection). */
  reopen: () => Promise<void>;
  close: () => Promise<void>;
}

function psql(url: string, args: string[]): string {
  const bin = Bun.which("psql");
  if (!bin) throw new Error("psql not found: the Postgres run of the migration 120 tests needs it");
  const r = Bun.spawnSync([bin, url, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args]);
  if (r.exitCode !== 0) throw new Error(`psql exited ${r.exitCode}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

export function psqlManifest(url: string): string {
  return psql(url, ["-A", "-t", "-f", MANIFEST_SQL]);
}

export async function openPglite119(): Promise<Db> {
  const tmp = mkdtempSync(join(tmpdir(), "mig120-"));
  const through = migrationsThrough(119);
  const open = async () => {
    const e = new PGliteEngine({ dbPath: join(tmp, "db") });
    await e.ready();
    return e;
  };
  // The sharded runner's template is migrated through the latest file; this
  // database must stop at 119.
  const template = process.env.MEMRAIN_TEST_PGLITE_TEMPLATE;
  delete process.env.MEMRAIN_TEST_PGLITE_TEMPLATE;
  let engine: PGliteEngine;
  try {
    engine = await open();
  } finally {
    if (template !== undefined) process.env.MEMRAIN_TEST_PGLITE_TEMPLATE = template;
  }
  try {
    await runMigrations(engine, through.dir);
  } finally {
    through.cleanup();
  }
  const db: Db = {
    kind: "pglite",
    engine,
    manifest: () => runManifestScript(engine.raw()),
    runDownFile: () => engine.transaction(async (tx) => tx.exec(DOWN_120_SQL)),
    reopen: async () => {
      await engine.close();
      engine = await open();
      db.engine = engine;
    },
    close: async () => {
      await engine.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
  return db;
}

/** A fresh database on the server `baseUrl` points at, migrated through 119. */
export async function openPostgres119(baseUrl: string): Promise<Db> {
  const name = `mig120_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
  const admin = new PostgresEngine({ url: baseUrl, max: 1 });
  await admin.exec(`CREATE DATABASE ${name}`);
  await admin.close();
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  // One connection: the down refuses while another session is open, so the
  // fixture's own pool must not hold a second one.
  const open = async () => {
    const e = new PostgresEngine({ url, max: 1 });
    await e.ready();
    return e;
  };
  let engine = await open();
  const through = migrationsThrough(119);
  try {
    await runMigrations(engine, through.dir);
  } finally {
    through.cleanup();
  }
  const db: Db & { url: string } = {
    kind: "postgres",
    url,
    engine,
    manifest: async () => psqlManifest(url),
    runDownFile: async () => {
      await engine.close();
      try {
        psql(url, ["-1", "-f", DOWN_120_FILE]);
      } finally {
        engine = await open();
        db.engine = engine;
      }
    },
    reopen: async () => {
      await engine.close();
      engine = await open();
      db.engine = engine;
    },
    close: async () => {
      await engine.close();
      const a = new PostgresEngine({ url: baseUrl, max: 1 });
      try {
        await a.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.close();
      }
    },
  };
  return db;
}

export const vec = (x: number) => `[${Array.from({ length: 1024 }, () => String(x)).join(",")}]`;

/**
 * What a pre-rename brain holds: legacy facts and takes fences, fence-projected
 * and add_fact facts with embeddings, a forgotten claim with its withdrawal,
 * runtime_config rows, OAuth and PAT rows (expired ones included, which a boot
 * token sweep would delete), live and stale legacy lock rows, and an advanced
 * sequence.
 */
export async function seedLegacy(e: Engine): Promise<void> {
  const past = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
  const future = past + 10 * 365 * 86400;
  await e.exec(`
    INSERT INTO sources (id, kind, path_prefix) VALUES ('tenant-a', 'other', 'tenant-a/');
    INSERT INTO pages (slug, type, title, content_hash, markdown_body, updated_at) VALUES
      ('people/alice', 'person', 'Alice', 'h1',
       E'# Alice\\n\\n<!--- memex:facts:begin -->\\n| # | claim |\\n|---|---|\\n| 1 | Lives in Paris |\\n<!--- memex:facts:end -->\\n',
       '2026-01-01 00:00:00+00'),
      ('notes/takes', 'note', 'Takes', 'h2',
       E'# Takes\\n\\n<!--- memex:takes:begin -->\\n| # | claim |\\n|---|---|\\n| 1 | Rates rise |\\n<!--- memex:takes:end -->\\n',
       '2026-01-01 00:00:00+00');
    INSERT INTO entity_facts (entity_slug, fact, written_by, source_markdown_slug, row_num, written_at)
      VALUES ('people/alice', 'Lives in Paris', 'memex:facts-fence', 'people/alice', 1, '2026-01-01 00:00:00+00');
    INSERT INTO entity_facts (entity_slug, fact, embedding, written_at)
      VALUES ('people/alice', 'Plays chess', '${vec(0.25)}', '2026-01-01 00:00:00+00');
    INSERT INTO entity_facts (entity_slug, fact, source_id, written_at, forgotten_at, forgotten_cause, forgotten_reason)
      VALUES ('people/alice', 'Owns a  Boat', 'tenant-a', '2026-01-01 00:00:00+00',
              '2026-01-02 00:00:00+00', 'forget', 'user');
    INSERT INTO fact_withdrawals (source_id, visibility, entity_slug, claim_key, reason, created_at)
      VALUES ('tenant-a', 'private', 'people/alice', memex_fact_claim_key('Owns a  Boat'), 'user', '2026-01-02 00:00:00+00');
    INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id,
                             generated_at, resolved_by)
      VALUES ('k1', 'notes/takes', 'h', 'v1', 'Rates rise', 'm', '2026-01-01 00:00:00+00', 'memex:grade_takes');
    INSERT INTO runtime_config (key, value, updated_at) VALUES
      ('MEMEX_A', '1', '2026-01-01 00:00:00+00'), ('OTHER_KEY', 'x', '2026-01-01 00:00:00+00');
    INSERT INTO oauth_clients (client_id, client_name, created_at)
      VALUES ('memex_cl_fixture', 'fixture', '2026-01-01 00:00:00+00');
    INSERT INTO oauth_tokens (token_hash, token_type, client_id, expires_at, created_at) VALUES
      ('${"a".repeat(64)}', 'access', 'memex_cl_fixture', ${future}, '2026-01-01 00:00:00+00'),
      ('${"b".repeat(64)}', 'access', 'memex_cl_fixture', ${past}, '2026-01-01 00:00:00+00');
    INSERT INTO oauth_codes (code_hash, client_id, code_challenge, redirect_uri, expires_at, created_at)
      VALUES ('${"c".repeat(64)}', 'memex_cl_fixture', 'ch', 'https://client.example.com/cb', ${past}, '2026-01-01 00:00:00+00');
    INSERT INTO oauth_refresh_consumed (token_hash, family_id, client_id, consumed_at, expires_at)
      VALUES ('${"d".repeat(64)}', 'fam', 'memex_cl_fixture', ${past - 60}, ${past});
    INSERT INTO access_tokens (name, token_hash) VALUES ('pat', '${"e".repeat(64)}');
    INSERT INTO cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at) VALUES
      ('memex-cycle', 1, 'old-host', '2026-01-01 00:00:00+00', '2999-01-01 00:00:00+00'),
      ('memex-cycle:embed', 2, 'old-host', '2026-01-01 00:00:00+00', '2026-01-01 00:30:00+00');
    INSERT INTO worker_lock (id, holder, acquired_at, heartbeat_at, ttl_seconds)
      VALUES ('memex-jobs-worker', 'old', '2026-01-01 00:00:00+00', '2999-01-01 00:00:00+00', 60);
    SELECT setval('entity_facts_id_seq', 500);
  `);
}

/** Keys (`kind\tname`) whose line differs between two manifests. */
export function changedKeys(a: string, b: string): string[] {
  const byKey = (out: string) => {
    const m = new Map<string, string>();
    for (const line of out.trimEnd().split("\n")) {
      const [kind, name = ""] = line.split("\t");
      m.set(`${kind}\t${name}`, line);
    }
    return m;
  };
  const ma = byKey(a);
  const mb = byKey(b);
  return [...new Set([...ma.keys(), ...mb.keys()])].filter((k) => ma.get(k) !== mb.get(k)).sort();
}

/** The manifest without the lines 120 may change (the guide's `grep -Ev`). */
export function withoutExpected(out: string): string {
  return out.split("\n").filter((l) => !EXPECTED_120.test(l)).join("\n");
}

/** Run `fn` in a transaction that is always rolled back; return its result. */
export async function rolledBack<T>(e: Engine, fn: (tx: Engine) => Promise<T>): Promise<T> {
  class Rollback extends Error {
    constructor(readonly value: T) {
      super("rollback");
    }
  }
  try {
    await e.transaction(async (tx) => {
      throw new Rollback(await fn(tx));
    });
  } catch (err) {
    if (err instanceof Rollback) return err.value;
    throw err;
  }
  throw new Error("unreachable");
}

/** Every Engine the fixtures cover in this run: PGLite always, Postgres when configured. */
export const ENGINES: Array<{ name: string; open: () => Promise<Db> }> = [
  { name: "PGLite", open: openPglite119 },
  ...(PG_URL ? [{ name: "Postgres", open: () => openPostgres119(PG_URL) }] : []),
];
