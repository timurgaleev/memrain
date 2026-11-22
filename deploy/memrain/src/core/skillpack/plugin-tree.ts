/**
 * skillpack/plugin-tree.ts — one source for the brain's skillpack and the
 * Claude Code / Codex plugin.
 *
 * `deploy/skills/` is the only place a skill is edited. Three things are
 * derived from it and committed, so a reviewer sees them change:
 *   - `plugins/memrain/skills/<slug>/` for every skill in the plugin lane of
 *     `plugin-lanes.json` (both hosts read that one folder);
 *   - the generated block of `_resolver.md`, the routing table rendered from
 *     each skill's frontmatter, served through `get_skill _resolver` (the
 *     page's hand-written text around the block is kept);
 *   - `skills.lock.json`, the sha256 of every pack file.
 * `scripts/generate-plugin-tree.ts` writes them; the tests compare the
 * committed copies with a fresh render, so a skill edited without
 * regenerating fails CI instead of drifting.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listSkillCatalog } from "./brain-resident.ts";
import { parseSkillFrontmatter } from "./frontmatter.ts";

export const LANES_FILE = "plugin-lanes.json";
export const LOCK_FILE = "skills.lock.json";
export const RESOLVER_FILE = "_resolver.md";

export interface PluginLanes {
  /** Skills copied into the plugin, each with the reason it ships there. */
  plugin: Record<string, string>;
  /** Host-side skills that never ship in the plugin, each with the reason. */
  operator_only: Record<string, string>;
  /** Skills served as MCP prompts (`prompt: true` in their frontmatter). */
  starter: string[];
}

