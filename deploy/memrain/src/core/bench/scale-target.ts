/**
 * Where `memrain bench scale` may write, and the load itself.
 *
 * THE BENCH ONLY WRITES INTO A DATABASE IT MADE. It creates
 * `memrain_bench_<16 hex>` itself and writes a random nonce into a marker table
 * there. Every write phase — migrations, the corpus load, the HNSW build —
 * first proves it is connected to that database with that nonce and that the
 * database holds nothing but bench rows (`assertBenchTarget`). The server of
 * any production URL in the environment is refused outright, before a
 * connection is opened, whatever flag the caller passed.
 */
import { randomBytes } from "node:crypto";
import { PostgresEngine } from "../engine/postgres.ts";
import type { Engine } from "../engine/interface.ts";
import { Storage } from "../storage.ts";
import { EMBEDDINGS_HNSW_SPEC, dropAndRebuild } from "../vector-index.ts";
import {
  BENCH_EMBED_MODEL,
  BENCH_SOURCE_ID,
  corpusBatches,
  corpusDigest,
  type CorpusSpec,
} from "./scale-corpus.ts";

const DB_PATTERN = /^memrain_bench_[0-9a-f]{16}$/;
const CONTAINER_PATTERN = /^memrain-scale-bench-[A-Za-z0-9][\w.-]*$/;
const MARKER_TABLE = "memrain_bench_marker";
/** `application_name` of every bench connection: no host or user names in pg_stat_activity. */
export const APP_NAME = "memrain-bench-scale";
/** Index builds and bulk loads outlive the interactive 30s statement timeout. */
const LOAD_STATEMENT_TIMEOUT_MS = 60 * 60_000;

/** Environment URLs that name a live database. Their servers are never a bench target. */
const PRODUCTION_URL_VARS = [
  "MEMRAIN_POSTGRES_URL",
  "MEMRAIN_POSTGRES_DIRECT_URL",
  "MEMRAIN_CONTROL_URL",
  "MEMEX_POSTGRES_URL",
] as const;

export type RefusalCode =
  | "bench_needs_scratch"
  | "bench_refuses_prod_url"
  | "bench_refuses_bad_url"
  | "bench_refuses_pglite"
  | "bench_refuses_foreign_db"
  | "bench_refuses_live_db"
  | "bench_refuses_container";

export class ScaleBenchRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(`memrain bench scale: ${message} (${code})`);
    this.name = "ScaleBenchRefusal";
  }
}

export type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** host:port of a Postgres URL, loopback spellings folded together. Null when unparsable. */
function serverOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
  const host = u.hostname.toLowerCase();
  return `${LOOPBACK.has(host) ? "loopback" : host}:${u.port || "5432"}`;
}

/** host:port for the report — never the credentials. */
export function displayServer(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "5432"}`;
}

/** Refuse `url` when it is on the same server as any production URL in `env`. */
export function assertNotProductionServer(url: string, env: Env): void {
  const target = serverOf(url);
  if (target === null) {
    throw new ScaleBenchRefusal("bench_refuses_bad_url", "not a postgres:// URL");
  }
  for (const name of PRODUCTION_URL_VARS) {
    const live = env[name];
    if (live && serverOf(live) === target) {
      throw new ScaleBenchRefusal(
        "bench_refuses_prod_url",
        `the target server is the one ${name} points at; the bench runs only on a throwaway server`,
      );
    }
  }
}

/** Only a container the bench script started may be restarted. */
export function assertBenchContainer(name: string): void {
  if (!CONTAINER_PATTERN.test(name)) {
    throw new ScaleBenchRefusal(
      "bench_refuses_container",
      "the container name does not start with memrain-scale-bench-; only the bench's own container is restarted",
    );
  }
}

/** `url` pointing at database `db`. */
export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export interface ScratchTarget {
  dbName: string;
  nonce: string;
  /** Connection URL of the scratch database (carries credentials; never reported). */
  url: string;
}

/**
 * Create `memrain_bench_<rand>` on the admin server and mark it with a fresh
 * nonce. The marker is the bench's proof of ownership: nothing else on any
 * server holds that table with that nonce.
 */
export async function createScratchDatabase(adminUrl: string, opts: { env: Env }): Promise<ScratchTarget> {
  assertNotProductionServer(adminUrl, opts.env);
  const dbName = `memrain_bench_${randomBytes(8).toString("hex")}`;
  const nonce = randomBytes(16).toString("hex");
  const admin = new PostgresEngine({ url: adminUrl, max: 1, applicationName: APP_NAME });
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.close();
  }
  const url = withDatabase(adminUrl, dbName);
  const e = new PostgresEngine({ url, max: 1, applicationName: APP_NAME });
  try {
    await e.query(`CREATE TABLE ${MARKER_TABLE} (nonce TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await e.query(`INSERT INTO ${MARKER_TABLE} (nonce) VALUES ($1)`, [nonce]);
  } finally {
    await e.close();
  }
  return { dbName, nonce, url };
}

