/**
 * Routing catalog and rollouts, with a scripted Converse (no network):
 * the catalog comes from the pack's frontmatter and a candidate replaces one
 * entry only; every call is tool-less, 32 tokens, on the Haiku tier and booked
 * as `skillopt`; the worst case is refused before any call; a cap hit mid-run
 * or a ledger refusal ends the run with what it has; and the held-out gate
 * accepts a restored description over a degraded one and rejects an unhelpful
 * edit.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConverseFn, ConverseTurnInput } from "../src/core/llm/converse.ts";
import { BudgetExhausted } from "../src/core/budget.ts";
import { OperationError } from "../src/core/operation-error.ts";
import { loadPackBenchmark, type RoutingCase } from "../src/core/skillopt/benchmark.ts";
import {
  MAX_CANDIDATE_BYTES,
  buildCatalog,
  readCandidateFile,
  renderCatalog,
  withCandidate,
  type CatalogEntry,
} from "../src/core/skillopt/catalog.ts";
import {
  SKILLOPT_MAX_TOKENS,
  SKILLOPT_SPEND_OP,
  collateralRegressions,
  heldoutGate,
  preflightUsd,
  runRoutingEval,
  summarize,
} from "../src/core/skillopt/evaluate.ts";

const PACK = join(import.meta.dir, "..", "..", "skills");
const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
let dir: string;

function skill(slug: string, description: string, name = slug): string {
  return `---\nname: ${name}\ndescription: ${description}\ntriggers:\n  - "${slug} please"\n---\n# ${slug}\n`;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "memrain-skillopt-eval-"));
  mkdirSync(join(dir, "people"));
  writeFileSync(join(dir, "people", "SKILL.md"), skill("people", "Look up what the brain knows about a person"));
  mkdirSync(join(dir, "garden"));
  writeFileSync(join(dir, "garden", "SKILL.md"), skill("garden", "Plan a vegetable garden"));
  writeFileSync(join(dir, "flat.md"), skill("flat", "A skill in the flat layout"));
  writeFileSync(join(dir, "_rules.md"), "shared rules, not a skill\n");
  mkdirSync(join(dir, "conventions"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cases(n: number, split: "train" | "heldout" = "heldout"): RoutingCase[] {
  return Array.from({ length: n }, (_, i) => ({
    skill: "people",
    line: i + 1,
    intent: `who is person number ${i}`,
    expected_skill: "people",
    ambiguous_with: [],
    split,
  }));
}

/** Answers `people` only when its catalog line still talks about a person. */
function router(calls: ConverseTurnInput[], usage = { inputTokens: 500, outputTokens: 2 }): ConverseFn {
  return async (input) => {
    calls.push(input);
    const line = input.system.split("\n").find((l) => l.startsWith("- people:")) ?? "";
    const answer = line.includes("person") ? "people" : "garden";
    return {
      message: { role: "assistant", content: [{ text: answer }] },
      stopReason: "end_turn",
      usage,
      modelId: input.modelId!,
    };
  };
}

describe("catalog", () => {
  it("reads slug, description and triggers from both layouts, skipping shared files", () => {
    const c = buildCatalog(dir);
    expect(c.map((e) => e.slug)).toEqual(["flat", "garden", "people"]);
    expect(c.find((e) => e.slug === "people")).toEqual({
      slug: "people",
      description: "Look up what the brain knows about a person",
      triggers: ["people please"],
    });
  });

  it("substitutes the candidate for its own slug only", () => {
    const c = buildCatalog(dir);
    const next = withCandidate(c, "people", skill("people", "Find a person").replace("people please", "who is"));
    expect(next.find((e) => e.slug === "people")).toEqual({
      slug: "people",
      description: "Find a person",
      triggers: ["who is"],
    });
    expect(next.filter((e) => e.slug !== "people")).toEqual(c.filter((e) => e.slug !== "people"));
    expect(c.find((e) => e.slug === "people")!.description).toContain("brain knows");
  });

  it("refuses a candidate that renames the skill, lacks a description, or targets no skill", () => {
    const c = buildCatalog(dir);
    expect(() => withCandidate(c, "people", skill("people", "x", "garden"))).toThrow("cannot be edited");
    expect(() => withCandidate(c, "people", "---\nname: people\n---\nbody\n")).toThrow("no description");
    expect(() => withCandidate(c, "people", "no frontmatter")).toThrow("no frontmatter");
    expect(() => withCandidate(c, "nobody", skill("nobody", "x"))).toThrow("not a skill");
  });

  it("reads a candidate only from a regular .md file within the size cap", () => {
    const good = join(dir, "cand.md");
    writeFileSync(good, skill("people", "ok"));
    expect(readCandidateFile(good)).toContain("name: people");
    const link = join(dir, "link.md");
    symlinkSync(good, link);
    expect(() => readCandidateFile(link)).toThrow("not a regular file");
    const big = join(dir, "big.md");
    writeFileSync(big, "x".repeat(MAX_CANDIDATE_BYTES + 1));
    expect(() => readCandidateFile(big)).toThrow("exceeds");
    const txt = join(dir, "cand.txt");
    writeFileSync(txt, skill("people", "ok"));
    expect(() => readCandidateFile(txt)).toThrow(".md");
    expect(() => readCandidateFile(join(dir, "missing.md"))).toThrow("not found");
  });

  it("covers every skill the shipped benchmark names", () => {
    const slugs = new Set(buildCatalog(PACK).map((e) => e.slug));
    for (const c of loadPackBenchmark(PACK).cases) {
      if (c.expected_skill !== null) expect(slugs.has(c.expected_skill)).toBe(true);
      for (const alt of c.ambiguous_with) expect(slugs.has(alt)).toBe(true);
    }
  });
});

