/**
 * skillpack/brain-resident.ts — server-side discovery of the brain-resident
 * skillpack for the `list_brain_skillpack` MCP tool.
 *
 * memrain is single-holder / single-source: it ships ONE local skillpack (the
 * `deploy/skills/` directory `memrain skillpack` bundles), not per-federated-source
 * packs. So discovery collapses to "read the local skills
 * dir and surface its offerings as a read" — there is no in-DB source tenancy
 * to scope by, and no git-remote scaffold spec to hand a thin client.
 *
 * This REUSES what `commands/skillpack.ts` already knows (the default skills
 * dir, the `.md`-per-skill layout) and the skill frontmatter contract
 * `frontmatter.ts` parses. Read-only: no writes, no LLM, no filesystem path
 * leaked to the client. `listBrainSkillpacks` surfaces slug + description;
 * `listSkillCatalog` adds the routing contract (triggers, tools, mutating)
 * and splits each skill's tools into what the caller can and cannot call.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATIONS } from "../../mcp/operations.ts";
import { parseSkillFrontmatter, type SkillFrontmatter } from "./frontmatter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * Same default the `memrain skillpack` command bundles from (deploy/skills/).
 * In the container the repo-relative path does not exist (the image copies
 * only deploy/memrain), so the compose file mounts the pack read-only and
 * points MEMRAIN_SKILLS_DIR at it.
 */
export const DEFAULT_SKILLS_DIR =
  process.env.MEMRAIN_SKILLS_DIR && process.env.MEMRAIN_SKILLS_DIR.trim().length > 0
    ? process.env.MEMRAIN_SKILLS_DIR
    : resolve(__dirname, "..", "..", "..", "..", "skills");

const PACK_NAME = "memrain-skillpack";
const NO_DESCRIPTION = "(no description)";

export interface BrainSkill {
  slug: string;
  description: string;
}

export interface BrainSkillpackResult {
  /** The pack name (stable; memrain ships a single pack). */
  pack: string;
  /** Number of skills discovered. */
  count: number;
  skills: BrainSkill[];
}

export interface ListBrainSkillpacksOptions {
  /** Override the source skills dir (tests point this at a fixture). */
  skillsDir?: string;
}

export interface SkillCatalogOptions extends ListBrainSkillpacksOptions {
  /**
   * Whether this caller may call a tool — the `tools/list` predicate. Omitted
   * = every tool the server has. A tool the server does not have is
   * unavailable whatever this says.
   */
  callable?: (toolName: string) => boolean;
}

export interface SkillCatalogEntry {
  slug: string;
  description: string;
  triggers: string[];
  /** Every tool the skill declares. */
  tools: string[];
  /** Declared tools this caller can call. */
  usable_tools: string[];
  /** Declared tools the server lacks or this caller may not call. */
  unavailable_tools: string[];
  /** Whether running the skill changes the brain; undeclared reads as false. */
  mutating: boolean;
  requires: string[];
  writes_to: string[];
}

export interface SkillCatalog {
  pack: string;
  count: number;
  schema_version: 1;
  skills: SkillCatalogEntry[];
  instructions: {
    summary: string;
    how_to_use: string[];
    fetch_op: "get_skill";
  };
}

/** The frontmatter fields a client is shown — never the raw parse. */
export interface SkillFrontmatterProjection {
  name: string | null;
  description: string | null;
  triggers: string[];
  tools: string[];
  mutating: boolean | null;
  requires: string[];
  writes_to: string[];
}

export interface SkillDetail {
  slug: string;
  description: string;
  /** Full markdown of the skill file (frontmatter included). */
  body: string;
  /** Null for a doc without frontmatter (shared rules, conventions). */
  frontmatter: SkillFrontmatterProjection | null;
  usable_tools: string[];
  unavailable_tools: string[];
}

