/**
 * A maintenance phase that reads a document's stored `source_path` off disk
 * must go through `readGuardedFile` (core/sources.ts): a remote inline `index`
 * labels its row with any path, and a bare read copies the daemon's file into
 * that caller's document. This ratchet keeps new bare reads out of the hourly
 * housekeeping, and keeps `indexFile` judging the stored row before it reads,
 * so a new caller is safe without a check of its own.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

const BARE_READ = /\b(?:readFileSync|readFile|createReadStream|openSync)\s*\(|\bBun\.file\s*\(/g;

// Modules whose file reads start from a database row.
const GUARDED = ["core/housekeeping.ts"];


function tsFiles(dir: string): string[] {
  if (!statSync(dir).isDirectory()) return [dir];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");
}

function hits(file: string, pattern: RegExp): string[] {
  const code = stripComments(readFileSync(file, "utf8"));
  return [...code.matchAll(pattern)].map((m) => {
    const line = code.slice(0, m.index).split("\n").length;
    return `${relative(SRC, file)}:${line}: ${m[0]}`;
  });
}

describe("re-read guard ratchet", () => {
  it("housekeeping reads no file except through readGuardedFile", () => {
    const found = GUARDED.flatMap((d) => tsFiles(join(SRC, d))).flatMap((f) => hits(f, BARE_READ));
    expect(found).toEqual([]);
  });

  it("indexFile judges the stored row before it reads the file", () => {
    for (const [file, fn] of [["core/indexer.ts", "indexFile"]] as const) {
      const code = stripComments(readFileSync(join(SRC, file), "utf8"));
      const start = code.indexOf(`export async function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const body = code.slice(start, code.indexOf("\n}\n", start));
      const guard = body.indexOf("guardLocalIndex(");
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(body.search(BARE_READ));
    }
  });

  it("readGuardedFile stats the file before reading it", () => {
    // Stat first, so a write between the two can only pair older text with an
    // older mtime, which the next sweep sees as stale, never the reverse.
    const code = stripComments(readFileSync(join(SRC, "core/sources.ts"), "utf8"));
    const start = code.indexOf("export function readGuardedFile(");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf("\n}\n", start));
    const stat = body.indexOf("statSync(");
    expect(stat).toBeGreaterThan(-1);
    expect(stat).toBeLessThan(body.indexOf("readFileSync("));
  });

  it("detects the shapes it is meant to forbid", () => {
    const probe = "const t = readFileSync(row.source_path, 'utf8'); await Bun.file(p).text(); fs.readFile (p);";
    expect([...probe.matchAll(BARE_READ)].length).toBe(3);
    expect([..."readGuardedFile(guard, p, s)".matchAll(BARE_READ)].length).toBe(0);
  });
});
