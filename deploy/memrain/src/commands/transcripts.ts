/**
 * `memrain transcripts ingest <path> [--format auto|chatgpt|claude-ai|codex|claude-code]
 *                           [--source ID] [--since ISO|auto] [--no-embed]
 *                           [--facts --max-cost-usd N] [--dry-run] [--json]`
 * `memrain transcripts status [--source ID] [--json]`
 * `memrain transcripts push <path> --url URL --token-file F [--hook-stdin] [--dry-run] [--json]`
 *
 * Imports a ChatGPT or Claude.ai data export, a Codex CLI rollout
 * (`~/.codex/sessions/**\/rollout-*.jsonl`) or a Claude Code session log
 * (`~/.claude/projects/<project>/<session>.jsonl`) straight into the brain as
 * split, redacted `conversation` pages (see src/core/transcripts/). `<path>`
 * may be a directory of session logs: every `.jsonl` under it (for `codex`,
 * every `rollout-*.jsonl`) is read as one session. `--dry-run` parses, redacts
 * and splits without opening the brain, so the cost of a backfill (sessions,
 * parts, bytes to embed) is visible before it is paid.
 *
 * Exits non-zero when the file is refused (binary, over the size cap, not
 * JSON), when the export shape was not recognised (format drift), when a
 * session log carried assistant turns but no user turn (the rest of a
 * directory still imports), or when a session was refused for carrying a
 * credential under the reject disposition.
 *
 * `--since` keeps only sessions whose last message is newer than an ISO time;
 * `auto` uses the watermark a clean earlier run over the same path and source
 * left (reading it opens the brain, even on a dry run). `--no-embed` writes
 * the pages and leaves search indexing to the cycle's mirror-pages phase.
 * `--facts` runs the paid fact extractor over the parts this run wrote,
 * capped at `--max-cost-usd` (needs MEMRAIN_FACTS_EXTRACTION=1).
 *
 * `status` reports what the brain holds per source and format, the pushed
 * logs in the job queue, and the watermarks. `push` sends one session log to
 * a hosted brain's POST /ingest (see docs/TRANSCRIPTS.md).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { looksBinary } from "../core/binary-guard.ts";
import { loadConfig } from "../core/config.ts";
import { extractFactsForPage, factsExtractionEnabled } from "../core/facts-extract.ts";
import type { EmbedFn } from "../core/indexer.ts";
import { TRANSCRIPTS_INGEST_JOB_KIND } from "../core/jobs/kinds.ts";
import type { SonnetFn } from "../core/llm/sonnet.ts";
import { getRecipeState, setRecipeState } from "../core/recipe-state.ts";
import { SecretRejectedError } from "../core/secret-scan.ts";
import { Storage } from "../core/storage.ts";
import {
  checkTranscriptFileSize,
  countUserTurns,
  parseTranscriptExport,
  parseTranscriptJsonl,
  type ParsedExport,
} from "../core/transcripts/detect.ts";
import {
  ingestSessions,
  prepareSession,
  TRANSCRIPT_PAGE_TYPE,
  type IngestTranscriptsResult,
} from "../core/transcripts/ingest.ts";
import {
  hookTranscriptPath,
  pushEndpoint,
  readPushFile,
  resolvePushPath,
  TRANSCRIPT_PUSH_CONTENT_TYPE,
  transcriptPushMaxBytes,
} from "../core/transcripts/push.ts";
import {
  isTranscriptFormat,
  JSONL_TRANSCRIPT_FORMATS,
  TRANSCRIPT_FORMATS,
  type TranscriptDiagnostics,
  type TranscriptFormat,
  type TranscriptSession,
} from "../core/transcripts/types.ts";
import { withStorage } from "./with-storage.ts";

export interface TranscriptsCmdOptions {
  sub: string | undefined;
  file?: string;
  /** `auto` (default) or a format name. */
  format?: string;
  sourceId?: string;
  dryRun?: boolean;
  json?: boolean;
  configPath?: string;
  /** Test seam — deterministic embedder for the search mirror (no Bedrock). */
  embedFn?: EmbedFn;
  /** ISO time, or `auto` for the watermark of this path and source. */
  since?: string;
  noEmbed?: boolean;
  facts?: boolean;
  maxCostUsd?: string;
  /** push: the brain's base URL (or its /ingest URL). */
  url?: string;
  tokenFile?: string;
  /** push: take the path from a hook's stdin JSON and never fail the hook. */
  hookStdin?: boolean;
  /** Test seams — fact extractor, HTTP client, allowed roots, stdin. */
  sonnetFn?: SonnetFn;
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  pushRoots?: string[];
  readStdin?: () => Promise<string>;
}

