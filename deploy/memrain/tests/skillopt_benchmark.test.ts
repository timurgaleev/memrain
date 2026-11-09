/**
 * Routing benchmark loader: comment and blank lines are skipped, bad lines
 * are reported by number, fields are validated, the file is confined to
 * `<skillsDir>/<slug>/routing-eval.jsonl` as a regular file of bounded size,
 * and the train/held-out split is deterministic with at least one held-out
 * case per file. The shipped pack must load clean.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_BENCHMARK_FILE_BYTES,
  assignSplits,
  listBenchmarkSkills,
  loadPackBenchmark,
  loadSkillBenchmark,
} from "../src/core/skillopt/benchmark.ts";

const PACK = join(import.meta.dir, "..", "..", "skills");
let dir: string;

function bench(slug: string, body: string): void {
  mkdirSync(join(dir, slug), { recursive: true });
  writeFileSync(join(dir, slug, "routing-eval.jsonl"), body);
}

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "memrain-skillopt-bench-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadSkillBenchmark", () => {
  it("skips comments and blank lines and keeps line numbers", () => {
    bench(
      "alpha",
      [
        "// fixtures for alpha",
        "",
        line({ intent: "find notes on Bob", expected_skill: "alpha" }),
        "   ",
        line({ intent: "who is Carol", expected_skill: "beta", ambiguous_with: ["alpha"] }),
      ].join("\n"),
    );
    const r = loadSkillBenchmark(dir, "alpha");
    expect(r.errors).toEqual([]);
    expect(r.cases.map((c) => c.line).sort()).toEqual([3, 5]);
    const carol = r.cases.find((c) => c.line === 5)!;
    expect(carol.expected_skill).toBe("beta");
    expect(carol.ambiguous_with).toEqual(["alpha"]);
    expect(carol.skill).toBe("alpha");
  });

  it("reports malformed JSON with its line number and keeps the good lines", () => {
    bench("broken", ["// c", line({ intent: "ok", expected_skill: "broken" }), "{not json"].join("\n"));
    const r = loadSkillBenchmark(dir, "broken");
    expect(r.cases).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("broken/routing-eval.jsonl:3: invalid JSON");
  });

  it("rejects a missing, empty or oversize intent", () => {
    bench(
      "intents",
      [
        line({ expected_skill: "intents" }),
        line({ intent: "   ", expected_skill: "intents" }),
        line({ intent: "x".repeat(501), expected_skill: "intents" }),
        line({ intent: "x".repeat(500), expected_skill: "intents" }),
      ].join("\n"),
    );
    const r = loadSkillBenchmark(dir, "intents");
    expect(r.cases).toHaveLength(1);
    expect(r.errors.map((e) => e.split(":")[1])).toEqual(["1", "2", "3"]);
  });

  it("rejects expected_skill and ambiguous_with outside the slug grammar", () => {
    bench(
      "slugs",
      [
        line({ intent: "a", expected_skill: "../etc" }),
        line({ intent: "b", expected_skill: "Upper" }),
        line({ intent: "c", expected_skill: "x".repeat(65) }),
        line({ intent: "d", expected_skill: "slugs", ambiguous_with: ["ok", "no/slash"] }),
        line({ intent: "e", expected_skill: "slugs", ambiguous_with: "ok" }),
        line({ intent: "f", expected_skill: "slugs" }),
      ].join("\n"),
    );
    const r = loadSkillBenchmark(dir, "slugs");
    expect(r.cases.map((c) => c.intent)).toEqual(["f"]);
    expect(r.errors).toHaveLength(5);
  });

  it("accepts an explicit null expected_skill as a negative case, not a missing one", () => {
    bench(
      "negatives",
      [
        line({ intent: "what's for breakfast", expected_skill: null }),
        line({ intent: "no field at all" }),
      ].join("\n"),
    );
    const r = loadSkillBenchmark(dir, "negatives");
    expect(r.cases.map((c) => c.expected_skill)).toEqual([null]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain(":2: expected_skill");
  });

  it("refuses a file over the size cap", () => {
    const big = line({ intent: "a".repeat(400), expected_skill: "big" });
    bench("big", Array.from({ length: Math.ceil(MAX_BENCHMARK_FILE_BYTES / big.length) + 1 }, () => big).join("\n"));
    const r = loadSkillBenchmark(dir, "big");
    expect(r.cases).toEqual([]);
    expect(r.errors[0]).toContain("exceeds");
  });

  it("refuses a slug that could leave the skills dir", () => {
    for (const slug of ["../x", "a/b", ".hidden", "", "A"]) {
      const r = loadSkillBenchmark(dir, slug);
      expect(r.cases).toEqual([]);
      expect(r.errors[0]).toContain("not a skill slug");
    }
  });

  it("refuses a symlinked benchmark file and a symlinked skill directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "memrain-skillopt-outside-"));
    try {
      writeFileSync(join(outside, "routing-eval.jsonl"), line({ intent: "leak", expected_skill: "linked" }));
      mkdirSync(join(dir, "linked"));
      symlinkSync(join(outside, "routing-eval.jsonl"), join(dir, "linked", "routing-eval.jsonl"));
      symlinkSync(outside, join(dir, "linkdir"));
      for (const slug of ["linked", "linkdir"]) {
        const r = loadSkillBenchmark(dir, slug);
        expect(r.cases).toEqual([]);
        expect(r.errors[0]).toContain("not a regular file");
      }
      // Listed, so a whole-pack load reports the refusal instead of dropping it.
      expect(listBenchmarkSkills(dir)).toContain("linked");
    } finally {
      rmSync(join(dir, "linked"), { recursive: true, force: true });
      rmSync(join(dir, "linkdir"), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("assignSplits", () => {
  const cases = (skill: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      skill,
      line: i + 1,
      intent: `${skill} intent ${i}`,
      expected_skill: skill,
      ambiguous_with: [],
    }));

  it("is deterministic, disjoint, and holds out ceil(30%) per skill", () => {
    const input = [...cases("a", 1), ...cases("b", 3), ...cases("c", 10)];
    const first = assignSplits(input);
    const second = assignSplits([...input].reverse());
    const key = (c: { skill: string; line: number; split: string }) => `${c.skill}:${c.line}:${c.split}`;
    expect(first.map(key).sort()).toEqual(second.map(key).sort());
    expect(first).toHaveLength(input.length);
    for (const [skill, want] of [["a", 1], ["b", 1], ["c", 3]] as const) {
      expect(first.filter((c) => c.skill === skill && c.split === "heldout")).toHaveLength(want);
    }
  });
});

describe("the shipped pack", () => {
  it("loads every routing-eval file with zero errors and a held-out case per file", () => {
    const r = loadPackBenchmark(PACK);
    expect(r.errors).toEqual([]);
    expect(r.files).toHaveLength(21);
    // Every shipped case is counted; comments are not benchmark rows.
    expect(r.cases).toHaveLength(108);
    for (const slug of r.files) {
      expect(r.cases.some((c) => c.skill === slug && c.split === "heldout")).toBe(true);
    }
  });
});
