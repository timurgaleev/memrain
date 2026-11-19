/**
 * The `--json` guard for the commands in JSON_GUARDED_COMMANDS.
 *
 * A script or an agent calling `memrain <cmd> --json` needs one thing from
 * stdout: a single JSON object it can parse. Commands were written for humans
 * first, so a stray console.log, a usage error printed to stderr with empty
 * stdout, or a prose branch ("No eval results found") each broke the parse.
 * Rather than audit every print on every path, main() runs a guarded command
 * inside runJsonGuarded: everything bound for stdout is held, and when the
 * command finishes exactly one document is written.
 *
 *   - The command printed one JSON object: it goes out byte for byte, so the
 *     commands that already spoke JSON keep their exact output.
 *   - Anything else (prose, an array, two documents, nothing) is wrapped as
 *     `{ok, data}`. Prose lands in `data.text` verbatim; it is never parsed.
 *   - A failure without its own JSON becomes `{ok:false, error, exit_code}`.
 *     A structured error carries its code, class, retryability and the
 *     anchor of its entry in docs/ERRORS.md.
 *
 * Exit codes are untouched: the guard only decides what stdout says.
 */
import { format } from "node:util";
import { exitCodeForError, resolveExitCode } from "./cli-exit.ts";
import { databaseOperationError } from "./core/database-error.ts";
import { isOperationError, operationErrorTraits } from "./core/operation-error.ts";

export interface CapturedOutput { stdout: string; stderr: string }
export type GuardOutcome = { code: number } | { error: unknown };

/** Where a code's entry lives; ERRORS.md gives every code an anchor of its own name. */
export function errorDocsAnchor(code: string): string {
  return `docs/ERRORS.md#${code}`;
}

// The error message comes from stderr's tail: long reports print their verdict last.
const MESSAGE_MAX = 2000;

function tail(text: string): string {
  const t = text.trim();
  return t.length > MESSAGE_MAX ? t.slice(-MESSAGE_MAX) : t;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function errorObject(err: unknown): Record<string, unknown> {
  // A raw database error is reported by its sanitized class only: its text can
  // carry a host name or SQL detail that does not belong in a parsed result.
  const structured = isOperationError(err) ? err : databaseOperationError(err);
  if (!structured) return { message: err instanceof Error ? err.message : String(err) };
  const { errorClass, retryable } = operationErrorTraits(structured.code);
  return {
    code: structured.code,
    error_class: errorClass,
    retryable,
    message: structured.message,
    docs: errorDocsAnchor(structured.code),
  };
}

function line(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc)}\n`;
}

/**
 * The one stdout document for a guarded run, plus anything that must move to
 * stderr so it is not lost.
 */
export function renderJsonDocument(captured: CapturedOutput, outcome: GuardOutcome): CapturedOutput {
  if ("error" in outcome) {
    return {
      stdout: line({ ok: false, error: errorObject(outcome.error), exit_code: exitCodeForError(outcome.error) }),
      stderr: captured.stdout,
    };
  }
  const text = captured.stdout.trim();
  let parsed: unknown;
  let isJson = false;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
      isJson = true;
    } catch {
      // Not one JSON document: reported as text below.
    }
  }
  if (isJson && isPlainObject(parsed)) return { stdout: captured.stdout, stderr: "" };

  const data = isJson ? parsed : text === "" ? null : { text };
  if (outcome.code === 0) return { stdout: line({ ok: true, data }), stderr: "" };

  const message = tail(captured.stderr) || (isJson ? "" : text) || `exited with code ${outcome.code}`;
  return {
    stdout: line({ ok: false, ...(data !== null ? { data } : {}), error: { message }, exit_code: outcome.code }),
    stderr: "",
  };
}

type Writer = typeof process.stdout.write;

function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  return String(chunk);
}

/**
 * Run a command with stdout held; write the one document when it finishes.
 * stderr still reaches the terminal live and is also kept, so a failure that
 * only printed to stderr can name its reason in the document.
 */
export async function runJsonGuarded(run: () => Promise<number>): Promise<number> {
  let out = "";
  let err = "";
  const saved = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    dir: console.dir,
    table: console.table,
    error: console.error,
    warn: console.warn,
    stdoutWrite: process.stdout.write,
    stderrWrite: process.stderr.write,
  };
  const realStderr = saved.stderrWrite.bind(process.stderr);
  const hold = (...args: unknown[]): void => {
    out += `${format(...args)}\n`;
  };
  const keepStderr = (orig: (...a: unknown[]) => void) => (...args: unknown[]): void => {
    err += `${format(...args)}\n`;
    orig.apply(console, args);
  };
  const callbackOf = (args: unknown[]): unknown => args.find((a) => typeof a === "function");

  console.log = hold;
  console.info = hold;
  console.debug = hold;
  console.dir = hold;
  console.table = hold;
  console.error = keepStderr(saved.error);
  console.warn = keepStderr(saved.warn);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    out += chunkText(chunk);
    const cb = callbackOf(rest);
    if (typeof cb === "function") queueMicrotask(() => cb());
    return true;
  }) as Writer;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    err += chunkText(chunk);
    return (realStderr as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as Writer;

  const restore = (): void => {
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
    console.dir = saved.dir;
    console.table = saved.table;
    console.error = saved.error;
    console.warn = saved.warn;
    process.stdout.write = saved.stdoutWrite;
    process.stderr.write = saved.stderrWrite;
  };
  const emit = (doc: CapturedOutput): void => {
    if (doc.stderr !== "") process.stderr.write(doc.stderr);
    process.stdout.write(doc.stdout);
  };

  let returned: number;
  try {
    returned = await run();
  } catch (error) {
    restore();
    emit(renderJsonDocument({ stdout: out, stderr: err }, { error }));
    throw error;
  }
  restore();
  // The document reports the code the process will exit with, which honours a
  // `process.exitCode` set by a command that returned 0.
  const code = resolveExitCode(returned, process.exitCode ?? undefined);
  emit(renderJsonDocument({ stdout: out, stderr: err }, { code }));
  return returned;
}
