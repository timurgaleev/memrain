/**
 * `memrain eval gate --bench`: the regression gate scored on the synthetic
 * bench instead of the live brain, so a ranking refactor can be held to
 * `--max-drop 0` with no model spend. A decoy the scorer accepts fails it.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvalGate } from "../src/commands/eval-compare.ts";
import { benchQrelsPath } from "../src/eval/bench/harness.ts";

setDefaultTimeout(120_000);

let dir: string;
let logs: string[];
let restore: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memrain-gate-bench-"));
  logs = [];
  const log = spyOn(console, "log").mockImplementation((line: unknown) => { logs.push(String(line)); });
  const err = spyOn(console, "error").mockImplementation(() => {});
  restore = () => { log.mockRestore(); err.mockRestore(); };
});
afterEach(() => {
  restore();
  rmSync(dir, { recursive: true, force: true });
});

const lastJson = () => JSON.parse(logs.at(-1)!) as { ok: boolean; reasons: string[]; decoys?: { passed: string[] } };

describe("eval gate --bench", () => {
  it("writes a baseline, then holds an unchanged search to a zero drop", async () => {
    const baseline = join(dir, "baseline.json");
    expect(await runEvalGate({ bench: true, baseline, writeBaseline: true })).toBe(0);
    expect(JSON.parse(readFileSync(baseline, "utf8")).per_query).toBeDefined();
    expect(await runEvalGate({ bench: true, baseline, maxDrop: 0 })).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, reasons: [], decoys: { passed: [] } });
  });

  it("fails when the scorer would accept a decoy", async () => {
    const qrels = JSON.parse(readFileSync(benchQrelsPath(), "utf8")) as { queries: { decoy_output?: string[]; expected_paths: string[] }[] };
    for (const q of qrels.queries) if (q.decoy_output) q.decoy_output = [...q.expected_paths];
    const leaky = join(dir, "qrels.json");
    writeFileSync(leaky, JSON.stringify(qrels));
    expect(await runEvalGate({ bench: true, qrelsPath: leaky, baseline: join(dir, "none.json") })).toBe(1);
    expect(lastJson().reasons.join(" ")).toContain("decoy");
  });
});
