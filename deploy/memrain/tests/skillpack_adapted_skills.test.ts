/**
 * The shipped pack's contract with the tool registry, and the skills added to
 * it in one batch: every skill parses, every tool a skill declares is a tool
 * the server has, and each added skill carries the pack's sections, a routing
 * benchmark that sends its own cases to it, and (for the paid ones) a stated
 * spend cap with no schedule.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OPERATIONS } from "../src/mcp/operations.ts";
import { parseSkillFrontmatter } from "../src/core/skillpack/frontmatter.ts";
import { getSkillDetail, listSkillCatalog } from "../src/core/skillpack/brain-resident.ts";
import { loadPackBenchmark } from "../src/core/skillopt/benchmark.ts";
import { routeByTriggers } from "../src/core/skillpack/routing-eval.ts";

const PACK_DIR = resolve(import.meta.dir, "..", "..", "skills");
const REGISTRY: ReadonlySet<string> = new Set(OPERATIONS.map((o) => o.name));

const ADAPTED = [
  "blog-ingest",
  "book-mirror",
  "brain-link-discipline",
  "bulk-ingestion",
  "chat-connectors",
  "citation-graph-ingest",
  "company-brainify",
  "concept-synthesis",
  "context-audit",
  "conversation-archive",
  "correction-pipeline",
  "cron-scheduler",
  "daily-task-manager",
  "data-loss-gate",
  "db-repair",
  "draft-in-voice",
  "fact-check",
  "mail-loops",
  "mcp-access",
  "measure-before-you-fix",
  "meeting-ingestion",
  "minion-orchestrator",
  "postgres-adopt",
  "remote-mcp",
  "reports",
  "research-compendium",
  "resolve-before-asking",
  "schema-unify",
  "skill-autobench",
  "skill-optimizer",
  "skillify",
  "skillpack-harvest",
  "two-tier-extraction",
] as const;

const PAID = ["skill-optimizer", "skill-autobench"] as const;

/** Skills rewritten to the full anatomy in deploy/skills/_AGENT_README.md. */
const FULL_ANATOMY = [
  "book-mirror",
  "brain-link-discipline",
  "company-brainify",
  "concept-synthesis",
  "conversation-archive",
  "correction-pipeline",
  "cron-scheduler",
  "daily-task-manager",
  "data-loss-gate",
  "fact-check",
  "meeting-ingestion",
  "minion-orchestrator",
  "remote-mcp",
  "reports",
  "research-compendium",
  "schema-unify",
  "skillify",
  "skillpack-harvest",
] as const;

const ANATOMY_SECTIONS = [
  "## Contract",
  "## Output Format",
  "## When it fails",
  "## Anti-Patterns",
  "## Dedup (sharp boundaries)",
] as const;

/** Past this a served skill crowds the caller's context; split it instead. */
const MAX_SKILL_BYTES = 16 * 1024;

function routableSlugs(): string[] {
  return readdirSync(PACK_DIR)
    .filter((n) => !n.startsWith("_") && !n.startsWith(".") && n !== "conventions")
    .filter((n) => existsSync(join(PACK_DIR, n, "SKILL.md")))
    .sort();
}

function skillText(slug: string): string {
  return readFileSync(join(PACK_DIR, slug, "SKILL.md"), "utf8");
}

describe("every shipped skill against the tool registry", () => {
  it("parses, and is named after its folder", () => {
    for (const slug of routableSlugs()) {
      const fm = parseSkillFrontmatter(skillText(slug));
      expect(fm, slug).not.toBeNull();
      expect(fm!.name, slug).toBe(slug);
      expect(fm!.description ?? "", slug).not.toBe("");
    }
  });

  it("declares only tools the server registers", () => {
    const unknown = listSkillCatalog({ skillsDir: PACK_DIR }).skills.flatMap((s) =>
      s.tools.filter((t) => !REGISTRY.has(t)).map((t) => `${s.slug}: ${t}`),
    );
    expect(unknown).toEqual([]);
  });

  it("gets every declared tool back as usable when the caller may call everything", () => {
    for (const s of listSkillCatalog({ skillsDir: PACK_DIR }).skills) {
      expect(s.unavailable_tools, s.slug).toEqual([]);
      expect(s.usable_tools, s.slug).toEqual(s.tools);
    }
  });
});

describe("the adapted skills", () => {
  it.each(ADAPTED)("%s is served with frontmatter, triggers and tools", (slug) => {
    const detail = getSkillDetail(slug, { skillsDir: PACK_DIR });
    expect(detail).not.toBeNull();
    const fm = detail!.frontmatter!;
    expect(fm.name).toBe(slug);
    expect(fm.triggers.length).toBeGreaterThanOrEqual(3);
    expect(fm.tools.length).toBeGreaterThan(0);
    expect(fm.mutating).not.toBeNull();
    expect(detail!.unavailable_tools).toEqual([]);
  });

  it.each(ADAPTED)("%s has the pack's Contract, Output Format and Anti-Patterns sections", (slug) => {
    const body = skillText(slug);
    for (const section of ["## Contract", "## Output Format", "## Anti-Patterns"]) {
      expect(body, `${slug} ${section}`).toContain(section);
    }
  });

  it.each(ADAPTED)("%s routes its own benchmark cases to itself", (slug) => {
    const bench = loadPackBenchmark(PACK_DIR);
    expect(bench.errors).toEqual([]);
    const own = bench.cases.filter((c) => c.skill === slug && c.expected_skill === slug);
    expect(own.length).toBeGreaterThanOrEqual(3);
    const skills = listSkillCatalog({ skillsDir: PACK_DIR }).skills;
    for (const c of own) {
      const r = routeByTriggers(c.intent, skills);
      const got = r.kind === "match" ? [r.slug] : r.kind === "ambiguous" ? r.slugs : [];
      expect(got, c.intent).toContain(slug);
    }
  });

  it("db-repair only diagnoses: it declares no write tool and runs no repair", () => {
    const fm = parseSkillFrontmatter(skillText("db-repair"))!;
    expect(fm.mutating).toBe(false);
    for (const tool of fm.tools) {
      expect(OPERATIONS.find((o) => o.name === tool)?.scope ?? "read", tool).not.toBe("write");
    }
    expect(skillText("db-repair")).not.toMatch(/`memrain (apply-migrations|migrate-engine|config set)/);
  });

  it.each(FULL_ANATOMY)("%s has every anatomy section and fits the size cap", (slug) => {
    const body = skillText(slug);
    for (const section of ANATOMY_SECTIONS) expect(body, `${slug} ${section}`).toContain(section);
    expect(Buffer.byteLength(body), slug).toBeLessThan(MAX_SKILL_BYTES);
  });

  it.each(FULL_ANATOMY)("%s declares only tools its body tells the agent to call", (slug) => {
    const fm = parseSkillFrontmatter(skillText(slug))!;
    const unused = fm.tools.filter((t) => !new RegExp(`(^|[^a-z0-9_])${t}([^a-z0-9_]|$)`).test(fm.body));
    expect(unused).toEqual([]);
  });

  it.each(PAID)("%s states its spend cap and stays a manual run", (slug) => {
    const body = skillText(slug);
    expect(body).toContain("MEMRAIN_SKILLOPT_ENABLED");
    expect(body).toContain("MEMRAIN_SKILLOPT_MAX_USD");
    expect(body).toContain("--max-usd");
    expect(body).toMatch(/\$0\.25/);
    expect(body).toMatch(/never (on a schedule|scheduled)/i);
    expect(body).not.toMatch(/cron|systemd|daemons enable|jobs submit/i);
  });
});
