#!/usr/bin/env bun
/**
 * scripts/scope-lint.ts — static source-scope and pooler-safety gate (run by `make audit`).
 *
 * Two checks over deploy/memrain/src (comments ignored):
 *
 *  1. Source scope. Every SQL read in src/core and src/mcp that selects FROM or
 *     JOINs a table carrying a `source_id` column must either apply a source
 *     predicate (mention `source_id`, or interpolate a scope helper such as
 *     `andSourceScope`) or carry a marker within the three lines above it:
 *
 *         // scope: operator-only <reason>
 *         // scope: upstream <reason>     (the caller already scoped the ids it passes)
 *
 *     Reads that predate the gate are counted per file in
 *     scripts/scope-lint.baseline.json. A file may not exceed its count; a file
 *     that drops below it fails too, so the baseline only ever shrinks
 *     (`bun scripts/scope-lint.ts --update` rewrites it).
 *
 *  2. Pooler safety. A transaction-mode pooler hands each transaction a
 *     different server session, so anything that outlives a transaction is
 *     unsafe: session advisory locks (`pg_advisory_lock`, `pg_try_advisory_lock`,
 *     `pg_advisory_unlock`, the `_shared` forms), `LISTEN` / `UNLISTEN`, a bare
 *     `SET` (only `SET LOCAL`, `SET TRANSACTION` and `SET CONSTRAINTS` are
 *     transaction-scoped) and `set_config(..., false)`. No baseline: zero allowed.
 *
 * Exit codes: 0 clean, 1 violations, 2 misconfiguration.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const REPO = join(dirname(new URL(import.meta.url).pathname), "..");
const SRC = join(REPO, "deploy/memrain/src");
const MIGRATIONS = join(SRC, "core/migrations");
const BASELINE = join(REPO, "scripts/scope-lint.baseline.json");
const SCOPED_DIRS = ["core", "mcp"];

export interface Literal { text: string; line: number }

/**
 * Every string and template literal in TypeScript source, comments skipped.
 * A template keeps its `${…}` expressions verbatim; templates nested inside an
 * expression are returned separately as well.
 */
export function extractLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  function scanTemplate(startLine: number): void {
    // i points just past the opening backtick.
    let text = "";
    while (i < n) {
      const c = src[i]!;
      if (c === "\\") { text += c + (src[i + 1] ?? ""); if (src[i + 1] === "\n") line++; i += 2; continue; }
      if (c === "`") { i++; out.push({ text, line: startLine }); return; }
      if (c === "$" && src[i + 1] === "{") {
        const exprStart = i;
        i += 2;
        scanCode(true);
        text += src.slice(exprStart, i);
        continue;
      }
      if (c === "\n") line++;
      text += c;
      i++;
    }
    out.push({ text, line: startLine });
  }

  function scanQuoted(q: string): void {
    const startLine = line;
    let text = "";
    i++;
    while (i < n) {
      const c = src[i]!;
      if (c === "\\") { text += c + (src[i + 1] ?? ""); i += 2; continue; }
      if (c === q) { i++; break; }
      if (c === "\n") { line++; break; }
      text += c;
      i++;
    }
    out.push({ text, line: startLine });
  }

  // Scans code; when `inExpr`, stops after the `}` that closes a template `${`.
  function scanCode(inExpr: boolean): void {
    let depth = 0;
    while (i < n) {
      const c = src[i]!;
      const d = src[i + 1];
      if (c === "\n") { line++; i++; continue; }
      if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && d === "*") {
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; }
        i += 2;
        continue;
      }
      if (c === "'" || c === "\"") { scanQuoted(c); continue; }
      if (c === "`") { const l = line; i++; scanTemplate(l); continue; }
      if (inExpr) {
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth === 0) { i++; return; }
          depth--;
        }
      }
      i++;
    }
  }

  scanCode(false);
  return out;
}

/** Tables that carry a `source_id` column, read from the migration files. */
export function sourceScopedTables(migrationsDir = MIGRATIONS): Set<string> {
  const tables = new Set<string>();
  const files = readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), "utf8").replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
      if (/(^|[\s,(])source_id\s+\w/i.test(m[2]!)) tables.add(m[1]!.toLowerCase());
    }
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?(\w+)"?([^;]*?)ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?source_id\b/gi)) {
      tables.add(m[1]!.toLowerCase());
    }
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?\s+RENAME\s+TO\s+"?(\w+)"?/gi)) {
      if (tables.delete(m[1]!.toLowerCase())) tables.add(m[2]!.toLowerCase());
    }
    for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi)) {
      tables.delete(m[1]!.toLowerCase());
    }
  }
  return tables;
}

const SCOPE_INTERPOLATION = /\$\{[^}]*(?:[sS]cope|sourceFilter|sourcePredicate|sourceClause)/;
const MARKER = /\/\/\s*scope:\s*(operator-only|upstream)\s+\S/;

