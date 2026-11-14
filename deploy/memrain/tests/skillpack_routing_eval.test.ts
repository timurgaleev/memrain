/**
 * The deterministic trigger router and its score on the shipped pack's
 * routing-eval.jsonl cases. The baseline is pinned: a trigger edit that
 * steals or loses a case moves it, and the test names the case.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listSkillCatalog } from "../src/core/skillpack/brain-resident.ts";
import {
  judgeRoute,
  normalizeTrigger,
  routeByTriggers,
  scoreBenchmark,
  type SkillTriggers,
} from "../src/core/skillpack/routing-eval.ts";
import { loadPackBenchmark } from "../src/core/skillopt/benchmark.ts";

const PACK_DIR = resolve(import.meta.dir, "..", "..", "skills");

const SKILLS: SkillTriggers[] = [
  { slug: "enrich", triggers: ["enrich", "who is this person"] },
  { slug: "article-enrichment", triggers: ["Enrich this article"] },
  { slug: "health-a", triggers: ["health check"] },
  { slug: "health-b", triggers: ["Health-Check!"] },
];

describe("routeByTriggers", () => {
  it("normalises case and punctuation", () => {
    expect(normalizeTrigger("  Who's   THIS—person? ")).toBe("who s this person");
  });

  it("lets the longest matching trigger win", () => {
    expect(routeByTriggers("please ENRICH this article, thanks", SKILLS)).toEqual({
      kind: "match",
      slug: "article-enrichment",
      trigger: "enrich this article",
    });
    expect(routeByTriggers("enrich the Acme page", SKILLS)).toEqual({ kind: "match", slug: "enrich", trigger: "enrich" });
  });

  it("matches whole words only", () => {
    expect(routeByTriggers("enriching data", SKILLS)).toEqual({ kind: "none" });
  });

  it("calls a tie between two skills ambiguous", () => {
    expect(routeByTriggers("run a health check now", SKILLS)).toEqual({
      kind: "ambiguous",
      slugs: ["health-a", "health-b"],
      trigger: "health check",
    });
  });
});

describe("judgeRoute and scoreBenchmark", () => {
  it("accepts a route to a skill the case names as ambiguous_with", () => {
    const c = { intent: "x", expected_skill: "health-a", ambiguous_with: ["health-b"] };
    expect(judgeRoute(c, { kind: "ambiguous", slugs: ["health-a", "health-b"], trigger: "t" })).toBe("correct");
    expect(judgeRoute({ ...c, ambiguous_with: [] }, { kind: "ambiguous", slugs: ["health-a", "health-b"], trigger: "t" })).toBe("ambiguous");
  });

  it("tallies every outcome and names the failures", () => {
    const s = scoreBenchmark(
      [
        { intent: "enrich this article please", expected_skill: "article-enrichment", ambiguous_with: [] },
        { intent: "nothing matches", expected_skill: "enrich", ambiguous_with: [] },
        { intent: "enrich the deck", expected_skill: "article-enrichment", ambiguous_with: [] },
        { intent: "health check", expected_skill: "health-a", ambiguous_with: [] },
        { intent: "enrich it", expected_skill: null, ambiguous_with: [] },
        { intent: "small talk", expected_skill: null, ambiguous_with: [] },
      ],
      SKILLS,
    );
    expect(s).toMatchObject({ total: 6, correct: 2, missed: 1, wrong: 1, ambiguous: 1, false_positives: 1 });
    expect(s.accuracy).toBeCloseTo(2 / 6);
    expect(s.failures.map((f) => `${f.outcome}:${f.got.join(",")}`)).toEqual([
      "missed:",
      "wrong:enrich",
      "ambiguous:health-a,health-b",
      "false_positive:enrich",
    ]);
  });

  it("scores zero on an empty benchmark", () => {
    expect(scoreBenchmark([], SKILLS).accuracy).toBe(0);
  });
});

describe("the shipped pack", () => {
  const skills = listSkillCatalog({ skillsDir: PACK_DIR }).skills;

  it("routes every routing-eval case to its skill (pinned baseline)", () => {
    const bench = loadPackBenchmark(PACK_DIR);
    expect(bench.errors).toEqual([]);
    const s = scoreBenchmark(bench.cases, skills);
    expect(s.failures).toEqual([]);
    expect(s.total).toBe(115);
    expect(s.correct).toBe(115);
  });

  it("sends a specific request past the general skill whose trigger it contains", () => {
    const route = (q: string): string => {
      const r = routeByTriggers(q, skills);
      return r.kind === "match" ? r.slug : r.kind;
    };
    expect(route("can you enrich this article for me")).toBe("article-enrichment");
    expect(route("save this podcast episode")).toBe("media-ingest");
    expect(route("save this")).toBe("idea-ingest");
    expect(route("process this meeting from today")).toBe("meeting-ingestion");
    expect(route("quick health check please")).toBe("skillpack-check");
  });

  it("routes each kind of conversation request to conversation-archive", () => {
    const route = (q: string): string => {
      const r = routeByTriggers(q, skills);
      return r.kind === "match" ? r.slug : r.kind;
    };
    for (const q of [
      "import my chat export",
      "archive this agent session",
      "did I already import this conversation",
      "my conversation import failed",
    ]) expect(route(q)).toBe("conversation-archive");
  });

  it("conversation-archive gives each case its own route and promises no automatic import", () => {
    const text = readFileSync(join(PACK_DIR, "conversation-archive", "SKILL.md"), "utf8");
    for (const route of ["### Exported chat", "### Agent-session transcript", "### Already imported", "### Failed parse"]) {
      expect(text).toContain(route);
    }
    expect(text).not.toMatch(/automatic|on its own|in the background/i);
    // Writes go through the importer, never a hand-built page.
    expect(text).not.toMatch(/`(page_put|page_append|page_edit)`/);
  });
});
