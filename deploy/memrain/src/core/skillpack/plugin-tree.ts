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
import { dirname, join, posix } from "node:path";
import { OPERATOR_ONLY_TOOLS } from "../../mcp/visibility.ts";
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
  /**
   * Skills the brain serves but the plugin leaves out for another reason
   * (unsuited to a client install, or they hand off to a skill the plugin
   * does not ship), each with the reason.
   */
  excluded: Record<string, string>;
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
    excluded: reasonMap(r.excluded, "excluded"),
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

/** Every folder of the pack that holds a skill, sorted. */
function packSkills(skillsDir: string): string[] {
  return readdirSync(skillsDir)
    .filter((name) => /^[a-z0-9][a-z0-9-]*$/.test(name) && existsSync(skillFile(skillsDir, name)))
    .sort();
}

const DECISION_LANES = ["plugin", "operator_only", "excluded"] as const;

/**
 * What keeps a plugin skill usable on a client install, for each skill in
 * the plugin lane: it names no operator-only tool, every skill it hands off
 * to (a `skills/<slug>` path or a `get_skill <slug>` call) ships in the
 * plugin too, every shared rule it defers to (`_<name>`,
 * `conventions/<name>`, which the brain serves to any client) exists, and
 * every relative link lands on a file the plugin ships.
 */
export function pluginClosureErrors(
  lanes: PluginLanes,
  skillsDir: string,
  operatorTools: ReadonlySet<string> = OPERATOR_ONLY_TOOLS,
): string[] {
  const errors = new Set<string>();
  const shipped = new Set(Object.keys(lanes.plugin));
  const skills = new Set(packSkills(skillsDir));
  const shippedFiles = new Set<string>();
  for (const slug of shipped) {
    if (!skills.has(slug)) continue;
    for (const rel of listFiles(join(skillsDir, slug))) shippedFiles.add(`${slug}/${rel}`);
  }
  const sharedRuleExists = (target: string): boolean => {
    if (target.startsWith("conventions/")) {
      const name = target.slice("conventions/".length);
      return /^[a-z0-9][\w.-]*$/i.test(name) && !name.includes("..")
        && existsSync(join(skillsDir, "conventions", name.includes(".") ? name : `${name}.md`));
    }
    return /^_[a-z0-9][\w-]*$/i.test(target) && existsSync(join(skillsDir, `${target}.md`));
  };
  const checkTarget = (slug: string, target: string): void => {
    if (target.startsWith("_") || target.startsWith("conventions/")) {
      if (!sharedRuleExists(target)) errors.add(`plugin: ${slug} defers to ${target}, which is not a shared rule in the pack`);
    } else if (!skills.has(target)) {
      errors.add(`plugin: ${slug} hands off to ${target}, which is not a skill in the pack`);
    } else if (!shipped.has(target)) {
      errors.add(`plugin: ${slug} hands off to ${target}, which the plugin does not ship`);
    }
  };
  for (const slug of [...shipped].sort()) {
    if (!skills.has(slug)) continue;
    for (const rel of listFiles(join(skillsDir, slug))) {
      if (!rel.endsWith(".md")) continue;
      const text = readFileSync(join(skillsDir, slug, rel), "utf8");
      for (const tool of operatorTools) {
        if (text.includes(`\`${tool}\``) || new RegExp(`^\\s+- ${tool}$`, "m").test(text)) {
          errors.add(`plugin: ${slug} names operator-only tool ${tool}`);
        }
      }
      for (const m of text.matchAll(/skills\/(_?[a-z0-9][\w-]*)(?![\w-])/g)) {
        const target = m[1]!;
        if (target !== slug && target !== "conventions") checkTarget(slug, target);
      }
      for (const m of text.matchAll(/`get_skill ([^`\s]+)`/g)) {
        if (m[1] !== slug) checkTarget(slug, m[1]!);
      }
      for (const m of text.matchAll(/\]\((\.{1,2}\/[^)\s]+)\)/g)) {
        const link = m[1]!;
        if (/[<{$]/.test(link)) continue;
        const target = posix.normalize(posix.join(posix.dirname(`${slug}/${rel}`), link.split("#")[0]!));
        if (target.startsWith("../") || !shippedFiles.has(target)) {
          errors.add(`plugin: ${slug} links ${link}, which the plugin does not ship`);
        }
      }
    }
  }
  return [...errors];
}

/** A heading over text that tells neighbouring skills apart rather than handing work to them. */
const BOUNDARY_HEADING = /sharp boundaries|related skills|see also|integration/i;

/**
 * Hand-offs a plugin skill makes in prose to a skill the plugin does not
 * ship, as `<skill> -> <target>`, sorted: the target named as `` `slug` ``,
 * `**slug**` or "slug skill". Sections that only tell neighbours apart
 * (`BOUNDARY_HEADING`) are skipped. Unlike `pluginClosureErrors` these are
 * not lane errors: prose cannot be checked exactly, so the test pins the
 * list and it may only shrink.
 */
export function pluginProseHandOffs(lanes: PluginLanes, skillsDir: string): string[] {
  const shipped = new Set(Object.keys(lanes.plugin));
  const outside = new Set(packSkills(skillsDir).filter((s) => !shipped.has(s)));
  const found = new Set<string>();
  for (const slug of [...shipped].sort()) {
    if (!existsSync(skillFile(skillsDir, slug))) continue;
    let boundary = false;
    for (const line of readFileSync(skillFile(skillsDir, slug), "utf8").split("\n")) {
      if (/^#{1,6} /.test(line)) boundary = BOUNDARY_HEADING.test(line);
      if (boundary) continue;
      for (const m of line.matchAll(/`([a-z0-9][a-z0-9-]*)`|\*\*([a-z0-9][a-z0-9-]*)\*\*|\b([a-z0-9][a-z0-9-]*) skill\b/g)) {
        const target = m[1] ?? m[2] ?? m[3]!;
        if (outside.has(target)) found.add(`${slug} -> ${target}`);
      }
    }
  }
  return [...found].sort();
}

/**
 * Every problem with the lanes record; empty when it is sound. Each skill in
 * the pack is a recorded decision: it sits in exactly one of `plugin`,
 * `operator_only` and `excluded`, with a reason, and the plugin lane is
 * closed under hand-offs (`pluginClosureErrors`).
 */
export function validateLanes(
  lanes: PluginLanes,
  skillsDir: string,
  operatorTools: ReadonlySet<string> = OPERATOR_ONLY_TOOLS,
): string[] {
  const errors: string[] = [];
  const named: Array<[string, string]> = [
    ...DECISION_LANES.flatMap((lane) => Object.keys(lanes[lane]).map((s): [string, string] => [lane, s])),
    ...lanes.starter.map((s): [string, string] => ["starter", s]),
  ];
  for (const [lane, slug] of named) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || !existsSync(skillFile(skillsDir, slug))) {
      errors.push(`${lane}: ${slug} is not a skill in the pack`);
    }
  }
  for (const lane of DECISION_LANES) {
    for (const [slug, reason] of Object.entries(lanes[lane])) {
      if (reason.trim() === "") errors.push(`${lane}: ${slug} has no reason`);
    }
  }
  for (const slug of packSkills(skillsDir)) {
    const placed = DECISION_LANES.filter((lane) => Object.hasOwn(lanes[lane], slug));
    if (placed.length === 0) errors.push(`${slug} is in no lane: add it to plugin, operator_only or excluded with a reason`);
    if (placed.length > 1) errors.push(`${slug} is in more than one lane: ${placed.join(", ")}`);
  }
  errors.push(...pluginClosureErrors(lanes, skillsDir, operatorTools));
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
