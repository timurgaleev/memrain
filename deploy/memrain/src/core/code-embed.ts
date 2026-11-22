/**
 * Code chunk vectors: what a code chunk is embedded from, the dollar cap a run
 * of code embeds is held to, and how many vectors the database can still take.
 *
 * The code indexer and `memrain embed --code` both embed through
 * `codeEmbeddingInput`, so a vector the backfill writes carries the same input
 * hash (migration 187) the indexer would compute, and a later re-index reuses
 * it instead of paying again.
 *
 * Code embedding is opt-in: `MEMRAIN_CODE_EMBED_MAX_USD` defaults to 0. Every
 * code vector is also a row in the HNSW index, and on a small Postgres server
 * that index must stay inside shared_buffers or every vector search reads it
 * from disk; a run that would outgrow it stops (`readVectorIndexBudget`).
 */
import { worstCaseUsd } from "./budget.ts";
import type { Engine } from "./engine/interface.ts";
import { EMBED_DIMENSIONS } from "./embedding.ts";
import { embeddingVectorType } from "./embedding-column.ts";
import { wellFormForText } from "./well-form.ts";

/**
 * Longest code embedding input, in UTF-8 bytes. Titan v2 takes 8,192 tokens
 * and its tokenizer never makes more tokens than bytes, so a byte cap under
 * that holds for dense text too (hex, base64, minified code, CJK), where a
 * character cap does not.
 *
 * Past the cap the tail of a symbol is not embedded: a vector query cannot
 * reach the end of a very long function. Splitting it into more chunks would
 * keep it reachable at the price of more vectors, and vector rows are what a
 * small database runs out of first, so the cut is kept on purpose. A class
 * chunk leaves its methods out (each method is its own chunk), so the cut
 * only meets single long symbols.
 */
export const CODE_EMBED_MAX_BYTES = 8_000;

/**
 * A model refusal of a code chunk's text repeats on every try (the input is
 * deterministic), so `memrain embed --code` tries such a chunk once and then
 * walks past it; a re-index of its file starts it again at zero.
 */
export const CODE_EMBED_MAX_FAILURES = 1;

/** What a code chunk's embedding input is built from: the stored chunk and its symbol. */
export interface CodeEmbedChunk {
  /** The chunk text as written (or `chunks.content`). */
  text: string;
  sourcePath: string;
  language?: string | null;
  symbolName?: string | null;
  symbolType?: string | null;
  parentSymbolPath?: readonly string[] | null;
  docComment?: string | null;
}

const LANGUAGE_LABELS: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TSX",
  python: "Python",
  bash: "Bash",
  go: "Go",
  sql: "SQL",
};

/**
 * Path segments kept in the header. Source paths are absolute host paths; the
 * install prefix (`/opt/...`, a home directory) says nothing about the code and
 * would tie every vector's input hash to where the checkout lives.
 */
const HEADER_PATH_SEGMENTS = 4;

function headerPath(sourcePath: string): string {
  return sourcePath.split("/").filter((p) => p.length > 0).slice(-HEADER_PATH_SEGMENTS).join("/");
}

/**
 * The line in front of a code chunk's text: language, file, symbol kind and
 * name, and the enclosing scope, e.g. `[TypeScript] memrain/src/core/repo.ts
 * method save (in Repo)`. No line numbers: an edit above the symbol leaves its
 * input, and so its stored vector, valid.
 */
function codeEmbeddingHeader(chunk: CodeEmbedChunk): string {
  const lang = chunk.language ? (LANGUAGE_LABELS[chunk.language] ?? chunk.language) : "Code";
  let header = `[${lang}] ${headerPath(chunk.sourcePath)}`;
  if (chunk.symbolType) {
    const named = chunk.symbolName && chunk.symbolType !== "module" ? ` ${chunk.symbolName}` : "";
    header += ` ${chunk.symbolType}${named}`;
  }
  const parents = chunk.symbolType === "module" ? [] : (chunk.parentSymbolPath ?? []);
  if (parents.length > 0) header += ` (in ${parents.join(".")})`;
  return header;
}

/** Text with its blank runs folded: a class chunk keeps an empty line where each method was cut out. */
function foldBlankLines(text: string): string {
  return text.replace(/\n[ \t]*(?=\n)/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** `text` cut on a code point at CODE_EMBED_MAX_BYTES UTF-8 bytes. */
function capBytes(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= CODE_EMBED_MAX_BYTES) return text;
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > CODE_EMBED_MAX_BYTES) break;
    bytes += size;
    end += ch.length;
  }
  return text.slice(0, end);
}