function reasonMap(value: unknown, key: string): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${LANES_FILE}: ${key} must be an object of slug → reason`);
  }
  const out: Record<string, string> = {};
  for (const [slug, reason] of Object.entries(value)) {
    if (typeof reason !== "string") throw new Error(`${LANES_FILE}: ${key}.${slug} must be a string`);
    out[slug] = reason;
  }
  return out;
}

export function readPluginLanes(skillsDir: string): PluginLanes {
  const raw: unknown = JSON.parse(readFileSync(join(skillsDir, LANES_FILE), "utf8"));
  if (raw === null || typeof raw !== "object") throw new Error(`${LANES_FILE}: expected an object`);
  const r = raw as Record<string, unknown>;
  const starter = r.starter;
  if (!Array.isArray(starter) || starter.some((s) => typeof s !== "string")) {
    throw new Error(`${LANES_FILE}: starter must be a list of slugs`);
  }
  return {
    plugin: reasonMap(r.plugin, "plugin"),
    operator_only: reasonMap(r.operator_only, "operator_only"),
    starter: starter as string[],
  };
}

function skillFile(skillsDir: string, slug: string): string {
  return join(skillsDir, slug, "SKILL.md");
}

function isPrompt(skillsDir: string, slug: string): boolean {
  const fm = parseSkillFrontmatter(readFileSync(skillFile(skillsDir, slug), "utf8"));
  return fm?.scalars.prompt === "true";
}

/** Every problem with the lanes record; empty when it is sound. */
export function validateLanes(lanes: PluginLanes, skillsDir: string): string[] {
  const errors: string[] = [];
  const named: Array<[string, string]> = [
    ...Object.keys(lanes.plugin).map((s): [string, string] => ["plugin", s]),
    ...Object.keys(lanes.operator_only).map((s): [string, string] => ["operator_only", s]),
    ...lanes.starter.map((s): [string, string] => ["starter", s]),
  ];
  for (const [lane, slug] of named) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || !existsSync(skillFile(skillsDir, slug))) {
      errors.push(`${lane}: ${slug} is not a skill in the pack`);
    }
  }
  for (const [lane, map] of [["plugin", lanes.plugin], ["operator_only", lanes.operator_only]] as const) {
    for (const [slug, reason] of Object.entries(map)) {
      if (reason.trim() === "") errors.push(`${lane}: ${slug} has no reason`);
    }
  }
  for (const slug of Object.keys(lanes.plugin)) {
    if (Object.hasOwn(lanes.operator_only, slug)) errors.push(`plugin: ${slug} is operator-only`);
  }
  for (const slug of lanes.starter) {
    if (existsSync(skillFile(skillsDir, slug)) && !isPrompt(skillsDir, slug)) {
      errors.push(`starter: ${slug} is not served as a prompt`);
    }
  }
  return errors;
}

/**
 * Regular files under `dir`, as `/`-joined paths relative to it, sorted. A
 * symbolic link anywhere, `dir` itself included, is refused: following one
 * would copy from, or write and delete in, a tree outside the pack.
 */
function listFiles(dir: string, prefix = ""): string[] {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return [];
  }
  if (st.isSymbolicLink()) throw new Error(`plugin tree: ${prefix === "" ? dir : prefix} is a symbolic link`);
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    const st = lstatSync(full);
    if (st.isSymbolicLink()) throw new Error(`plugin tree: ${rel} is a symbolic link`);
    if (st.isDirectory()) out.push(...listFiles(full, rel));
    else if (st.isFile()) out.push(rel);
  }
  return out;
}

/** What `plugins/memrain/skills/` must hold: relative path → bytes. */
export function planPluginTree(skillsDir: string, lanes: PluginLanes = readPluginLanes(skillsDir)): Map<string, Buffer> {
  const plan = new Map<string, Buffer>();
  for (const slug of Object.keys(lanes.plugin).sort()) {
    for (const rel of listFiles(join(skillsDir, slug))) {
      plan.set(`${slug}/${rel}`, readFileSync(join(skillsDir, slug, rel)));
    }
  }
  return plan;
}

/** Plugin files that are missing, extra or different; empty when in sync. */
export function diffPluginTree(skillsDir: string, pluginSkillsDir: string): string[] {
  const plan = planPluginTree(skillsDir);
  const actual = new Set(listFiles(pluginSkillsDir));
  const drift = new Set<string>();
  for (const [rel, bytes] of plan) {
    if (!actual.has(rel) || !readFileSync(join(pluginSkillsDir, rel)).equals(bytes)) drift.add(rel);
  }
  for (const rel of actual) if (!plan.has(rel)) drift.add(rel);
  return [...drift].sort();
}

/** Make `pluginSkillsDir` hold exactly the plan; returns the paths changed. */
export function writePluginTree(skillsDir: string, pluginSkillsDir: string): string[] {
  const changed = diffPluginTree(skillsDir, pluginSkillsDir);
  const plan = planPluginTree(skillsDir);
  for (const rel of changed) {
    const target = join(pluginSkillsDir, rel);
    const bytes = plan.get(rel);
    if (bytes === undefined) {
      rmSync(target, { force: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  for (const name of readdirSync(pluginSkillsDir)) {
    const full = join(pluginSkillsDir, name);
    if (lstatSync(full).isDirectory() && listFiles(full).length === 0) rmSync(full, { recursive: true });
  }
  return changed;
}

/** The lock file's text: sha256 of every pack file but the lock itself. */
export function renderLock(skillsDir: string): string {
  const hashes: Record<string, string> = {};
  for (const rel of listFiles(skillsDir)) {
    if (rel === LOCK_FILE) continue;
    hashes[rel] = createHash("sha256").update(readFileSync(join(skillsDir, rel))).digest("hex");
  }
  return `${JSON.stringify(hashes, null, 2)}\n`;
}

function cell(text: string): string {
  return text.replace(/`/g, "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

function firstSentence(text: string): string {
  const flat = cell(text);
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.length > 220 ? `${sentence.slice(0, 217)}...` : sentence;
}

export const RESOLVER_BEGIN = "<!-- BEGIN GENERATED: skill table, from frontmatter by scripts/generate-plugin-tree.ts -->";
export const RESOLVER_END = "<!-- END GENERATED: skill table -->";

