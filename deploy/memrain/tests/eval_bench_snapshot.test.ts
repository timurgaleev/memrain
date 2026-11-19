/**
 * The ranked pages of every bench query, pinned. A refactor of the search
 * pipeline must leave every list byte-identical; a deliberate ranking change
 * rewrites the snapshot in its own commit (`memrain eval bench
 * --write-snapshot`), where the diff shows exactly which queries moved.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { readBenchSnapshot, runBench, snapshotDiff } from "../src/eval/bench/harness.ts";

setDefaultTimeout(120_000);

describe("bench snapshot", () => {
  it("every bench query still ranks the same pages in the same order", async () => {
    const snapshot = readBenchSnapshot();
    const report = await runBench();
    expect(report.qrels_sha256).toBe(snapshot.qrels_sha256);
    expect(snapshotDiff(snapshot, report)).toEqual([]);
  });
});
