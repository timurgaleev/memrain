/**
 * `memrain eval promote <FLAG>`: one report that says whether a ranking flag
 * may become a default, by the acceptance protocol — baseline run twice for
 * noise, the flag once, paired statistics, per-tag drops, decoys, top-1 losses
 * and LongMemEval retrieval recall.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteVerdict, runEvalPromote, type PromoteRun } from "../src/commands/eval-promote.ts";

setDefaultTimeout(240_000);

/** n queries in one tag, each scoring `score` on every metric. */
function run(n: number, score: (i: number) => number, opts: { tag?: string; decoysPassed?: string[]; extra?: Record<string, number> } = {}): PromoteRun {
  const per: PromoteRun["per_query"] = {};
  for (let i = 0; i < n; i++) {
    const s = score(i);
    per[`q${i}`] = { hit5: s > 0 ? 1 : 0, rr: s, ndcg10: s, recall10: s > 0 ? 1 : 0, tags: [opts.tag ?? "kind:alias"] };
  }
  for (const [id, s] of Object.entries(opts.extra ?? {})) per[id] = { hit5: 1, rr: s, ndcg10: s, recall10: 1, tags: ["kind:code"] };
  return { per_query: per, decoys: { total: 3, passed: opts.decoysPassed ?? [] }, errors: [], spend: { calls: 0, usd: 0 } };
}

const lme = { base: 0.8, candidate: 0.8 };

describe("promoteVerdict", () => {
  it("refuses without a second baseline run: the noise floor cannot be measured", () => {
    const r = promoteVerdict({ baselines: [run(20, () => 0.5)], candidate: run(20, () => 0.9), top1: [], lme });
    expect(r.verdict).toBe("REFUSED");
    expect(r.reasons.join(" ")).toContain("second baseline");
  });

  it("passes a clear improvement with every check measured", () => {
    const r = promoteVerdict({ baselines: [run(40, () => 0.5), run(40, () => 0.5)], candidate: run(40, () => 1), top1: [], lme });
    expect(r.verdict).toBe("PASS");
    expect(r.noise.ndcg_at_10).toBe(0.01);
  });

  it("fails when one tag with ten or more queries drops by more than 0.05", () => {
    const base = run(40, () => 0.8, { extra: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, 0.8])) });
    const cand = run(40, () => 1, { extra: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, 0.74])) });
    const r = promoteVerdict({ baselines: [base, base], candidate: cand, top1: [], lme });
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons.join(" ")).toContain("kind:code");
  });

  it("fails when a decoy passes, whatever the other numbers say", () => {
    const r = promoteVerdict({ baselines: [run(40, () => 0.5), run(40, () => 0.5)], candidate: run(40, () => 1, { decoysPassed: ["decoy-x"] }), top1: [], lme });
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons.join(" ")).toContain("decoy");
  });

  it("fails on a lost expected top-1 and on LongMemEval recall falling more than a point", () => {
    const base = run(40, () => 1);
    const cand = run(40, (i) => (i === 0 ? 0.5 : 1));
    expect(promoteVerdict({ baselines: [base, base], candidate: cand, top1: ["q0"], lme }).reasons.join(" ")).toContain("q0");
    const r = promoteVerdict({ baselines: [run(40, () => 0.5), run(40, () => 0.5)], candidate: run(40, () => 1), top1: [], lme: { base: 0.8, candidate: 0.785 } });
    expect(r.verdict).toBe("FAIL");
  });

  it("is incomplete without LongMemEval figures, and neutral when nothing moves", () => {
    expect(promoteVerdict({ baselines: [run(40, () => 0.5), run(40, () => 0.5)], candidate: run(40, () => 1), top1: [] }).verdict).toBe("INCOMPLETE");
    expect(promoteVerdict({ baselines: [run(40, () => 0.5), run(40, () => 0.5)], candidate: run(40, () => 0.5), top1: [], lme }).verdict).toBe("NEUTRAL");
  });
});

describe("runEvalPromote on the bench", () => {
  it("writes a report for a real flag and spends nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memrain-promote-"));
    try {
      const code = await runEvalPromote({ flag: "EXACT_LOOKUP", outDir: dir, quiet: true });
      const [file] = readdirSync(dir);
      expect(file).toMatch(/^EXACT_LOOKUP-.*\.json$/);
      const report = JSON.parse(readFileSync(join(dir, file!), "utf8")) as { verdict: string; sets: string[]; spend: { calls: number }; missing: string[] };
      expect(report.sets).toEqual(["bench"]);
      expect(report.spend.calls).toBe(0);
      expect(report.missing).toContain("lme-r");
      expect(["NEUTRAL", "INCOMPLETE", "FAIL"]).toContain(report.verdict);
      expect(code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unknown flag and LongMemEval summaries that are not retrieval-only", async () => {
    expect(await runEvalPromote({ flag: "NOT_A_FLAG", quiet: true })).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), "memrain-promote-"));
    try {
      const judged = join(dir, "s.json");
      writeFileSync(judged, JSON.stringify({ label: "Bedrock-Claude-judged", recall_any_at_5: 0.5 }));
      expect(await runEvalPromote({ flag: "EXACT_LOOKUP", lmeBase: judged, lmeCandidate: judged, outDir: dir, quiet: true })).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