/** True when a literal is a read of a source-scoped table without a source predicate. */
export function isUnscopedRead(text: string, tables: ReadonlySet<string>): boolean {
  if (!/\bSELECT\b/i.test(text)) return false;
  const touched = [...text.matchAll(/\b(?:FROM|JOIN)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)]
    .some(m => tables.has(m[1]!.toLowerCase()));
  if (!touched) return false;
  return !/\bsource_id\b/i.test(text) && !SCOPE_INTERPOLATION.test(text);
}

export interface ScopeHit { file: string; line: number }

export function findUnscopedReads(file: string, src: string, tables: ReadonlySet<string>): ScopeHit[] {
  const lines = src.split("\n");
  const marked = (line: number) => {
    for (let l = Math.max(1, line - 3); l <= line; l++) if (MARKER.test(lines[l - 1] ?? "")) return true;
    return false;
  };
  return extractLiterals(src)
    .filter(lit => isUnscopedRead(lit.text, tables) && !marked(lit.line))
    .map(lit => ({ file, line: lit.line }));
}

const POOLER_UNSAFE: Array<[RegExp, string]> = [
  [/\bpg_(?:try_)?advisory_(?:un)?lock(?:_shared|_all)?\s*\(/i, "session advisory lock (use pg_advisory_xact_lock)"],
  // SQL keywords are written upper-case here; prose such as "Set MEMRAIN_X=1" is not SQL.
  [/^\s*(?:UN)?LISTEN\s+[\w*]/, "LISTEN/UNLISTEN outlives the transaction"],
  [/^\s*SET\s+(?:SESSION\s+)?(?!LOCAL\b|TRANSACTION\b|CONSTRAINTS\b)[A-Za-z_][\w.]*\s*(?:=|TO\b)/, "session SET (use SET LOCAL)"],
  [/\bset_config\s*\([^)]*,\s*false\s*\)/i, "set_config(..., false) is session-scoped"],
];

export function findPoolerUnsafe(file: string, src: string): Array<ScopeHit & { why: string }> {
  const hits: Array<ScopeHit & { why: string }> = [];
  for (const lit of extractLiterals(src)) {
    for (const [re, why] of POOLER_UNSAFE) if (re.test(lit.text)) hits.push({ file, line: lit.line, why });
  }
  return hits;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

export function countUnscoped(tables: ReadonlySet<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const dir of SCOPED_DIRS) {
    for (const path of tsFiles(join(SRC, dir)).sort()) {
      const rel = relative(SRC, path);
      const hits = findUnscopedReads(rel, readFileSync(path, "utf8"), tables);
      if (hits.length) counts[rel] = hits.length;
    }
  }
  return counts;
}

function main(): number {
  if (!existsSync(SRC) || !existsSync(MIGRATIONS)) {
    console.error(`[scope-lint] ERROR: source tree not found under ${SRC}`);
    return 2;
  }
  const tables = sourceScopedTables();
  if (tables.size === 0) {
    console.error("[scope-lint] ERROR: no source_id tables parsed from the migrations");
    return 2;
  }
  let failed = false;

  for (const path of tsFiles(SRC)) {
    for (const h of findPoolerUnsafe(relative(SRC, path), readFileSync(path, "utf8"))) {
      console.error(`[scope-lint] FAIL: ${h.file}:${h.line}: ${h.why}`);
      failed = true;
    }
  }

  const counts = countUnscoped(tables);
  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`[scope-lint] baseline rewritten: ${Object.keys(counts).length} files`);
    return failed ? 1 : 0;
  }
  const baseline: Record<string, number> = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
  for (const file of new Set([...Object.keys(counts), ...Object.keys(baseline)])) {
    const now = counts[file] ?? 0;
    const allowed = baseline[file] ?? 0;
    if (now > allowed) {
      const lines = findUnscopedReads(file, readFileSync(join(SRC, file), "utf8"), tables).map(h => h.line).join(", ");
      console.error(`[scope-lint] FAIL: ${file}: ${now} unscoped read(s) of source_id tables, baseline ${allowed} (lines ${lines}).`);
      console.error("[scope-lint]   Add the source predicate (andSourceScope) or mark the read `// scope: operator-only <reason>`.");
      failed = true;
    } else if (now < allowed) {
      console.error(`[scope-lint] FAIL: ${file}: ${now} unscoped read(s), baseline ${allowed}; lower the baseline (bun scripts/scope-lint.ts --update).`);
      failed = true;
    }
  }
  if (failed) return 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`[scope-lint] OK: ${tables.size} source_id tables; ${total} baselined unscoped reads; no pooler-unsafe statements`);
  return 0;
}

if (import.meta.main) process.exit(main());