interface DryRunPreview {
  sessions: number;
  sessions_rejected: number;
  parts: number;
  bytes: number;
  redactions: number;
}

function preview(sessions: Parameters<typeof prepareSession>[0][]): DryRunPreview {
  const out: DryRunPreview = { sessions: sessions.length, sessions_rejected: 0, parts: 0, bytes: 0, redactions: 0 };
  for (const s of sessions) {
    try {
      const p = prepareSession(s);
      out.parts += p.parts.length;
      out.bytes += p.parts.reduce((n, part) => n + part.bytes, 0);
      out.redactions += p.findings.length;
    } catch (e) {
      if (!(e instanceof SecretRejectedError)) throw e;
      out.sessions_rejected++;
    }
  }
  return out;
}

function fail(msg: string, json: boolean | undefined): number {
  if (json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`memrain transcripts: ${msg}`);
  return 1;
}

/** Read and parse one file; a string is the refusal message. */
function readTranscriptFile(path: string, override: TranscriptFormat | undefined): ParsedExport | string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    return `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const tooBig = checkTranscriptFileSize(size);
  if (tooBig) return `${path}: ${tooBig}`;
  const raw = readFileSync(path);
  if (looksBinary(raw)) return `${path} is a binary file, not a transcript; nothing was imported`;
  const text = raw.toString("utf-8");
  if (path.endsWith(".jsonl") || (override !== undefined && JSONL_TRANSCRIPT_FORMATS.has(override))) {
    return parseTranscriptJsonl(text, raw.length, override);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return `${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  return parseTranscriptExport(data, raw.length, override);
}