/**
 * The embedding input for a code chunk: the header, then the doc comment when
 * the body does not already hold it (a JS/TS comment sits above the
 * declaration; a Python docstring is inside it), then the body with blank runs
 * folded. Every part is well-formed exactly as the chunk is stored (indexer-tx
 * sanitizes NUL and lone surrogates), so building it from the chunk about to
 * be written or from the stored row gives the same string. Cut on a code point
 * at CODE_EMBED_MAX_BYTES. Empty when the body is blank.
 */
export function codeEmbeddingInput(chunk: CodeEmbedChunk): string {
  const body = wellFormForText(chunk.text);
  if (body.trim().length === 0) return "";
  const doc = chunk.docComment ? wellFormForText(chunk.docComment).trim() : "";
  const lead = doc.length > 0 && !body.includes(doc) ? `${doc}\n` : "";
  const header = wellFormForText(codeEmbeddingHeader(chunk));
  return capBytes(`${header}\n\n${lead}${foldBlankLines(body)}`);
}

/**
 * Per-run cap for code embeds written by the sweep / `memrain index` (USD,
 * worst case). Zero: code chunks are indexed without vectors unless the
 * operator turns embedding on.
 */
export const DEFAULT_CODE_EMBED_MAX_USD = 0;

/**
 * `MEMRAIN_CODE_EMBED_MAX_USD`: how much one code sweep (or one `memrain index`
 * of a code file) may reserve for embeddings, priced at the worst case. `0`,
 * the default, stops the sweep paying at all; its chunks then wait for `memrain
 * embed --code`. A malformed value falls back to the default.
 */
export function codeEmbedMaxUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMRAIN_CODE_EMBED_MAX_USD?.trim();
  if (!raw) return DEFAULT_CODE_EMBED_MAX_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CODE_EMBED_MAX_USD;
}

/** Bytes an HNSW graph element takes beyond its stored vector (measured: 565 B on 1024-dim vectors, rounded up). */
const HNSW_ELEMENT_OVERHEAD_BYTES = 640;
/** Headroom on the per-element estimate. */
const HNSW_SIZE_HEADROOM = 1.1;

function hnswRowBytes(vectorBytes: number): number {
  return (vectorBytes + HNSW_ELEMENT_OVERHEAD_BYTES) * HNSW_SIZE_HEADROOM;
}

/** The size (MB) of an HNSW index over `rows` vectors of `vectorBytes` each, with 10% headroom. */
export function hnswIndexMb(rows: number, vectorBytes: number): number {
  return Math.ceil(rows * hnswRowBytes(vectorBytes) / (1024 * 1024));
}

/** How many vectors the embeddings index holds and how many more fit the database cache. */
export interface VectorIndexBudget {
  /** Vectors stored now (the planner's estimate on an analyzed table). */
  rows: number;
  /** Bytes per stored vector: halfvec 2 per dimension, vector 4, plus the 8-byte header. */
  vectorBytes: number;
  /** shared_buffers in bytes; null where no cache bound applies (PGLite) or it could not be read. */
  cacheBytes: number | null;
  /** New vectors that still keep the index inside the cache; null when unbounded. */
  headroomRows: number | null;
}

let cacheBytesForTests: number | null | undefined;

/** Test seam: pretend the database cache is `bytes` (null: unbounded); undefined reads it again. */
export function _setVectorCacheBytesForTests(bytes: number | null | undefined): void {
  cacheBytesForTests = bytes;
}

async function databaseCacheBytes(engine: Engine): Promise<number | null> {
  if (cacheBytesForTests !== undefined) return cacheBytesForTests;
  // PGLite keeps its pages in process memory; only a Postgres server pays a
  // disk read for every index page that falls out of shared_buffers.
  if (engine.kind !== "postgres") return null;
  try {
    const r = await engine.query<{ b: number | string | null }>(
      "SELECT pg_size_bytes(current_setting('shared_buffers'))::bigint AS b",
    );
    const b = Number(r.rows[0]?.b);
    return Number.isFinite(b) && b > 0 ? b : null;
  } catch {
    return null;
  }
}

async function storedVectorRows(engine: Engine): Promise<number> {
  // Statistics spare a full scan of a table of 2-4 KB rows. reltuples moves
  // only with ANALYZE; the live-tuple counter follows inserts as they commit,
  // so the larger of the two never trails a backfill that just ran. A table
  // with neither is small enough to count.
  const est = await engine.query<{ n: number | string | null }>(
    `SELECT GREATEST(c.reltuples::bigint, COALESCE(s.n_live_tup, 0)) AS n
       FROM pg_class c
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.oid = to_regclass('embeddings')`,
  );
  const n = Number(est.rows[0]?.n ?? -1);
  if (Number.isFinite(n) && n >= 1) return n;
  const counted = await engine.query<{ n: number | string }>("SELECT count(*)::bigint AS n FROM embeddings");
  return Number(counted.rows[0]?.n ?? 0);
}

