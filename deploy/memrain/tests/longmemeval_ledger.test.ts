/**
 * The LongMemEval spend ledger: every paid call is reserved on disk before it
 * is sent and settled after, so a crash can never hand a resumed run budget it
 * already spent.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapExceeded, SpendLedger, type ReserveInput } from "../src/eval/longmemeval/ledger.ts";

const CALL: ReserveInput = { question_id: "q1", stage: "answer", model: "m", max_usd: 0.5, max_input_bytes: 100, max_tokens: 10 };

describe("SpendLedger", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memrain-lme-ledger-"));
    path = join(dir, "ledger.jsonl");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("charges an unsettled reservation in full after a reopen", () => {
    const id = SpendLedger.open(path).reserve(CALL, 1);
    const again = SpendLedger.open(path);
    expect(again.spentUsd()).toBe(0.5);
    expect(again.unsettled().map((r) => r.id)).toEqual([id]);
  });

  it("replaces a reservation with the settled amount", () => {
    const l = SpendLedger.open(path);
    const id = l.reserve(CALL, 1);
    l.settle(id, { usd: 0.1, outcome: "ok", source: "reported", usage: { inputTokens: 10, outputTokens: 2 } });
    expect(SpendLedger.open(path).spentUsd()).toBeCloseTo(0.1, 10);
    expect(SpendLedger.open(path).unsettled()).toEqual([]);
  });

  it("refuses a reservation the remaining cap cannot cover, writing nothing", () => {
    const l = SpendLedger.open(path);
    l.reserve(CALL, 1);
    const before = readFileSync(path, "utf8");
    expect(() => l.reserve(CALL, 0.9)).toThrow(CapExceeded);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("drops a line torn by a crash mid-append, and only that", () => {
    const l = SpendLedger.open(path);
    l.reserve(CALL, 1);
    appendFileSync(path, '{"t":"reserve","id":"torn"');
    const again = SpendLedger.open(path);
    expect(again.spentUsd()).toBe(0.5);
    again.reserve(CALL, 2);
    expect(SpendLedger.open(path).spentUsd()).toBe(1);
  });

  it("refuses a ledger with a malformed line in the middle", () => {
    SpendLedger.open(path).reserve(CALL, 1);
    appendFileSync(path, "not json\n");
    expect(() => SpendLedger.open(path)).toThrow(/line 2/);
    appendFileSync(path, `${JSON.stringify({ t: "cap", at: "x", max_usd: 1 })}\n`);
    expect(() => SpendLedger.open(path)).toThrow(/line 2/);
  });

  it("lets the operator settle an interrupted call once, at the billed amount", () => {
    const l = SpendLedger.open(path);
    const id = l.reserve(CALL, 1);
    expect(() => l.operatorSettle("nope", 0.1)).toThrow(/unknown/);
    expect(() => l.operatorSettle(id, -1)).toThrow(/amount/);
    expect(() => l.operatorSettle(id, Number.NaN)).toThrow(/amount/);
    l.operatorSettle(id, 0.05);
    expect(SpendLedger.open(path).spentUsd()).toBeCloseTo(0.05, 10);
    expect(() => SpendLedger.open(path).operatorSettle(id, 0.05)).toThrow(/already settled/);
    expect(readFileSync(path, "utf8")).toContain('"t":"operator_settle"');
  });
});
