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
import { pairLme, promoteVerdict, runEvalPromote, type LmeRun, type PromoteRun } from "../src/commands/eval-promote.ts";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { deterministicEmbed } from "./det-embed.ts";

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
      // A run stopped by its cap or with interrupted questions scored only part
      // of the set; its recall says nothing about the whole.
      const summary = (over: Record<string, unknown>) => ({
        label: "LongMemEval-retrieval-only", dataset: { sha256: "d" }, selected: 20, recall_scored: 18,
        recall_any_at_5: 0.8, not_run: 0, interrupted: [], ranking_flags: [], question_ids_sha256: "ids", ...over,
      });
      const full = join(dir, "full.json");
      const partial = join(dir, "partial.json");
      const interrupted = join(dir, "interrupted.json");
      writeFileSync(full, JSON.stringify(summary({})));
      writeFileSync(partial, JSON.stringify(summary({ not_run: 12, recall_scored: 6 })));
      writeFileSync(interrupted, JSON.stringify(summary({ interrupted: ["q7"] })));
      expect(await runEvalPromote({ flag: "EXACT_LOOKUP", lmeBase: full, lmeCandidate: partial, outDir: dir, quiet: true })).toBe(2);
      expect(await runEvalPromote({ flag: "EXACT_LOOKUP", lmeBase: interrupted, lmeCandidate: full, outDir: dir, quiet: true })).toBe(2);
      // A summary from before the run recorded its flags cannot show what it measured.
      const unlabelled = join(dir, "unlabelled.json");
      const { ranking_flags: _f, ...rest } = summary({ ranking_flags: ["EXACT_LOOKUP"] });
      writeFileSync(unlabelled, JSON.stringify(rest));
      expect(await runEvalPromote({ flag: "EXACT_LOOKUP", lmeBase: full, lmeCandidate: unlabelled, outDir: dir, quiet: true })).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pairLme", () => {
  const lmeRun = (over: Partial<LmeRun> = {}): LmeRun => ({
    path: "s.json", recall: 0.8, selected: 20, scored: 18, dataset: "d", questions: "ids-a", flagsOn: [], ...over,
  });

  it("pairs a flag-off baseline with a run that differs only by the flag", () => {
    const pair = pairLme("EXACT_LOOKUP", lmeRun(), lmeRun({ recall: 0.82, flagsOn: ["EXACT_LOOKUP"] }));
    expect(pair).toEqual({ base: 0.8, candidate: 0.82 });
  });

  it("refuses a pair that did not measure the flag, or measured other questions", () => {
    // The baseline passed twice would let lme-r look measured when it was not.
    expect(() => pairLme("EXACT_LOOKUP", lmeRun(), lmeRun())).toThrow(/EXACT_LOOKUP/);
    expect(() => pairLme("EXACT_LOOKUP", lmeRun({ flagsOn: ["EXACT_LOOKUP"] }), lmeRun({ flagsOn: ["EXACT_LOOKUP"] }))).toThrow(/EXACT_LOOKUP/);
    expect(() => pairLme("EXACT_LOOKUP", lmeRun(), lmeRun({ flagsOn: ["EXACT_LOOKUP", "PAGE_FUSION"] }))).toThrow(/PAGE_FUSION/);
    expect(() => pairLme("EXACT_LOOKUP", lmeRun(), lmeRun({ flagsOn: ["EXACT_LOOKUP"], questions: "ids-b" }))).toThrow(/different questions/);
  });
});

describe("runEvalPromote --live", () => {
  it("joins the labelled dev queries of the live brain, run three times, and refuses an empty set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memrain-promote-live-"));
    const cfgPath = join(dir, "config.json");
    const db = join(dir, "brain.pglite");
    try {
      writeFileSync(cfgPath, JSON.stringify({
        database: { type: "pglite", path: db },
        embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
        storage: {},
      }));
      const seed = new Storage({ dbPath: db });
      await seed.init();
      try {
        await writeDocumentTransaction(seed, { documentId: "doc-ledger", sourcePath: "/notes/ledger.md", title: "Ledger", frontmatter: {}, embeddingModel: "deterministic-test" },
          [{ text: "ledger owner", entities: [], embedding: deterministicEmbed("ledger owner") }]);
      } finally {
        await seed.close();
      }
      const out = join(dir, "out");
      expect(await runEvalPromote({ flag: "EXACT_LOOKUP", live: true, configPath: cfgPath, outDir: out, quiet: true })).toBe(2);
      const label = new Storage({ dbPath: db });
      await label.init();
      try {
        await label.engine().query(
          `INSERT INTO eval_queries (id, query, tag, source, expected_doc_ids, tags, lang, split)
           VALUES ('lbl-1', 'who owns the ledger', 'good', 'labelled', '["doc-ledger"]', '{kind:entity}', 'en', 'dev')`,
        );
      } finally {
        await label.close();
      }
      const searched: string[] = [];
      const code = await runEvalPromote({
        flag: "EXACT_LOOKUP", live: true, configPath: cfgPath, outDir: out, quiet: true,
        liveSearch: async (_s, q) => {
          searched.push(q);
          return ["/notes/ledger.md"];
        },
      });
      expect(code).not.toBe(2);
      expect(searched).toEqual(["who owns the ledger", "who owns the ledger", "who owns the ledger"]);
      const [file] = readdirSync(out);
      const report = JSON.parse(readFileSync(join(out, file!), "utf8")) as { sets: string[]; by_tag: Record<string, { n: number }> };
      expect(report.sets).toEqual(["bench", "live"]);
      expect(report.by_tag["live:kind:entity"]!.n).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