/**
 * The embeddings index now and the room left before it outgrows the database
 * cache: `rows x (vectorBytes + 640) x 1.1` against shared_buffers.
 */
export async function readVectorIndexBudget(engine: Engine): Promise<VectorIndexBudget> {
  const vectorBytes = 8 + EMBED_DIMENSIONS * ((await embeddingVectorType(engine)) === "halfvec" ? 2 : 4);
  const rows = await storedVectorRows(engine);
  const cacheBytes = await databaseCacheBytes(engine);
  const headroomRows = cacheBytes === null
    ? null
    : Math.max(0, Math.floor(cacheBytes / hnswRowBytes(vectorBytes)) - rows);
  return { rows, vectorBytes, cacheBytes, headroomRows };
}

/** Why a run adding `newRows` vectors is refused, in the words the logs and the CLI use. */
export function vectorIndexFullReason(budget: VectorIndexBudget, newRows: number): string {
  const cacheMb = Math.floor((budget.cacheBytes ?? 0) / (1024 * 1024));
  const projected = hnswIndexMb(budget.rows + newRows, budget.vectorBytes);
  return `the vector index would grow to about ${projected} MB, past shared_buffers (${cacheMb} MB)`;
}

/**
 * The cap a code sweep (or a lone `memrain index` of a code file) embeds under:
 * `MEMRAIN_CODE_EMBED_MAX_USD` dollars, and no more new vectors than the
 * database cache still holds. With the dollar cap at 0 nothing is read.
 */
export async function codeEmbedCap(engine: Engine, env: NodeJS.ProcessEnv = process.env): Promise<EmbedSpendCap> {
  const maxUsd = codeEmbedMaxUsd(env);
  if (maxUsd <= 0) return new EmbedSpendCap(0);
  const budget = await readVectorIndexBudget(engine);
  if (budget.headroomRows === null) return new EmbedSpendCap(maxUsd);
  return new EmbedSpendCap(maxUsd, {
    maxCalls: budget.headroomRows,
    callsReason: vectorIndexFullReason(budget, budget.headroomRows + 1),
  });
}

/**
 * A dollar ceiling for a run of embedding calls, and optionally a ceiling on
 * how many calls (new vectors) it makes. Each call reserves its worst case
 * (UTF-8 bytes plus framing, the bound the spend wallet holds) BEFORE it is
 * sent, synchronously, so concurrent workers sharing one cap can never pass
 * the same headroom. A reservation is kept even when the call fails: a sent
 * request may have billed.
 *
 * The run stops at the first call that does not fit, or when a caller reports
 * a failure every later call would repeat (`stop`); from then on nothing is
 * reserved and `stopReason` says why. A cap of $0 never sends anything.
 */
export class EmbedSpendCap {
  private reserved = 0;
  private calls = 0;
  private stopped: string | null = null;
  private readonly maxCalls: number;
  private readonly callsReason: string;

  constructor(readonly maxUsd: number, limits: { maxCalls?: number; callsReason?: string } = {}) {
    this.maxCalls = limits.maxCalls ?? Number.POSITIVE_INFINITY;
    this.callsReason = limits.callsReason ?? `embedding call limit of ${this.maxCalls} reached`;
  }

  /** True when this cap can never send a call: code embedding is off. */
  get off(): boolean {
    return this.maxUsd <= 0;
  }

  /** Reserve one call; false (nothing reserved) once the run has stopped or the call would cross a limit. */
  tryReserve(model: string, input: string): boolean {
    if (this.stopped !== null) return false;
    if (this.off) {
      this.stopped = "code embedding is off (MEMRAIN_CODE_EMBED_MAX_USD=0)";
      return false;
    }
    if (this.calls >= this.maxCalls) {
      this.stopped = this.callsReason;
      return false;
    }
    const usd = worstCaseUsd({ operation: "embedding", model, worstCase: { input, maxOutputTokens: 0 } });
    if (usd === null) {
      this.stopped = `no price for embedding model '${model}'`;
      return false;
    }
    if (this.reserved + usd > this.maxUsd) {
      this.stopped = `embedding cap of $${this.maxUsd} reached`;
      return false;
    }
    this.reserved += usd;
    this.calls++;
    return true;
  }

  /** Stop the run: no later call is reserved. The first reason is kept. */
  stop(reason: string): void {
    this.stopped ??= reason;
  }

  get stopReason(): string | null {
    return this.stopped;
  }

  get reservedUsd(): number {
    return this.reserved;
  }

  get reservedCalls(): number {
    return this.calls;
  }
}