/** The `|`-table rows of the generated block: one per routable skill. */
function skillRows(skillsDir: string, lanes: PluginLanes): string[] {
  const starter = new Set(lanes.starter);
  return listSkillCatalog({ skillsDir }).skills.map((s) => {
    const ships = Object.hasOwn(lanes.plugin, s.slug)
      ? "plugin"
      : Object.hasOwn(lanes.operator_only, s.slug) ? "operator only" : "brain";
    const lane = starter.has(s.slug) ? `${ships}, prompt` : ships;
    const triggers = s.triggers.map((t) => `"${cell(t)}"`).join(", ");
    return `| \`${s.slug}\` | ${firstSentence(s.description)} | ${triggers} | ${s.mutating ? "yes" : "no"} | ${lane} |`;
  });
}

/** A shared doc's label: its frontmatter description, else its first heading. */
function docLabel(text: string): string {
  const description = parseSkillFrontmatter(text)?.description;
  if (description) return firstSentence(description);
  const heading = text.split("\n").find((l) => l.startsWith("# "));
  return heading === undefined ? "" : cell(heading.slice(2));
}

/** One row per shared rule a skill defers to: `_*.md` and `conventions/*.md`. */
function sharedRuleRows(skillsDir: string): string[] {
  const docs: string[] = [];
  for (const name of readdirSync(skillsDir).sort()) {
    if (name.startsWith("_") && name.endsWith(".md") && name !== RESOLVER_FILE) docs.push(name);
  }
  const conventions = join(skillsDir, "conventions");
  if (existsSync(conventions)) {
    for (const name of readdirSync(conventions).sort()) {
      if (name.endsWith(".md")) docs.push(`conventions/${name}`);
    }
  }
  return docs.map((rel) => {
    const label = docLabel(readFileSync(join(skillsDir, rel), "utf8"));
    return `| \`${rel.slice(0, -3)}\` | ${label} |`;
  });
}

function generatedBlock(skillsDir: string, lanes: PluginLanes): string[] {
  return [
    RESOLVER_BEGIN,
    "",
    "| Skill | Use it for | Triggers | Writes | Ships in |",
    "|---|---|---|---|---|",
    ...skillRows(skillsDir, lanes),
    "",
    "Shared rules the skills defer to, each read with `get_skill <slug>`:",
    "",
    "| Slug | Rule |",
    "|---|---|",
    ...sharedRuleRows(skillsDir),
    "",
    RESOLVER_END,
  ];
}

const DEFAULT_RESOLVER_HEAD = [
  "# Skill Resolver",
  "",
  "The skill table below is generated from each skill's frontmatter by",
  "`scripts/generate-plugin-tree.ts` in `deploy/memrain`; edit the skills, not",
  "the table. Text outside the generated block is written by hand and kept.",
  "",
];

/**
 * The resolver page: the hand-written text of `current` with its generated
 * block re-rendered from every routable skill's frontmatter. No page gets the
 * default head and the block. A page without exactly one begin marker before
 * one end marker is refused: guessing which text is hand-written would drop
 * someone's edit.
 */
export function renderResolver(skillsDir: string, lanes: PluginLanes, current: string | null = null): string {
  const block = generatedBlock(skillsDir, lanes).join("\n");
  if (current === null) return [...DEFAULT_RESOLVER_HEAD, block, ""].join("\n");
  const at = current.indexOf(RESOLVER_BEGIN);
  const endAt = current.indexOf(RESOLVER_END);
  if (current.split(RESOLVER_BEGIN).length !== 2 || current.split(RESOLVER_END).length !== 2 || endAt < at) {
    throw new Error(`${RESOLVER_FILE}: the generated block needs exactly one ${RESOLVER_BEGIN} before one ${RESOLVER_END}`);
  }
  return current.slice(0, at) + block + current.slice(endAt + RESOLVER_END.length);
}
