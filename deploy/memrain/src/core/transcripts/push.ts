/**
 * Pushing one session log from a laptop to a hosted brain.
 *
 * The client side (`memrain transcripts push`) reads only session logs the
 * coding agents write themselves: a file under `~/.claude/projects` or
 * `~/.codex/sessions`, after resolving every symlink on the way, and never a
 * symlink itself. A hook runs it with whatever path the agent hands over, so
 * the confinement is what keeps a crafted path from shipping `~/.ssh` to the
 * server.
 *
 * The server side (`POST /ingest` with the transcript content type) parses
 * the log with the same adapters `transcripts ingest` uses and queues the
 * redacted sessions; this module also holds the check the job runs on them,
 * because the queue payload crosses a serialization boundary.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { JSONL_TRANSCRIPT_FORMATS, type TranscriptFormat, type TranscriptSession } from "./types.ts";

export const TRANSCRIPT_PUSH_CONTENT_TYPE = "application/x-memrain-transcript+jsonl";
export const DEFAULT_TRANSCRIPT_PUSH_MAX_BYTES = 25 * 1024 * 1024;

/** MEMRAIN_INGEST_TRANSCRIPT_MAX_BYTES, a positive integer (default 25 MiB). */
export function transcriptPushMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.MEMRAIN_INGEST_TRANSCRIPT_MAX_BYTES ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n > 0 ? n : DEFAULT_TRANSCRIPT_PUSH_MAX_BYTES;
}

/** Where Claude Code and Codex write their session logs. */
export function defaultPushRoots(home: string = homedir()): string[] {
  return [join(home, ".claude", "projects"), join(home, ".codex", "sessions")];
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The real path of a pushable session log, or the refusal. The file itself
 * must not be a symlink, and its resolved path must sit under the resolved
 * form of one of `roots` (a root that does not exist confines nothing).
 */
export interface ResolvedPushPath {
  path: string;
  /** Identity of the checked file, so the read can prove it opened the same one. */
  dev: number;
  ino: number;
}

export function resolvePushPath(path: string, roots: readonly string[] = defaultPushRoots()): ResolvedPushPath | { error: string } {
  const abs = resolve(path);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { error: `cannot read ${abs}` };
  }
  if (st.isSymbolicLink()) return { error: `${abs} is a symlink; push reads session logs only, never a link` };
  if (!st.isFile()) return { error: `${abs} is not a regular file` };
  if (!abs.endsWith(".jsonl")) return { error: `${abs} is not a .jsonl session log` };
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return { error: `cannot resolve ${abs}` };
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (isInside(realRoot, real)) return { path: real, dev: st.dev, ino: st.ino };
  }
  return { error: `${abs} is outside the session log directories (${roots.join(", ")}); refusing to push it` };
}

/**
 * Read the file without following a link swapped in after the check, and
 * refuse rather than truncate one over the cap: half a log would land as a
 * complete-looking session.
 */
export function readPushFile(
  path: string,
  maxBytes: number,
  expected?: { dev: number; ino: number },
): { buf: Buffer } | { error: string } {
  let fd: number;
  try {
    // Non-blocking so a FIFO swapped in cannot hang a session hook.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { error: `cannot open ${path} (a symlink is refused)` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: `${path} is not a regular file` };
    // A directory on the path swapped for a link after the check would open
    // some other file under the same name.
    if (expected && (st.dev !== expected.dev || st.ino !== expected.ino)) {
      return { error: `${path} changed while it was being checked; nothing was sent` };
    }
    if (st.size > maxBytes) {
      return { error: `${path} is ${st.size} bytes, over the ${maxBytes}-byte cap (MEMRAIN_INGEST_TRANSCRIPT_MAX_BYTES)` };
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return { buf: buf.subarray(0, off) };
  } finally {
    closeSync(fd);
  }
}

/** `transcript_path` from a Claude Code hook's stdin JSON, or null. */
export function hookTranscriptPath(stdin: string): string | null {
  try {
    const v = JSON.parse(stdin) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    const p = (v as Record<string, unknown>)["transcript_path"];
    return typeof p === "string" && p.trim() !== "" ? p : null;
  } catch {
    return null;
  }
}

/** Bearer tokens travel only over TLS, except to this machine. */
export function pushEndpoint(base: string): { url: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return { error: `--url ${JSON.stringify(base)} is not a URL` };
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    return { error: "--url must be https (plain http only to localhost)" };
  }
  if (u.username || u.password) return { error: "--url must not carry credentials; use --token-file" };
  let path = u.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  u.pathname = path.endsWith("/ingest") ? path : `${path}/ingest`;
  u.search = "";
  u.hash = "";
  return { url: u.toString() };
}

function isMessage(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m["id"] === "string" &&
    (m["role"] === "user" || m["role"] === "assistant") &&
    typeof m["speaker"] === "string" &&
    typeof m["text"] === "string" &&
    (m["ts"] === null || typeof m["ts"] === "number")
  );
}

/** The queued sessions, re-checked after the queue round-trip, or why not. */
export function sessionsFromPayload(v: unknown): TranscriptSession[] | string {
  if (!Array.isArray(v) || v.length === 0) return "sessions must be a non-empty array";
  for (const s of v) {
    if (s === null || typeof s !== "object") return "a session must be an object";
    const r = s as Record<string, unknown>;
    if (typeof r["format"] !== "string" || !JSONL_TRANSCRIPT_FORMATS.has(r["format"] as TranscriptFormat)) {
      return "a pushed session must be a codex or claude-code log";
    }
    if (typeof r["id"] !== "string" || r["id"] === "") return "a session needs an id";
    if (r["title"] !== null && typeof r["title"] !== "string") return "a session title must be a string or null";
    if (r["startedAt"] !== null && typeof r["startedAt"] !== "number") return "startedAt must be a number or null";
    if (!Array.isArray(r["messages"]) || !r["messages"].every(isMessage)) return "a session's messages are malformed";
  }
  return v as TranscriptSession[];
}