/** Session logs under a directory, in a stable order; symlinks are not followed. */
function sessionLogFiles(dir: string, override: TranscriptFormat | undefined): string[] {
  const match = override === "codex" ? (n: string) => n.startsWith("rollout-") && n.endsWith(".jsonl") : (n: string) => n.endsWith(".jsonl");
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && match(ent.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Every session log under `dir`, as one run. A log that yields no session
 * (a sub-agent-only or empty log) is listed as skipped; the run is drift only
 * when logs had content and not one session came out of any of them.
 */
function readTranscriptDir(dir: string, override: TranscriptFormat | undefined): ParsedExport | string {
  let files: string[];
  try {
    files = sessionLogFiles(dir, override);
  } catch (e) {
    return `cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const sessions: TranscriptSession[] = [];
  const formats = new Set<TranscriptFormat>();
  let malformed = 0;
  const diag: TranscriptDiagnostics = {
    format: override ?? null,
    detected_by: override ? "override" : "none",
    bytes: 0,
    items: 0,
    sessions: 0,
    skipped: [],
    skippedMessages: 0,
    format_drift: false,
    user_turns: 0,
    user_turns_missing: 0,
    files: files.length,
  };
  for (const [index, path] of files.entries()) {
    const id = relative(dir, path);
    const r = readTranscriptFile(path, override);
    if (typeof r === "string") return r;
    const d = r.diagnostics;
    diag.bytes += d.bytes;
    diag.items += d.items;
    diag.skippedMessages += d.skippedMessages;
    diag.user_turns += d.user_turns;
    diag.user_turns_missing += d.user_turns_missing;
    malformed += d.malformed_lines ?? 0;
    if (d.format) formats.add(d.format);
    if (r.sessions.length === 0) {
      const reason = d.skipped[0]?.reason ?? (d.format === null ? "no known session log format" : "no sessions");
      diag.skipped.push({ index, id, reason });
    }
    sessions.push(...r.sessions);
  }
  if (!override && formats.size > 0) {
    diag.detected_by = "detection";
    diag.format = formats.size === 1 ? [...formats][0]! : null;
  }
  diag.sessions = sessions.length;
  diag.malformed_lines = malformed;
  diag.format_drift = sessions.length === 0 && diag.bytes > 0;
  return { sessions, diagnostics: diag };
}

/** Epoch ms of a session's last message (or its start), or null. */
function lastActivity(s: TranscriptSession): number | null {
  let last: number | null = null;
  for (const m of s.messages) if (m.ts !== null && (last === null || m.ts > last)) last = m.ts;
  return last ?? s.startedAt;
}

const WATERMARK_RECIPE_PREFIX = "transcripts:";
const WATERMARK_KEY = "watermark";

interface TranscriptWatermark {
  path: string;
  watermark: string;
}

/** One watermark per source and resolved input path: another directory of
 *  the same format must never inherit it and skip sessions it never read. */
function watermarkRecipeId(sourceId: string, path: string): string {
  const h = createHash("sha256").update(resolve(path), "utf8").digest("hex").slice(0, 16);
  return `${WATERMARK_RECIPE_PREFIX}${sourceId}:${h}`;
}

/** Sessions with no time at all are kept: nothing proves them old. */
function sessionsSince(sessions: readonly TranscriptSession[], sinceMs: number): TranscriptSession[] {
  return sessions.filter((s) => {
    const last = lastActivity(s);
    return last === null || last > sinceMs;
  });
}

interface FactsRun {
  parts: number;
  facts_written: number;
  spent_usd: number;
  budget_exhausted: boolean;
}

interface WrittenPart {
  slug: string;
  body: string;
  sourceId: string;
}

/** The paid extractor over the parts this run wrote, under one dollar cap. */
async function extractFactsForParts(
  storage: Storage,
  parts: readonly WrittenPart[],
  capUsd: number,
  sonnetFn: SonnetFn | undefined,
): Promise<FactsRun> {
  const run: FactsRun = { parts: 0, facts_written: 0, spent_usd: 0, budget_exhausted: false };
  for (const part of parts) {
    const left = capUsd - run.spent_usd;
    if (left <= 0) {
      run.budget_exhausted = true;
      break;
    }
    const r = await extractFactsForPage(storage, {
      slug: part.slug,
      type: TRANSCRIPT_PAGE_TYPE,
      body: part.body,
      sourceId: part.sourceId,
      maxBudgetUsd: left,
      ...(sonnetFn ? { sonnetFn } : {}),
    });
    run.parts++;
    run.facts_written += r.factsWritten;
    run.spent_usd += r.spentUsd;
    if (r.absorbed === "budget_exhausted") {
      run.budget_exhausted = true;
      break;
    }
  }
  return run;
}

interface IngestContext {
  file: string;
  formatLabel: string;
  diagnostics: TranscriptDiagnostics;
  sinceInfo: { since: string | null; sessions_before: number } | undefined;
  factsCap: number | null;
}

export async function runTranscripts(opts: TranscriptsCmdOptions): Promise<number> {
  if (opts.sub === "status") return runStatus(opts);
  if (opts.sub === "push") return runPush(opts);
  if (opts.sub !== "ingest") {
    console.error("memrain transcripts: subcommand required (ingest <path> | status | push <path>)");
    return 1;
  }
  if (!opts.file) return fail("ingest: <path> is required", opts.json);
  const formatArg = (opts.format ?? "auto").trim().toLowerCase();
  if (formatArg !== "auto" && !isTranscriptFormat(formatArg)) {
    return fail(`--format must be auto, ${TRANSCRIPT_FORMATS.join(", ")} (got ${JSON.stringify(opts.format)})`, opts.json);
  }
  const override: TranscriptFormat | undefined = formatArg === "auto" ? undefined : formatArg;
  const since = opts.since?.trim();
  let sinceMs: number | null = null;
  if (since !== undefined && since !== "auto") {
    sinceMs = Date.parse(since);
    if (!Number.isFinite(sinceMs)) return fail(`--since must be an ISO time or auto (got ${JSON.stringify(opts.since)})`, opts.json);
  }
  if (opts.maxCostUsd !== undefined && !opts.facts) return fail("--max-cost-usd applies only with --facts", opts.json);
  let factsCap: number | null = null;
  if (opts.facts) {
    factsCap = Number(opts.maxCostUsd);
    if (opts.maxCostUsd === undefined || !Number.isFinite(factsCap) || factsCap <= 0) {
      return fail("--facts needs --max-cost-usd N, a positive dollar cap for the paid extractor", opts.json);
    }
    if (!opts.dryRun && !opts.sonnetFn && !factsExtractionEnabled()) {
      return fail("--facts runs the paid extractor and needs MEMRAIN_FACTS_EXTRACTION=1; nothing was imported", opts.json);
    }
  }

  let isDir: boolean;
  try {
    isDir = statSync(opts.file).isDirectory();
  } catch (e) {
    return fail(`cannot read ${opts.file}: ${e instanceof Error ? e.message : String(e)}`, opts.json);
  }
  const loaded = isDir ? readTranscriptDir(opts.file, override) : readTranscriptFile(opts.file, override);
  if (typeof loaded === "string") return fail(loaded, opts.json);
  const { diagnostics } = loaded;
  let sessions = loaded.sessions;
  const file = basename(opts.file);
  const formatLabel = diagnostics.format ?? (sessions.length > 0 ? "mixed" : "empty");

  if (diagnostics.format_drift) {
    const msg =
      diagnostics.format === null
        ? `${file}: no known export format recognised (${diagnostics.items} items); nothing was imported`
        : diagnostics.user_turns_missing > 0
          ? `${file}: read as ${diagnostics.format} with assistant turns but no user turn (user_turns_missing); the session log format may have changed, nothing was imported`
          : `${file}: read as ${diagnostics.format} but produced zero sessions from ${diagnostics.items} items; the export format may have changed`;
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg, diagnostics }, null, 2));
    else console.error(`memrain transcripts: ${msg}`);
    return 1;
  }

  const sourceId = opts.sourceId ?? "default";
  const recipeId = watermarkRecipeId(sourceId, opts.file);
  const storage = !opts.dryRun || since === "auto" ? new Storage(loadConfig(opts.configPath)) : null;
  if (storage === null) {
    return dryRun(sessions, { file, formatLabel, diagnostics, sinceInfo: sinceInfoFor(since, sinceMs, sessions.length), factsCap }, opts, sinceMs);
  }
  return withStorage(storage, async () => {
    if (since === "auto") {
      const wm = await getRecipeState<TranscriptWatermark>(storage.engine(), recipeId, WATERMARK_KEY);
      const at = wm ? Date.parse(wm.watermark) : NaN;
      sinceMs = Number.isFinite(at) ? at : null;
    }
    const ctx: IngestContext = { file, formatLabel, diagnostics, sinceInfo: sinceInfoFor(since, sinceMs, sessions.length), factsCap };
    if (opts.dryRun) return dryRun(sessions, ctx, opts, sinceMs);
    if (sinceMs !== null) sessions = sessionsSince(sessions, sinceMs);
    return realRun(storage, sessions, ctx, opts, { recipeId, sinceAttests: since === undefined || since === "auto" });
  });
}

function sinceInfoFor(since: string | undefined, sinceMs: number | null, before: number): IngestContext["sinceInfo"] {
  return since === undefined ? undefined : { since: sinceMs === null ? null : new Date(sinceMs).toISOString(), sessions_before: before };
}

function dryRun(all: TranscriptSession[], ctx: IngestContext, opts: TranscriptsCmdOptions, sinceMs: number | null): number {
  const { file, formatLabel, diagnostics } = ctx;
  const sessions = sinceMs === null ? all : sessionsSince(all, sinceMs);
  const p = preview(sessions);
  const missing = diagnostics.user_turns_missing > 0;
  if (opts.json) {
    console.log(
      JSON.stringify(
        { ok: !missing, dry_run: true, file, diagnostics, ...(ctx.sinceInfo ? { since: ctx.sinceInfo } : {}), preview: p },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `${file} (${formatLabel}): ${p.sessions} sessions → ${p.parts} parts, ` +
        `${p.bytes} bytes to embed, ${p.redactions} credentials to redact` +
        (p.sessions_rejected > 0 ? `, ${p.sessions_rejected} sessions would be refused` : "") +
        ` — dry-run, nothing written`,
    );
    printSkipped(diagnostics.skipped, diagnostics.skippedMessages);
  }
  return p.sessions_rejected > 0 || missing ? 1 : 0;
}

async function realRun(
  storage: Storage,
  sessions: TranscriptSession[],
  ctx: IngestContext,
  opts: TranscriptsCmdOptions,
  wm: { recipeId: string; sinceAttests: boolean },
): Promise<number> {
  const { file, formatLabel, diagnostics } = ctx;
  const written: WrittenPart[] = [];
  const result: IngestTranscriptsResult = await ingestSessions(storage, sessions, {
    ref: `${diagnostics.format ?? "unknown"}:${file}`,
    ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    ...(opts.embedFn ? { embedFn: opts.embedFn } : {}),
    ...(opts.noEmbed ? { deferMirror: true } : {}),
    ...(ctx.factsCap !== null ? { onPartWritten: (p: WrittenPart) => written.push(p) } : {}),
  });
  const facts = ctx.factsCap !== null ? await extractFactsForParts(storage, written, ctx.factsCap, opts.sonnetFn) : undefined;
  const failedRun = result.sessions_rejected + result.sessions_failed > 0 || diagnostics.user_turns_missing > 0;
  // Only a clean run that read everything above the old watermark may move
  // it: a partial run, or an explicit --since that never looked below its
  // cutoff, would make the next `auto` skip work for good.
  let watermark: string | null = null;
  if (!failedRun && (diagnostics.malformed_lines ?? 0) === 0 && wm.sinceAttests) {
    const latest = sessions.map(lastActivity).filter((t): t is number => t !== null);
    if (latest.length > 0) {
      const prev = await getRecipeState<TranscriptWatermark>(storage.engine(), wm.recipeId, WATERMARK_KEY);
      const prevMs = prev ? Date.parse(prev.watermark) : NaN;
      watermark = new Date(Math.max(...latest, Number.isFinite(prevMs) ? prevMs : 0)).toISOString();
      await setRecipeState<TranscriptWatermark>(storage.engine(), wm.recipeId, WATERMARK_KEY, {
        path: resolve(opts.file!),
        watermark,
      });
    }
  }
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: !failedRun,
          dry_run: false,
          file,
          diagnostics,
          ...(ctx.sinceInfo ? { since: ctx.sinceInfo } : {}),
          result,
          ...(facts ? { facts } : {}),
          watermark,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `${file} (${formatLabel}): ${result.sessions} sessions, ` +
        `${result.parts_written} parts written, ${result.parts_unchanged} unchanged, ` +
        `${result.parts_deleted} stale deleted, ${result.redactions} credentials redacted` +
        (result.mirror_failures > 0 ? `, ${result.mirror_failures} not yet searchable` : "") +
        (result.mirror_deferred > 0 ? `, ${result.mirror_deferred} left for the cycle to index` : ""),
    );
    if (ctx.sinceInfo) console.log(`  since ${ctx.sinceInfo.since ?? "the start"}: ${sessions.length} of ${ctx.sinceInfo.sessions_before} sessions`);
    if (facts) {
      console.log(
        `  facts: ${facts.facts_written} written from ${facts.parts} parts, $${facts.spent_usd.toFixed(4)} spent` +
          (facts.budget_exhausted ? " — cap reached" : ""),
      );
    }
    for (const r of result.rejected) console.log(`  refused ${r.id}: ${r.reason}`);
    for (const f of result.failed) console.log(`  failed ${f.id} (${f.code}): ${f.reason}`);
    if (diagnostics.user_turns_missing > 0) {
      console.log(
        `  ${diagnostics.user_turns_missing} session logs had assistant turns but no user turn (user_turns_missing); the format may have changed`,
      );
    }
    printSkipped(diagnostics.skipped, diagnostics.skippedMessages);
  }
  return failedRun ? 1 : 0;
}

function printSkipped(skipped: ReadonlyArray<{ index: number; id?: string; reason: string }>, messages: number): void {
  for (const s of skipped) console.log(`  skipped [${s.index}]${s.id ? ` ${s.id}` : ""}: ${s.reason}`);
  if (messages > 0) console.log(`  ${messages} system, tool, hidden or empty messages left out`);
}

interface StatusRow {
  source_id: string;
  format: string;
  sessions: number;
  parts: number;
  last_write: string;
}

async function runStatus(opts: TranscriptsCmdOptions): Promise<number> {
  const storage = new Storage(loadConfig(opts.configPath));
  const report = await withStorage(storage, async () => {
    const engine = storage.engine();
    const params: unknown[] = [TRANSCRIPT_PAGE_TYPE];
    if (opts.sourceId) params.push(opts.sourceId);
    const pages = await engine.query<StatusRow>(
      `SELECT source_id, split_part(slug, '/', 2) AS format,
              COUNT(DISTINCT regexp_replace(slug, '-p[0-9]+$', ''))::int AS sessions,
              COUNT(*)::int AS parts, MAX(updated_at)::text AS last_write
         FROM pages
        WHERE slug LIKE 'transcripts/%' AND type = $1 AND deleted_at IS NULL
              ${opts.sourceId ? "AND source_id = $2" : ""}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      params,
    );
    const jobs = await engine.query<{ status: string; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM jobs WHERE kind = $1 GROUP BY 1 ORDER BY 1`,
      [TRANSCRIPTS_INGEST_JOB_KIND],
    );
    const marks = await engine.query<{ recipe_id: string; value: TranscriptWatermark | string }>(
      `SELECT recipe_id, value FROM recipe_state WHERE recipe_id LIKE $1 AND key = $2 ORDER BY recipe_id`,
      [`${WATERMARK_RECIPE_PREFIX}${opts.sourceId ? `${opts.sourceId}:` : ""}%`, WATERMARK_KEY],
    );
    return {
      transcripts: pages.rows,
      push_jobs: Object.fromEntries(jobs.rows.map((r) => [r.status, r.n])),
      watermarks: marks.rows.map((r) => {
        const v = (typeof r.value === "string" ? JSON.parse(r.value) : r.value) as TranscriptWatermark;
        const source = r.recipe_id.slice(WATERMARK_RECIPE_PREFIX.length).replace(/:[0-9a-f]{16}$/, "");
        return { source_id: source, path: v.path, watermark: v.watermark };
      }),
    };
  });
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
    return 0;
  }
  if (report.transcripts.length === 0) console.log("no transcripts in the brain yet");
  for (const r of report.transcripts) {
    console.log(`${r.source_id} ${r.format}: ${r.sessions} sessions, ${r.parts} parts, last written ${r.last_write}`);
  }
  const queued = Object.entries(report.push_jobs);
  if (queued.length > 0) console.log(`pushed logs: ${queued.map(([k, n]) => `${n} ${k}`).join(", ")}`);
  for (const w of report.watermarks) console.log(`watermark ${w.source_id} ${w.path}: ${w.watermark}`);
  return 0;
}

const MAX_TOKEN_FILE_BYTES = 4096;

/** The token from a file only its owner can read. Never echoes it. */
function readPushToken(path: string | undefined): { token: string } | { error: string } {
  if (!path) return { error: "--token-file is required" };
  let st;
  try {
    st = statSync(path);
  } catch {
    return { error: `cannot read --token-file ${path}` };
  }
  if (!st.isFile()) return { error: `--token-file ${path} is not a regular file` };
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    return { error: `--token-file ${path} is readable by other users; chmod 600 it` };
  }
  if (st.size > MAX_TOKEN_FILE_BYTES) return { error: `--token-file ${path} is larger than ${MAX_TOKEN_FILE_BYTES} bytes` };
  const token = readFileSync(path, "utf-8").trim();
  if (token === "") return { error: `--token-file ${path} is empty` };
  if (!/^[\x21-\x7E]+$/.test(token)) return { error: "the token contains whitespace or non-ASCII characters" };
  return { token };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * `transcripts push`: one session log to a hosted brain. Under --hook-stdin
 * it runs inside an agent's session hook, so a failure is reported on stderr
 * and the exit stays 0: a brain that is down must not break the agent.
 */
async function runPush(opts: TranscriptsCmdOptions): Promise<number> {
  const done = (code: number, payload: Record<string, unknown>, line: string): number => {
    if (opts.json) console.log(JSON.stringify({ ok: code === 0, ...payload }, null, 2));
    else if (code !== 0) console.error(`memrain transcripts push: ${line}`);
    else console.log(line);
    return code !== 0 && opts.hookStdin ? 0 : code;
  };
  const refuse = (msg: string, extra: Record<string, unknown> = {}) => done(1, { error: msg, ...extra }, msg);

  let target = opts.file;
  if (opts.hookStdin) {
    const raw = await (opts.readStdin ?? readAllStdin)().catch(() => "");
    target = hookTranscriptPath(raw) ?? undefined;
    if (!target) return refuse("the hook input carries no transcript_path");
  }
  if (!target) return refuse("push: <path> is required");
  const resolved = resolvePushPath(target, opts.pushRoots);
  if ("error" in resolved) return refuse(resolved.error);
  const read = readPushFile(resolved.path, transcriptPushMaxBytes(), resolved);
  if ("error" in read) return refuse(read.error);
  if (looksBinary(read.buf)) return refuse(`${resolved.path} is a binary file, not a session log`);
  const parsed = parseTranscriptJsonl(read.buf.toString("utf-8"), read.buf.length);
  const d = parsed.diagnostics;
  if (d.user_turns_missing > 0) {
    return refuse(`${resolved.path}: assistant turns but no user turn (user_turns_missing); nothing was sent`, { diagnostics: d });
  }
  if (parsed.sessions.length === 0) {
    return refuse(`${resolved.path}: ${d.skipped[0]?.reason ?? "no session"}; nothing was sent`, { diagnostics: d });
  }
  if (opts.dryRun) {
    const p = preview(parsed.sessions);
    return done(
      0,
      { dry_run: true, path: resolved.path, format: d.format, sessions: p.sessions, parts: p.parts, user_turns: countUserTurns(parsed.sessions) },
      `${resolved.path} (${d.format}): ${p.sessions} sessions → ${p.parts} parts — dry-run, nothing sent`,
    );
  }
  if (!opts.url) return refuse("--url is required");
  const endpoint = pushEndpoint(opts.url);
  if ("error" in endpoint) return refuse(endpoint.error);
  const tok = readPushToken(opts.tokenFile);
  if ("error" in tok) return refuse(tok.error);

  let res: Response;
  try {
    res = await (opts.fetchFn ?? fetch)(endpoint.url, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${tok.token}`,
        "content-type": TRANSCRIPT_PUSH_CONTENT_TYPE,
        "x-memrain-source-uri": `transcript:${basename(resolved.path)}`,
      },
      body: read.buf,
      // A redirect would carry the bearer to wherever it points.
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return refuse(`cannot reach ${endpoint.url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // A proxy's HTML error page: the status says enough.
  }
  if (res.status !== 202) {
    const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
    const msg = typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
    return done(1, { status: res.status, error: code, message: msg }, `${code}: ${msg}`);
  }
  return done(
    0,
    { status: res.status, path: resolved.path, job_id: body.job_id, sessions: body.sessions, parts: body.parts },
    `${basename(resolved.path)}: queued as ${String(body.job_id)} (${String(body.sessions)} sessions, ${String(body.parts)} parts)`,
  );
}