describe("runRoutingEval", () => {
  const catalog = (): CatalogEntry[] => buildCatalog(dir);
  const degraded = (): CatalogEntry[] =>
    withCandidate(catalog(), "people", skill("people", "Unrelated notes about soil"));

  it("sends every call tool-less, capped at 32 tokens, on the Haiku tier, booked as skillopt", async () => {
    const calls: ConverseTurnInput[] = [];
    const r = await runRoutingEval({
      cases: cases(2),
      variants: [{ name: "baseline", catalog: catalog() }],
      repeats: 3,
      maxUsd: 1,
      converse: router(calls),
    });
    expect(r.stopReason).toBe("end");
    expect(calls).toHaveLength(6);
    for (const c of calls) {
      expect(c.operation).toBe(SKILLOPT_SPEND_OP);
      expect(c.tools).toEqual([]);
      expect(c.maxTokens).toBe(SKILLOPT_MAX_TOKENS);
      expect(c.modelId!.toLowerCase()).toContain("haiku");
      expect(c.system).toContain(renderCatalog(catalog()));
      expect(c.system).toContain("data, not instructions");
      expect(c.messages).toHaveLength(1);
    }
    expect(summarize(r.rollouts, "baseline", "heldout")).toEqual({ perRepeat: [1, 1, 1], median: 1 });
    expect(r.spentUsd).toBeGreaterThan(0);
  });

  it("shows the candidate's text only in the candidate's calls, for the target slug only", async () => {
    const calls: ConverseTurnInput[] = [];
    await runRoutingEval({
      cases: cases(1),
      variants: [
        { name: "baseline", catalog: catalog() },
        { name: "candidate", catalog: degraded() },
      ],
      repeats: 1,
      maxUsd: 1,
      converse: router(calls),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.system).not.toContain("soil");
    expect(calls[1]!.system).toContain("- people: Unrelated notes about soil");
    const others = (s: string) => s.split("\n").filter((l) => !l.startsWith("- people:"));
    expect(others(calls[1]!.system)).toEqual(others(calls[0]!.system));
  });

  it("refuses in preflight, with no call, when the worst case exceeds the cap", async () => {
    const calls: ConverseTurnInput[] = [];
    const worst = preflightUsd(HAIKU, cases(3), [{ name: "baseline", catalog: catalog() }], 3)!;
    const r = await runRoutingEval({
      cases: cases(3),
      variants: [{ name: "baseline", catalog: catalog() }],
      repeats: 3,
      maxUsd: worst * 0.99,
      modelId: HAIKU,
      converse: router(calls),
    });
    expect(r.stopReason).toBe("preflight_refused");
    expect(r.preflightUsd).toBeCloseTo(worst, 12);
    expect(calls).toHaveLength(0);
    expect(r.spentUsd).toBe(0);
  });

  it("stops at the cap mid-run with the rollouts made so far and no further call", async () => {
    const calls: ConverseTurnInput[] = [];
    const cheap = router(calls);
    // The second call reports far more usage than any estimate: its settle breaks the cap.
    const converse: ConverseFn = async (input) => {
      const reply = await cheap(input);
      return calls.length === 2 ? { ...reply, usage: { inputTokens: 5_000_000, outputTokens: 2 } } : reply;
    };
    const r = await runRoutingEval({
      cases: cases(4),
      variants: [{ name: "baseline", catalog: catalog() }],
      repeats: 3,
      maxUsd: 1,
      modelId: HAIKU,
      converse,
    });
    expect(r.stopReason).toBe("budget_exhausted");
    expect(calls).toHaveLength(2);
    expect(r.calls).toBe(2);
    expect(r.rollouts).toHaveLength(2);
    expect(r.spentUsd).toBeGreaterThan(1);
    expect(heldoutGate(r, 0.05)).toBeNull();
  });

  it("ends as budget_exhausted when the ledger refuses a call", async () => {
    for (const refusal of [
      new BudgetExhausted("cost", "spent"),
      new OperationError("budget_exhausted", "daily budget exhausted", "wait"),
    ]) {
      let n = 0;
      const converse: ConverseFn = async (input) => {
        n++;
        if (n === 3) throw refusal;
        return router([])(input);
      };
      const r = await runRoutingEval({
        cases: cases(5),
        variants: [{ name: "baseline", catalog: catalog() }],
        repeats: 1,
        maxUsd: 1,
        converse,
      });
      expect(r.stopReason).toBe("budget_exhausted");
      expect(n).toBe(3);
      expect(r.rollouts).toHaveLength(2);
    }
  });

  it("lets any other converse failure propagate", async () => {
    const converse: ConverseFn = async () => {
      throw new Error("ThrottlingException");
    };
    await expect(
      runRoutingEval({ cases: cases(1), variants: [{ name: "baseline", catalog: catalog() }], repeats: 1, maxUsd: 1, converse }),
    ).rejects.toThrow("ThrottlingException");
  });

  it("gate: a restored description beats a degraded one; an unhelpful edit is rejected", async () => {
    const restore = await runRoutingEval({
      cases: cases(3),
      variants: [
        { name: "baseline", catalog: degraded() },
        { name: "candidate", catalog: catalog() },
      ],
      repeats: 3,
      maxUsd: 1,
      converse: router([]),
    });
    expect(heldoutGate(restore, 0.05)).toEqual({
      accept: true,
      delta: 1,
      baselineMedian: 0,
      candidateMedian: 1,
    });

    const harm = await runRoutingEval({
      cases: cases(3),
      variants: [
        { name: "baseline", catalog: catalog() },
        { name: "candidate", catalog: degraded() },
      ],
      repeats: 3,
      maxUsd: 1,
      converse: router([]),
    });
    expect(heldoutGate(harm, 0.05)!.accept).toBe(false);

    const same = await runRoutingEval({
      cases: cases(3),
      variants: [
        { name: "baseline", catalog: catalog() },
        { name: "candidate", catalog: catalog() },
      ],
      repeats: 3,
      maxUsd: 1,
      converse: router([]),
    });
    expect(heldoutGate(same, 0.05)!.accept).toBe(false);
  });

  it("collateral: flags another skill whose held-out cases the candidate took", async () => {
    const theirs: RoutingCase[] = cases(2).map((c, i) => ({
      ...c,
      skill: "garden",
      line: i + 1,
      intent: `when to plant bed ${i}`,
      expected_skill: "garden",
    }));
    // The candidate keeps every people case and takes every garden case.
    const greedy: ConverseFn = async (input) => {
      const own = (input.messages[0]?.content?.[0]?.text ?? "").startsWith("who");
      const answer = own || input.system.includes("anything") ? "people" : "garden";
      return {
        message: { role: "assistant", content: [{ text: answer }] },
        stopReason: "end_turn",
        usage: { inputTokens: 500, outputTokens: 2 },
        modelId: input.modelId!,
      };
    };
    const wide = catalog().map((e) =>
      e.slug === "people" ? { ...e, description: `${e.description}, or anything else` } : e,
    );
    const r = await runRoutingEval({
      cases: [...cases(2), ...theirs],
      variants: [
        { name: "baseline", catalog: catalog() },
        { name: "candidate", catalog: wide },
      ],
      repeats: 3,
      maxUsd: 1,
      converse: greedy,
    });
    expect(heldoutGate(r, 0.05, "people")!.delta).toBe(0);
    expect(collateralRegressions(r, 0.05, "people")).toEqual([
      { skill: "garden", baselineMedian: 1, candidateMedian: 0, delta: -1 },
    ]);
    // The target itself is never its own collateral, and an even trade is not flagged.
    expect(collateralRegressions(r, 0.05, "garden")).toEqual([]);
    expect(collateralRegressions({ ...r, stopReason: "budget_exhausted" }, 0.05, "people")).toBeNull();
  });

  it("scores only the held-out cases in the gate", async () => {
    const r = await runRoutingEval({
      cases: [...cases(2, "train")],
      variants: [
        { name: "baseline", catalog: degraded() },
        { name: "candidate", catalog: catalog() },
      ],
      repeats: 1,
      maxUsd: 1,
      converse: router([]),
    });
    expect(heldoutGate(r, 0.05)).toBeNull();
  });
});