const CATALOG_INSTRUCTIONS: SkillCatalog["instructions"] = {
  summary:
    "Skills are written procedures for recurring brain work. Pick one by matching the task against its triggers and description, then fetch the full text with get_skill.",
  how_to_use: [
    "Match the user's request against each skill's triggers (phrases) and description; prefer the most specific match.",
    "Call get_skill with the skill's slug and follow its body.",
    "Use only the tools listed in usable_tools; unavailable_tools are not on this server or outside your grant, so skip or report those steps.",
    "A skill with mutating: true writes to the brain; confirm the target before running it.",
  ],
  fetch_op: "get_skill",
};

interface SkillFile {
  slug: string;
  file: string;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read and parse a skill file. A file that cannot be read or has no
 * frontmatter parses to null, so a malformed skill never aborts the listing.
 */
function readSkillFrontmatter(skillFile: string): SkillFrontmatter | null {
  const text = readText(skillFile);
  return text === null ? null : parseSkillFrontmatter(text);
}

/**
 * The routable skills under `skillsDir`, byte-ordered by slug. Fail-open: a
 * missing or unreadable dir is an empty list.
 *
 * Two layouts, both supported:
 *   flat:      <skillsDir>/<slug>.md          (the original memrain shape)
 *   directory: <skillsDir>/<slug>/SKILL.md    (the shipped pack's shape)
 * Underscore-prefixed files (shared cross-cutting rules, not routable
 * skills) and non-skill artifacts (manifest.json, conventions/) are
 * excluded from the ENUMERATION but stay reachable via get_skill.
 */
function enumerateSkillFiles(skillsDir: string): SkillFile[] {
  if (!existsSync(skillsDir)) return [];
  const entries: SkillFile[] = [];
  try {
    for (const name of readdirSync(skillsDir)) {
      if (name.startsWith("_") || name.startsWith(".")) continue;
      if (name === "conventions") continue;
      const full = join(skillsDir, name);
      if (name.endsWith(".md")) {
        entries.push({ slug: name.replace(/\.md$/, ""), file: full });
        continue;
      }
      const skillFile = join(full, "SKILL.md");
      if (existsSync(skillFile)) entries.push({ slug: name, file: skillFile });
    }
  } catch {
    return [];
  }
  // Deterministic ordering: byte-order by slug so the listing is stable
  // across filesystems (mirrors the keyword tie-break discipline elsewhere).
  entries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return entries;
}

const SERVER_TOOLS: ReadonlySet<string> = new Set(OPERATIONS.map((o) => o.name));

function splitTools(
  tools: readonly string[],
  callable: (toolName: string) => boolean,
): { usable_tools: string[]; unavailable_tools: string[] } {
  const usable_tools: string[] = [];
  const unavailable_tools: string[] = [];
  for (const tool of tools) {
    if (SERVER_TOOLS.has(tool) && callable(tool)) usable_tools.push(tool);
    else unavailable_tools.push(tool);
  }
  return { usable_tools, unavailable_tools };
}

const ALL_CALLABLE = (): boolean => true;

/**
 * Enumerate the brain-resident skillpack offerings. Fail-open: a missing skills
 * dir (memrain ships none by default) returns an empty pack rather than throwing,
 * so the MCP tool always returns a well-formed result.
 */
export function listBrainSkillpacks(
  opts: ListBrainSkillpacksOptions = {},
): BrainSkillpackResult {
  const skills: BrainSkill[] = enumerateSkillFiles(opts.skillsDir ?? DEFAULT_SKILLS_DIR).map((e) => ({
    slug: e.slug,
    description: readSkillFrontmatter(e.file)?.description ?? NO_DESCRIPTION,
  }));
  return { pack: PACK_NAME, count: skills.length, skills };
}

/**
 * The skill catalog an agent routes from: each skill's triggers, declared
 * tools split by what `callable` allows, and whether it mutates. Same
 * enumeration and fail-open behaviour as `listBrainSkillpacks`.
 */
export function listSkillCatalog(opts: SkillCatalogOptions = {}): SkillCatalog {
  const callable = opts.callable ?? ALL_CALLABLE;
  const skills: SkillCatalogEntry[] = enumerateSkillFiles(opts.skillsDir ?? DEFAULT_SKILLS_DIR).map((e) => {
    const fm = readSkillFrontmatter(e.file);
    const tools = fm?.tools ?? [];
    return {
      slug: e.slug,
      description: fm?.description ?? NO_DESCRIPTION,
      triggers: fm?.triggers ?? [],
      tools,
      ...splitTools(tools, callable),
      mutating: fm?.mutating ?? false,
      requires: fm?.requires ?? [],
      writes_to: fm?.writes_to ?? [],
    };
  });
  return {
    pack: PACK_NAME,
    count: skills.length,
    schema_version: 1,
    skills,
    instructions: CATALOG_INSTRUCTIONS,
  };
}

export interface BrainSkillDetail {
  slug: string;
  description: string;
  /** Full markdown body of the skill file (frontmatter included). */
  body: string;
}

/**
 * The file a get_skill slug names, or null. The slug is joined into a
 * filesystem path, so each accepted shape is strictly validated before
 * touching disk (a `.`, `\`, or arbitrary `/` could escape the skills dir):
 *   <slug>             — a skill (flat <slug>.md or <slug>/SKILL.md)
 *   _<name>            — a shared rules doc (underscore layer)
 *   conventions/<name> — a cross-cutting convention doc
 */
function resolveSkillText(slug: unknown, skillsDir: string): { file: string; text: string } | null {
  if (typeof slug !== "string") return null;
  const candidates: string[] = [];
  if (/^[a-z0-9][\w-]*$/i.test(slug)) {
    candidates.push(join(skillsDir, `${slug}.md`));
    candidates.push(join(skillsDir, slug, "SKILL.md"));
  } else if (/^_[a-z0-9][\w-]*$/i.test(slug)) {
    candidates.push(join(skillsDir, `${slug}.md`));
  } else if (/^conventions\/[a-z0-9][\w.-]*$/i.test(slug) && !slug.includes("..")) {
    const name = slug.slice("conventions/".length);
    candidates.push(join(skillsDir, "conventions", name.includes(".") ? name : `${name}.md`));
  } else {
    return null;
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readText(file);
    if (text !== null) return { file, text };
  }
  return null;
}

/**
 * Fetch one brain-resident skill's full body by slug — backs the `get_skill`
 * MCP tool. Returns null when the slug doesn't resolve to a skill file.
 */
export function getBrainSkill(
  slug: string,
  opts: ListBrainSkillpacksOptions = {},
): BrainSkillDetail | null {
  const found = resolveSkillText(slug, opts.skillsDir ?? DEFAULT_SKILLS_DIR);
  if (found === null) return null;
  const description = parseSkillFrontmatter(found.text)?.description ?? NO_DESCRIPTION;
  return { slug, description, body: found.text };
}

/**
 * One skill with its frontmatter projection and its tools split for this
 * caller. Same slug validation as `getBrainSkill`; null when it resolves to
 * nothing.
 */
export function getSkillDetail(slug: string, opts: SkillCatalogOptions = {}): SkillDetail | null {
  const found = resolveSkillText(slug, opts.skillsDir ?? DEFAULT_SKILLS_DIR);
  if (found === null) return null;
  const fm = parseSkillFrontmatter(found.text);
  const frontmatter: SkillFrontmatterProjection | null = fm === null
    ? null
    : {
        name: fm.name,
        description: fm.description,
        triggers: fm.triggers,
        tools: fm.tools,
        mutating: fm.mutating,
        requires: fm.requires,
        writes_to: fm.writes_to,
      };
  return {
    slug,
    description: fm?.description ?? NO_DESCRIPTION,
    body: found.text,
    frontmatter,
    ...splitTools(fm?.tools ?? [], opts.callable ?? ALL_CALLABLE),
  };
}
