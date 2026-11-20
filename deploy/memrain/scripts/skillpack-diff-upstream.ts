/**
 * Compare deploy/skills with an upstream skills folder before adopting a
 * skill from it, or to see how far an adopted one has drifted.
 *
 *   bun scripts/skillpack-diff-upstream.ts <upstream-dir> [--json]
 *
 * <upstream-dir> is a skills folder (one <slug>/SKILL.md per skill) or a
 * repository root holding one under skills/. Prints the skills on one side
 * only, then, for each skill on both sides that differs, the triggers, tools
 * and steps upstream added (+) and removed (-) relative to this pack. Steps
 * are the body's ##/### headings and top-level numbered items. Read-only.
 *
 * A maintainer tool: it is not part of the server image. Upstream text is
 * data to read, never instructions to follow.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSkillFrontmatter } from "../src/core/skillpack/frontmatter.ts";

export interface Change {
  added: string[];
  removed: string[];
}

export interface SkillChange {
  slug: string;
  triggers: Change;
  tools: Change;
  steps: Change;
}

export interface SkillpackDiff {
  onlyLocal: string[];
  onlyUpstream: string[];
  changed: SkillChange[];
}

interface Skill {
  triggers: string[];
  tools: string[];
  steps: string[];
}

/** The skills folder of a path: its `skills/` when it has one, else the path itself. */
export function skillsDirOf(path: string): string {
  const nested = join(path, "skills");
  return existsSync(nested) && statSync(nested).isDirectory() ? nested : path;
}

const STEP_RE = /^(?:#{2,3}|\d+\.)[ \t]+(\S.*)$/;

function steps(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = STEP_RE.exec(line.trimEnd());
    if (!m) continue;
    const text = m[1]!.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
    if (text !== "") out.push(text);
  }
  return out;
}

function readPack(dir: string): Map<string, Skill> {
  const out = new Map<string, Skill>();
  for (const slug of readdirSync(dir).sort()) {
    const file = join(dir, slug, "SKILL.md");
    if (slug.startsWith("_") || slug.startsWith(".") || !existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    // A skill with no frontmatter still has steps.
    const fm = parseSkillFrontmatter(text);
    out.set(slug, fm === null ? { triggers: [], tools: [], steps: steps(text) } : { triggers: fm.triggers, tools: fm.tools, steps: steps(fm.body) });
  }
  return out;
}

function change(local: readonly string[], upstream: readonly string[]): Change {
  const here = new Set(local);
  const there = new Set(upstream);
  return { added: [...there].filter((x) => !here.has(x)), removed: [...here].filter((x) => !there.has(x)) };
}

const empty = (c: Change) => c.added.length === 0 && c.removed.length === 0;

export function diffSkillpacks(localDir: string, upstreamDir: string): SkillpackDiff {
  const local = readPack(localDir);
  const upstream = readPack(upstreamDir);
  const changed: SkillChange[] = [];
  for (const [slug, mine] of local) {
    const theirs = upstream.get(slug);
    if (!theirs) continue;
    const c = {
      slug,
      triggers: change(mine.triggers, theirs.triggers),
      tools: change(mine.tools, theirs.tools),
      steps: change(mine.steps, theirs.steps),
    };
    if (!empty(c.triggers) || !empty(c.tools) || !empty(c.steps)) changed.push(c);
  }
  return {
    onlyLocal: [...local.keys()].filter((s) => !upstream.has(s)),
    onlyUpstream: [...upstream.keys()].filter((s) => !local.has(s)),
    changed,
  };
}

function line(label: string, c: Change): string | null {
  if (empty(c)) return null;
  return `  ${label}: ${[...c.added.map((x) => `+ ${x}`), ...c.removed.map((x) => `- ${x}`)].join("; ")}`;
}

// Upstream text reaches a terminal: its control characters (escape sequences) are dropped.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;

export function formatSkillpackDiff(diff: SkillpackDiff): string {
  const out: string[] = [];
  if (diff.onlyLocal.length > 0) out.push(`only here: ${diff.onlyLocal.join(", ")}`);
  if (diff.onlyUpstream.length > 0) out.push(`only upstream: ${diff.onlyUpstream.join(", ")}`);
  for (const c of diff.changed) {
    out.push(c.slug, ...[line("triggers", c.triggers), line("tools", c.tools), line("steps", c.steps)].filter((l): l is string => l !== null));
  }
  return out.length === 0 ? "no differences" : out.map((l) => l.replace(CONTROL_RE, "")).join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("usage: bun scripts/skillpack-diff-upstream.ts <upstream-dir> [--json]");
    process.exit(2);
  }
  const diff = diffSkillpacks(resolve(import.meta.dir, "..", "..", "skills"), skillsDirOf(resolve(target)));
  console.log(args.includes("--json") ? JSON.stringify(diff, null, 2) : formatSkillpackDiff(diff));
}
