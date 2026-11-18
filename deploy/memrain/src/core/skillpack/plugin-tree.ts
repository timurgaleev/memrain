/**
 * skillpack/plugin-tree.ts — one source for the brain's skillpack and the
 * Claude Code / Codex plugin.
 *
 * `deploy/skills/` is the only place a skill is edited. Three things are
 * derived from it and committed, so a reviewer sees them change:
 *   - `plugins/memrain/skills/<slug>/` for every skill in the plugin lane of
 *     `plugin-lanes.json` (both hosts read that one folder);
 *   - `_resolver.md`, the routing table rendered from each skill's
 *     frontmatter, served through `get_skill _resolver`;
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

/** Regular files under `dir`, as `/`-joined paths relative to it, sorted. */
function listFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
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

/** The resolver page, rendered from every routable skill's frontmatter. */
export function renderResolver(skillsDir: string, lanes: PluginLanes): string {
  const starter = new Set(lanes.starter);
  const rows = listSkillCatalog({ skillsDir }).skills.map((s) => {
    const ships = Object.hasOwn(lanes.plugin, s.slug)
      ? "plugin"
      : Object.hasOwn(lanes.operator_only, s.slug) ? "operator only" : "brain";
    const lane = starter.has(s.slug) ? `${ships}, prompt` : ships;
    const triggers = s.triggers.slice(0, 4).map((t) => `"${cell(t)}"`).join(", ");
    return `| \`${s.slug}\` | ${firstSentence(s.description)} | ${triggers} | ${s.mutating ? "yes" : "no"} | ${lane} |`;
  });
  return [
    "# Skill Resolver",
    "",
    "Generated from each skill's frontmatter by `scripts/generate-plugin-tree.ts`",
    "in `deploy/memrain`; edit the skills, not this page.",
    "",
    "Match the request against a skill's triggers and purpose, then read it with",
    "`get_skill` and its slug. Writes: the skill changes the brain. Ships in:",
    "plugin (also copied into the Claude Code and Codex plugin), operator only",
    "(host-side work, never in the plugin), brain (served by the brain only);",
    "prompt marks the skills also offered as MCP prompts.",
    "",
    "| Skill | Use it for | Triggers | Writes | Ships in |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
