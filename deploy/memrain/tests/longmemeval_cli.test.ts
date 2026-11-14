/**
 * `memrain eval longmemeval` — flag contract and exit codes. The harness
 * itself is covered in longmemeval_harness.test.ts; here the stub boundary
 * only proves which invocations may reach it at all.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvalLongMemEval } from "../src/commands/eval-longmemeval.ts";
import type { LmeQuestion } from "../src/eval/longmemeval/dataset.ts";
import type { LmeBedrock } from "../src/eval/longmemeval/harness.ts";

setDefaultTimeout(60000);

const QUESTION: LmeQuestion = {
  question_id: "q1", question_type: "single-session-user", question: "What colour is my bike?", answer: "red",
  question_date: "2023/05/20 (Sat) 10:00", answer_session_ids: ["s1"],
  sessions: [{ id: "s1", date: "2023/05/01 (Mon) 09:00", turns: [{ role: "user", content: "My bike is red." }] }],
};
const DATASET = { url: "https://example.invalid/lme.json", sha256: "c".repeat(64) };

describe("memrain eval longmemeval", () => {
  let dir: string;
  let paid: number;
  let printed: string[];
  let restore: () => void;
  const bedrock: LmeBedrock = {
    embed: async () => { paid++; return { vector: Array.from({ length: 1024 }).fill(0.01) as number[], inputTokens: 3 }; },
    converse: async () => { paid++; return { text: "yes", inputTokens: 10, outputTokens: 1 }; },
  };
  const load = async () => ({ questions: [QUESTION], dataset: DATASET });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memrain-lme-cli-"));
    paid = 0;
    printed = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => printed.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => printed.push(a.map(String).join(" "));
    restore = () => { console.log = log; console.error = err; };
  });
  afterEach(() => {
    restore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a paid run without --max-usd or --out, before loading anything", async () => {
    let loaded = 0;
    const counting = async () => { loaded++; return load(); };
    expect(await runEvalLongMemEval({ out: join(dir, "run"), bedrock, loadQuestions: counting })).toBe(2);
    expect(await runEvalLongMemEval({ maxUsd: 1, bedrock, loadQuestions: counting })).toBe(2);
    expect(loaded).toBe(0);
    expect(paid).toBe(0);
  });

  it("prints a worst-case estimate on --dry-run with zero paid calls and no run directory", async () => {
    const out = join(dir, "run");
    expect(await runEvalLongMemEval({ dryRun: true, maxUsd: 1, out, bedrock, loadQuestions: load })).toBe(0);
    expect(paid).toBe(0);
    expect(existsSync(out)).toBe(false);
    const report = JSON.parse(printed.join("\n"));
    expect(report.max_usd).toBeGreaterThan(0);
    expect(report.cap_covers).toBe(true);
  });

  it("runs, labels the result, and exits 0 when every question finished", async () => {
    const out = join(dir, "run");
    expect(await runEvalLongMemEval({ maxUsd: 1, out, bedrock, loadQuestions: load })).toBe(0);
    expect(paid).toBeGreaterThan(0);
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(summary.label).toBe("Bedrock-Claude-judged");
    expect(summary.scored).toBe(1);
  });

  it("exits 1 when the cap stops the run", async () => {
    expect(await runEvalLongMemEval({ maxUsd: 0.0000001, out: join(dir, "run"), bedrock, loadQuestions: load })).toBe(1);
    expect(paid).toBe(0);
  });

  it("settles a reservation only through --settle with --usd, and refuses an unknown id", async () => {
    const out = join(dir, "run");
    expect(await runEvalLongMemEval({ out, settle: "nope", usd: 0.1 })).toBe(2);
    expect(await runEvalLongMemEval({ out, settle: "nope" })).toBe(2);
  });

  it("exits 75 when the dataset download fails, leaving no cache file", async () => {
    const cache = join(dir, "cache");
    const failing = (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;
    expect(await runEvalLongMemEval({ dryRun: true, cacheDir: cache, fetchFn: failing })).toBe(75);
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
  });
});

describe("the eval command line", () => {
  const root = join(import.meta.dir, "..");
  function cli(...argv: string[]): { code: number; err: string } {
    const p = Bun.spawnSync(["bun", "src/cli.ts", ...argv], { cwd: root, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, err: new TextDecoder().decode(p.stderr) };
  }

  it("refuses --dry-run on an eval that would ignore it and spend", () => {
    for (const argv of [["eval", "--dry-run"], ["eval", "code", "--dry-run"], ["eval", "chronicle", "--dry-run"]]) {
      const r = cli(...argv);
      expect(r.code).not.toBe(0);
      expect(`${argv.join(" ")}: ${r.err}`).toContain("--dry-run is supported only by 'eval longmemeval'");
    }
  });

  it("refuses a paid LongMemEval run without --out as a usage error", () => {
    const r = cli("eval", "longmemeval", "--max-usd", "1");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--out");
  });
});