/** Drop a database this run created. The name is re-checked, so nothing else can be dropped. */
export async function dropScratchDatabase(adminUrl: string, target: Pick<ScratchTarget, "dbName">): Promise<void> {
  if (!DB_PATTERN.test(target.dbName)) {
    throw new ScaleBenchRefusal("bench_refuses_foreign_db", "refusing to drop a database the bench did not name");
  }
  const admin = new PostgresEngine({ url: adminUrl, max: 1, applicationName: APP_NAME });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${target.dbName} WITH (FORCE)`);
  } finally {
    await admin.close();
  }
}

/**
 * The gate in front of every write: this engine is Postgres, connected to the
 * database the bench named, which carries this run's nonce and no page or
 * document from any source but the bench's.
 */
export async function assertBenchTarget(
  engine: Engine,
  target: Pick<ScratchTarget, "dbName" | "nonce">,
): Promise<void> {
  if (engine.kind !== "postgres") {
    throw new ScaleBenchRefusal("bench_refuses_pglite", "the bench runs only on its own Postgres database");
  }
  const db = (await engine.query<{ d: string }>("SELECT current_database() AS d")).rows[0]?.d;
  if (db !== target.dbName || !DB_PATTERN.test(db)) {
    throw new ScaleBenchRefusal("bench_refuses_foreign_db", "connected to a database the bench did not create");
  }
  const marker = await engine.query<{ ok: boolean }>(
    `SELECT to_regclass('${MARKER_TABLE}') IS NOT NULL AS ok`,
  );
  if (!marker.rows[0]?.ok) {
    throw new ScaleBenchRefusal("bench_refuses_foreign_db", "the database carries no bench marker");
  }
  const nonce = await engine.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${MARKER_TABLE} WHERE nonce = $1`,
    [target.nonce],
  );
  if (Number(nonce.rows[0]?.n ?? 0) !== 1) {
    throw new ScaleBenchRefusal("bench_refuses_foreign_db", "the bench marker holds another run's nonce");
  }
  for (const table of ["pages", "documents"]) {
    const exists = await engine.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table]);
    if (!exists.rows[0]?.ok) continue;
    const foreign = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE source_id IS DISTINCT FROM $1`,
      [BENCH_SOURCE_ID],
    );
    if (Number(foreign.rows[0]?.n ?? 0) > 0) {
      throw new ScaleBenchRefusal(
        "bench_refuses_live_db",
        `the database holds ${table} rows that are not the bench's; it is not a bench brain`,
      );
    }
  }
}

export interface BenchBrain {
  /** Long-timeout engine for migrations, the load and the index build. */
  engine: PostgresEngine;
}

/** Open the scratch database and migrate it — after the ownership check, and once more after. */
export async function openBenchBrain(target: ScratchTarget): Promise<BenchBrain> {
  const engine = new PostgresEngine({
    url: target.url,
    max: 2,
    statementTimeoutMs: LOAD_STATEMENT_TIMEOUT_MS,
    applicationName: APP_NAME,
  });
  try {
    await engine.ready();
    await assertBenchTarget(engine, target);
    await new Storage(engine).init();
    await assertBenchTarget(engine, target);
    await engine.query(
      `INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', '/bench/') ON CONFLICT (id) DO NOTHING`,
      [BENCH_SOURCE_ID],
    );
    return { engine };
  } catch (err) {
    await engine.close();
    throw err;
  }
}

export interface LoadStats {
  chunks: number;
  documents: number;
  corpusSha256: string;
  loadMs: number;
  hnswBuildMs: number;
}

/**
 * Bulk-load the corpus. The HNSW index is dropped first and built once at the
 * end with the production rebuild path; growing it row by row would measure
 * the loader, not the brain. ANALYZE last, as autovacuum would get to.
 */
export async function loadScaleCorpus(
  engine: PostgresEngine,
  target: Pick<ScratchTarget, "dbName" | "nonce">,
  spec: CorpusSpec,
): Promise<LoadStats> {
  await assertBenchTarget(engine, target);
  const t0 = performance.now();
  await engine.query(`DROP INDEX IF EXISTS ${EMBEDDINGS_HNSW_SPEC.name}`);
  let chunks = 0;
  let documents = 0;
  for (const batch of corpusBatches(spec)) {
    await engine.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO documents (id, source_id, source_path, title)
         SELECT d.id, $4, d.sp, d.t FROM unnest($1::text[], $2::text[], $3::text[]) AS d(id, sp, t)`,
        [batch.documents.map((d) => d.id), batch.documents.map((d) => d.sourcePath), batch.documents.map((d) => d.title), BENCH_SOURCE_ID],
      );
      await tx.query(
        `INSERT INTO chunks (id, document_id, chunk_index, content, source_id)
         SELECT c.id, c.doc, c.ix, c.body, $5 FROM unnest($1::text[], $2::text[], $3::int[], $4::text[]) AS c(id, doc, ix, body)`,
        [
          batch.chunks.map((c) => c.id),
          batch.chunks.map((c) => c.documentId),
          batch.chunks.map((c) => c.chunkIndex),
          batch.chunks.map((c) => c.content),
          BENCH_SOURCE_ID,
        ],
      );
      await tx.query(
        `INSERT INTO embeddings (chunk_id, vector, model, embedding_signature)
         SELECT e.id, e.v::vector, $3, $3 FROM unnest($1::text[], $2::text[]) AS e(id, v)`,
        [batch.chunks.map((c) => c.id), batch.chunks.map((c) => c.vector), BENCH_EMBED_MODEL],
      );
    });
    chunks += batch.chunks.length;
    documents += batch.documents.length;
  }
  const loadMs = performance.now() - t0;
  await assertBenchTarget(engine, target);
  const t1 = performance.now();
  await dropAndRebuild(engine, EMBEDDINGS_HNSW_SPEC, { reason: "bench-scale", force: true });
  const hnswBuildMs = performance.now() - t1;
  await engine.query("ANALYZE");
  return { chunks, documents, corpusSha256: corpusDigest(spec), loadMs, hnswBuildMs };
}
