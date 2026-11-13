/**
 * The LongMemEval-S (cleaned) dataset: a pinned download, verified before use.
 *
 * The file is fetched from a fixed dataset revision and checked against the
 * sha256 that revision publishes. It is written under a temporary name, hashed
 * as it streams, and renamed into the cache only when size and checksum match;
 * any failure removes the temporary file, so the cache never holds a partial
 * or altered copy. A cached copy is re-hashed on every use.
 *
 * Dataset: LongMemEval (Wu et al., ICLR 2025), cleaned release, MIT license per
 * its dataset card. The cache lives outside the repository (see
 * defaultCacheDir) and is never committed.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DatasetSpec {
  url: string;
  sha256: string;
  bytes: number;
  /** File name inside the cache directory. */
  file: string;
}

const REVISION = "98d7416c24c778c2fee6e6f3006e7a073259d48f";

export const LONGMEMEVAL_S_CLEANED: DatasetSpec = {
  url: `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/${REVISION}/longmemeval_s_cleaned.json`,
  sha256: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
  bytes: 277_383_467,
  file: "longmemeval_s_cleaned.d6f21ea9.json",
};

export class DatasetChecksumError extends Error {
  override name = "DatasetChecksumError";
}
/** The download did not complete; trying again later may succeed. */
export class DatasetFetchError extends Error {
  override name = "DatasetFetchError";
}
export class DatasetFormatError extends Error {
  override name = "DatasetFormatError";
}

export interface LmeTurn {
  role: string;
  content: string;
}
export interface LmeSession {
  id: string;
  date: string;
  turns: LmeTurn[];
}
export interface LmeQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  sessions: LmeSession[];
  /** Gold evidence sessions — scoring only, never ingested or shown to a model. */
  answer_session_ids: string[];
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(base, "memrain", "longmemeval");
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function download(spec: DatasetSpec, tmp: string, fetchFn: typeof fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(spec.url);
  } catch (e) {
    throw new DatasetFetchError(`download of ${spec.url} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok || !res.body) {
    throw new DatasetFetchError(`download of ${spec.url} failed: HTTP ${res.status}`);
  }
  const hash = createHash("sha256");
  const fd = openSync(tmp, "wx", 0o600);
  let written = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (e) {
        throw new DatasetFetchError(`download of ${spec.url} broke off: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (next.done) break;
      written += next.value.byteLength;
      if (written > spec.bytes) {
        await reader.cancel();
        throw new DatasetChecksumError(`${spec.url} is larger than the pinned ${spec.bytes} bytes`);
      }
      hash.update(next.value);
      writeSync(fd, next.value);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const sha = hash.digest("hex");
  if (written !== spec.bytes || sha !== spec.sha256) {
    throw new DatasetChecksumError(
      `${spec.url}: got ${written} bytes with sha256 ${sha}, pinned ${spec.bytes} bytes with sha256 ${spec.sha256}`,
    );
  }
}

/** Path of a verified copy of `spec` in `cacheDir`, downloading it first if needed. */
export async function ensureDataset(
  spec: DatasetSpec,
  opts: { cacheDir: string; fetchFn?: typeof fetch },
): Promise<string> {
  const target = join(opts.cacheDir, spec.file);
  if (existsSync(target)) {
    const sha = await sha256OfFile(target);
    if (sha !== spec.sha256) {
      throw new DatasetChecksumError(`cached ${target} has sha256 ${sha}, pinned ${spec.sha256}; remove it to download again`);
    }
    return target;
  }
  mkdirSync(opts.cacheDir, { recursive: true, mode: 0o700 });
  const tmp = join(opts.cacheDir, `.${spec.file}.${process.pid}.${randomBytes(4).toString("hex")}.part`);
  try {
    await download(spec, tmp, opts.fetchFn ?? fetch);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  return target;
}

function fail(i: number, what: string): never {
  throw new DatasetFormatError(`dataset record ${i}: ${what}`);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function parseDataset(text: string): LmeQuestion[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new DatasetFormatError(`dataset is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(raw)) throw new DatasetFormatError("dataset is not a list of questions");
  return raw.map((r: Record<string, unknown>, i) => {
    if (!r || typeof r !== "object") fail(i, "not an object");
    for (const key of ["question_id", "question_type", "question", "question_date"]) {
      if (typeof r[key] !== "string") fail(i, `${key} is not a string`);
    }
    if (typeof r.answer !== "string" && typeof r.answer !== "number") fail(i, "answer is not a string");
    const { haystack_dates: dates, haystack_session_ids: ids, haystack_sessions: sessions } = r;
    if (!isStringArray(dates) || !isStringArray(ids) || !Array.isArray(sessions)) fail(i, "haystack arrays missing");
    if (dates.length !== sessions.length || ids.length !== sessions.length) fail(i, "haystack arrays differ in length");
    const answerIds = r.answer_session_ids ?? [];
    if (!isStringArray(answerIds)) fail(i, "answer_session_ids is not a list of strings");
    return {
      question_id: r.question_id as string,
      question_type: r.question_type as string,
      question: r.question as string,
      answer: String(r.answer),
      question_date: r.question_date as string,
      answer_session_ids: answerIds,
      sessions: sessions.map((turns: unknown, s) => {
        if (!Array.isArray(turns)) fail(i, `session ${s} is not a list of turns`);
        return {
          id: ids[s]!,
          date: dates[s]!,
          turns: turns.map((t: Record<string, unknown>) => {
            if (!t || typeof t.role !== "string" || typeof t.content !== "string") fail(i, `session ${s} has a malformed turn`);
            return { role: t.role, content: t.content };
          }),
        };
      }),
    };
  });
}
