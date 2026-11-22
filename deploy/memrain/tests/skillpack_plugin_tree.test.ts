/**
 * One source for the brain's skillpack and the Claude Code / Codex plugin:
 * deploy/skills is edited by hand, and plugins/memrain/skills, the resolver
 * and the lock file are generated from it. These tests fail when the
 * committed copies drift from what the generator would write, when an
 * operator skill lands in the plugin lane, or when a hash in the lock stops
 * matching its file.
 */
import { describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OPERATOR_ONLY_TOOLS } from "../src/mcp/visibility.ts";
import { getBrainSkill, listSkillCatalog } from "../src/core/skillpack/brain-resident.ts";
import {
  LOCK_FILE,
  RESOLVER_BEGIN,
  RESOLVER_END,
  RESOLVER_FILE,
  diffPluginTree,
  readPluginLanes,
  renderLock,
  renderResolver,
  validateLanes,
  writePluginTree,
} from "../src/core/skillpack/plugin-tree.ts";

const PACK_DIR = resolve(import.meta.dir, "..", "..", "skills");
const PLUGIN_SKILLS = resolve(import.meta.dir, "..", "..", "..", "plugins", "memrain", "skills");

function scratchCopy(): { pack: string; plugin: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "plugin-tree-"));
  const pack = join(root, "skills");
  const plugin = join(root, "plugin-skills");
  cpSync(PACK_DIR, pack, { recursive: true });
  cpSync(PLUGIN_SKILLS, plugin, { recursive: true });
  return { pack, plugin, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe("plugin lanes", () => {
  const lanes = readPluginLanes(PACK_DIR);

  it("is a valid record over skills that exist", () => {
    expect(validateLanes(lanes, PACK_DIR)).toEqual([]);
  });

  it("keeps operator skills out of the plugin", () => {
    for (const slug of ["db-repair", "install", "brain-upgrade", "minion-orchestrator", "skill-optimizer", "skill-autobench"]) {
      expect(Object.keys(lanes.operator_only)).toContain(slug);
      expect(Object.keys(lanes.plugin)).not.toContain(slug);
    }
  });

  it("lists as starter exactly the skills served as MCP prompts", () => {
    const prompts = readFileSync(join(PACK_DIR, "plugin-lanes.json"), "utf8");
    expect(JSON.parse(prompts).starter).toEqual(lanes.starter);
    const served = listSkillCatalog({ skillsDir: PACK_DIR }).skills
      .filter((s) => /^prompt: true$/m.test(readFileSync(join(PACK_DIR, s.slug, "SKILL.md"), "utf8")))
      .map((s) => s.slug);
    expect([...lanes.starter].sort()).toEqual(served.sort());
  });

  it("a skill a client agent reads names no operator-only tool", () => {
    const named: string[] = [];
    for (const slug of new Set([...Object.keys(lanes.plugin), ...lanes.starter])) {
      const text = readFileSync(join(PACK_DIR, slug, "SKILL.md"), "utf8");
      for (const tool of OPERATOR_ONLY_TOOLS) {
        if (text.includes(`\`${tool}\``) || new RegExp(`^\\s+- ${tool}$`, "m").test(text)) named.push(`${slug}: ${tool}`);
      }
    }
    expect(named).toEqual([]);
  });

  it("a plugin skill links only to skills the plugin ships", () => {
    const shipped = new Set(Object.keys(lanes.plugin));
    const dangling: string[] = [];
    for (const slug of shipped) {
      const text = readFileSync(join(PLUGIN_SKILLS, slug, "SKILL.md"), "utf8");
      for (const m of text.matchAll(/skills\/([a-z0-9-]+)\/SKILL\.md/g)) {
        if (!shipped.has(m[1]!)) dangling.push(`${slug} -> ${m[1]}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("flags a lane entry for a skill that does not exist and an operator skill in the plugin", () => {
    const bad = {
      ...lanes,
      plugin: { ...lanes.plugin, "no-such-skill": "x", "db-repair": "x" },
    };
    const errors = validateLanes(bad, PACK_DIR);
    expect(errors.some((e) => e.includes("no-such-skill"))).toBe(true);
    expect(errors.some((e) => e.includes("db-repair"))).toBe(true);
  });
});

describe("the committed plugin tree", () => {
  it("matches what the generator writes from deploy/skills", () => {
    expect(diffPluginTree(PACK_DIR, PLUGIN_SKILLS)).toEqual([]);
  });

  it("reports drift when a source skill changes without regenerating", () => {
    const s = scratchCopy();
    try {
      const file = join(s.pack, "query", "SKILL.md");
      writeFileSync(file, `${readFileSync(file, "utf8")}\nedited\n`);
      expect(diffPluginTree(s.pack, s.plugin)).toContain("query/SKILL.md");
    } finally {
      s.done();
    }
  });

  it("refuses a plugin skill folder that is a symbolic link in the pack", () => {
    const s = scratchCopy();
    try {
      const outside = join(s.pack, "..", "outside-query");
      cpSync(join(s.pack, "query"), outside, { recursive: true });
      rmSync(join(s.pack, "query"), { recursive: true });
      symlinkSync(outside, join(s.pack, "query"));
      expect(() => diffPluginTree(s.pack, s.plugin)).toThrow(/symbolic link/);
    } finally {
      s.done();
    }
  });

  it("refuses to write through a plugin folder that is a symbolic link", () => {
    const s = scratchCopy();
    try {
      const elsewhere = join(s.pack, "..", "elsewhere");
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, "keep.txt"), "keep");
      const linked = join(s.pack, "..", "linked-plugin");
      symlinkSync(elsewhere, linked);
      expect(() => writePluginTree(s.pack, linked)).toThrow(/symbolic link/);
      expect(readFileSync(join(elsewhere, "keep.txt"), "utf8")).toBe("keep");
    } finally {
      s.done();
    }
  });

  it("reports a stray skill in the plugin that no lane ships", () => {
    const s = scratchCopy();
    try {
      cpSync(join(s.pack, "db-repair"), join(s.plugin, "db-repair"), { recursive: true });
      expect(diffPluginTree(s.pack, s.plugin)).toContain("db-repair/SKILL.md");
    } finally {
      s.done();
    }
  });
});

describe("generated pack files", () => {
  it("the lock records the current hash of every pack file", () => {
    expect(readFileSync(join(PACK_DIR, LOCK_FILE), "utf8")).toBe(renderLock(PACK_DIR));
  });

  it("the lock changes when a pack file changes", () => {
    const s = scratchCopy();
    try {
      const before = renderLock(s.pack);
      const file = join(s.pack, "query", "SKILL.md");
      writeFileSync(file, `${readFileSync(file, "utf8")}\nedited\n`);
      expect(renderLock(s.pack)).not.toBe(before);
      expect(JSON.parse(renderLock(s.pack))).not.toHaveProperty(LOCK_FILE);
    } finally {
      s.done();
    }
  });

  it("the resolver's table is the render of the frontmatter, not a hand edit", () => {
    const committed = readFileSync(join(PACK_DIR, RESOLVER_FILE), "utf8");
    expect(committed).toBe(renderResolver(PACK_DIR, readPluginLanes(PACK_DIR), committed));
    expect(committed).toContain(RESOLVER_BEGIN);
    expect(committed).toContain("## Disambiguation rules");
  });

  it("keeps the hand-written text around the generated block, run after run", () => {
    const lanes = readPluginLanes(PACK_DIR);
    const page = `# Mine\n\nhand head\n\n${RESOLVER_BEGIN}\nstale table\n${RESOLVER_END}\n\nhand tail\n`;
    const once = renderResolver(PACK_DIR, lanes, page);
    expect(once.startsWith("# Mine\n\nhand head\n\n")).toBe(true);
    expect(once.endsWith(`${RESOLVER_END}\n\nhand tail\n`)).toBe(true);
    expect(once).not.toContain("stale table");
    expect(once).toContain("| `query` |");
    expect(once).toContain("| `conventions/untrusted-content` |");
    expect(renderResolver(PACK_DIR, lanes, once)).toBe(once);
  });

  it("writes the default head only when there is no page, and refuses a page without sound markers", () => {
    const lanes = readPluginLanes(PACK_DIR);
    const fresh = renderResolver(PACK_DIR, lanes, null);
    expect(fresh.startsWith("# Skill Resolver\n")).toBe(true);
    expect(fresh).toContain(RESOLVER_END);
    for (const broken of [
      "# a hand-written page with no markers\n",
      `${RESOLVER_BEGIN}\nno end\n`,
      `${RESOLVER_END}\nno begin\n`,
      `${RESOLVER_END}\n${RESOLVER_BEGIN}\n`,
      `${RESOLVER_BEGIN}\n${RESOLVER_END}\n${RESOLVER_BEGIN}\n${RESOLVER_END}\n`,
    ]) {
      expect(() => renderResolver(PACK_DIR, lanes, broken)).toThrow("generated block");
    }
  });

  it("lists every trigger of a skill, not only the first few", () => {
    const resolver = readFileSync(join(PACK_DIR, RESOLVER_FILE), "utf8");
    for (const s of listSkillCatalog({ skillsDir: PACK_DIR }).skills) {
      const row = resolver.split("\n").find((l) => l.startsWith(`| \`${s.slug}\` |`)) ?? "";
      expect(row.split("\", \"").length, s.slug).toBe(s.triggers.length);
    }
  });

  it("the resolver is served through get_skill and is not listed as a skill", () => {
    expect(getBrainSkill("_resolver", { skillsDir: PACK_DIR })?.body).toContain("# Skill Resolver");
    expect(listSkillCatalog({ skillsDir: PACK_DIR }).skills.map((s) => s.slug)).not.toContain("_resolver");
  });

  it("the resolver lists every routable skill once", () => {
    const resolver = renderResolver(PACK_DIR, readPluginLanes(PACK_DIR));
    for (const s of listSkillCatalog({ skillsDir: PACK_DIR }).skills) {
      expect(resolver.split(`| \`${s.slug}\` |`).length - 1, s.slug).toBe(1);
    }
  });
});
