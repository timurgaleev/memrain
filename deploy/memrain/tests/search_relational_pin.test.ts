/**
 * The two-pass rerank keeps relational answers at the head, and its confidence
 * gate grades the head in shadow only (relational-pin.ts, confidence-grade.ts,
 * stages/pipeline.ts rerankWindow). The reranker is a stub function here: no
 * Bedrock, no module mocks.
 */
import { describe, expect, it } from "bun:test";
import { pinRelationalRows, RELATIONAL_PIN_MAX, relationalPinMax } from "../src/core/search/relational-pin.ts";
import { rerankConfident, rerankGateMode } from "../src/core/search/confidence-grade.ts";
import { rerankWindow, stageContext } from "../src/core/search/stages/pipeline.ts";
import type { Hit, RerankOutcome, StageInput } from "../src/core/search/stages/types.ts";
import { classifyQuerySuggestions } from "../src/core/search/query-intent.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const hit = (slug: string, score: number, title = slug): Hit => ({
  chunkId: `${slug}_c0`,
  documentId: slug,
  score,
  payload: { content: `${slug} text`, title, sourcePath: `page://${slug}`, source_id: "default", source_kind: null },
});
const page = (slug: string) => `default:${slug}`;
const slugs = (hits: readonly Hit[]) => hits.map((h) => h.documentId);
const reversed = async (_q: string, window: Hit[]) => [...window].reverse().map((h, i) => ({ ...h, score: window.length - i }));

describe("pinRelationalRows", () => {
  const pre = ["people/alice", "notes/a", "notes/b", "people/bob", "notes/c"].map((s, i) => hit(s, 1 - i / 10));
  const rel = new Set([page("people/alice"), page("people/bob")]);

  // Value: protects=a relational answer the reranker pushed down returns to the head;
  // fails_when=the pin is skipped and the reranked order stands.
  it("gives reranked-down relational pages back the places the reranker took", () => {
    const reranked = [pre[1]!, pre[2]!, pre[4]!, pre[3]!, pre[0]!];
    const out = pinRelationalRows(reranked, pre, rel);
    // alice and bob were the first and second relational pages before the rerank:
    // they form the head block in that order, the text rows follow in reranked order.
    expect(slugs(out.hits)).toEqual(["people/alice", "people/bob", "notes/a", "notes/b", "notes/c"]);
    expect(out.pinned).toBe(2);
    expect(out.hits.map((h) => h.score)).toEqual([5, 4, 3, 2, 1]);
  });

  it("leaves the window alone when the rerank kept the input order (its fail-open path)", () => {
    const out = pinRelationalRows([...pre], pre, rel);
    expect(slugs(out.hits)).toEqual(slugs(pre));
    expect(out.pinned).toBe(0);
    expect(out.hits.map((h) => h.score)).toEqual(pre.map((h) => h.score));
  });

  it("breaks a tie toward the pre-rerank order, not the reranker's", () => {
    // The reranker put bob first; alice still claims rank 0 among relational rows.
    const reranked = [pre[3]!, pre[1]!, pre[2]!, pre[4]!, pre[0]!];
    expect(slugs(pinRelationalRows(reranked, pre, rel).hits)).toEqual(["people/alice", "people/bob", "notes/a", "notes/b", "notes/c"]);
  });

  it("pins at most RELATIONAL_PIN_MAX pages and never adds a row the window lacks", () => {
    const many = ["r1", "r2", "r3", "r4", "t1"].map((s, i) => hit(s, 1 - i / 10));
    const allRel = new Set(["r1", "r2", "r3", "r4", "gone"].map(page));
    const out = pinRelationalRows([...many].reverse(), many, allRel);
    expect(out.pinned).toBe(RELATIONAL_PIN_MAX);
    // r4 claims rank 1 from where the reranker put it, ahead of r3.
    expect(slugs(out.hits)).toEqual(["r1", "r2", "r4", "t1", "r3"]);
    expect(out.hits).toHaveLength(many.length);
  });

  // Value: protects=the first relational answer claims the head wherever fusion put it;
  // fails_when=a relational page only gets back the slot it held before the rerank.
  it("puts the relational pages at the head even when fusion placed them low", () => {
    const window = ["t0", "t1", "t2", "t3", "t4", "r5", "r6", "r7"].map((s, i) => hit(s, 1 - i / 10));
    const reranked = [window[1]!, window[0]!, window[3]!, window[2]!, window[4]!, window[5]!, window[6]!, window[7]!];
    const out = pinRelationalRows(reranked, window, new Set(["r5", "r6", "r7"].map(page)));
    expect(slugs(out.hits)).toEqual(["r5", "r6", "r7", "t1", "t0", "t3", "t2", "t4"]);
    expect(out.pinned).toBe(3);
  });

  // Value: protects=the operator can size or turn off the pin; fails_when=the size is fixed.
  it("takes its size from MEMRAIN_RELATIONAL_RERANK_PIN, 0 or off leaving the reranked order", () => {
    expect(relationalPinMax(undefined)).toBe(RELATIONAL_PIN_MAX);
    expect(relationalPinMax("0")).toBe(0);
    expect(relationalPinMax("off")).toBe(0);
    expect(relationalPinMax("1")).toBe(1);
    expect(relationalPinMax("11")).toBe(RELATIONAL_PIN_MAX);
    expect(relationalPinMax("-2")).toBe(RELATIONAL_PIN_MAX);
    const reranked = [pre[1]!, pre[2]!, pre[4]!, pre[3]!, pre[0]!];
    expect(slugs(pinRelationalRows(reranked, pre, rel, 0).hits)).toEqual(slugs(reranked));
    expect(slugs(pinRelationalRows(reranked, pre, rel, 1).hits)).toEqual(["people/alice", "notes/a", "notes/b", "notes/c", "people/bob"]);
  });

  it("is a no-op without relational pages in the window", () => {
    const reranked = [...pre].reverse();
    expect(slugs(pinRelationalRows(reranked, pre, new Set([page("elsewhere")])).hits)).toEqual(slugs(reranked));
    expect(slugs(pinRelationalRows(reranked, pre, new Set()).hits)).toEqual(slugs(reranked));
  });
});

describe("rerankConfident", () => {
  it("is strong on a whole-title match or both arms putting the top page first", () => {
    const base = { query: "ledger reconciliation", topTitle: "Other", topPage: page("a") };
    expect(rerankConfident({ ...base, topTitle: "Ledger Reconciliation" })).toBe("exact_title_match");
    // A phrase inside a longer title is not identity.
    expect(rerankConfident({ ...base, topTitle: "Ledger reconciliation runbook" })).toBeNull();
    expect(rerankConfident({ ...base, vectorTopPage: page("a"), keywordTopPage: page("a") })).toBe("arms_agree");
    expect(rerankConfident({ ...base, vectorTopPage: page("a"), keywordTopPage: page("b") })).toBeNull();
    expect(rerankConfident({ ...base, keywordTopPage: page("a") })).toBeNull();
    expect(rerankConfident(base)).toBeNull();
  });

  it("reads MEMRAIN_RERANK_GATE as off unless it says shadow", () => {
    expect(rerankGateMode(undefined)).toBe("off");
    expect(rerankGateMode("shadow")).toBe("shadow");
    expect(rerankGateMode(" Shadow ")).toBe("shadow");
    expect(rerankGateMode("on")).toBe("off");
  });
});

describe("rerankWindow", () => {
  const noDb = { query: async () => { throw new Error("no database here"); } } as unknown as Engine;
  const query = "who works at acme";
  const ctxFor = (gate: StageInput["rerankGate"], outcomes: RerankOutcome[], q = query) => stageContext({
    engine: noDb, query: q, intent: "topic", opts: {}, detailResolved: "medium",
    suggestions: classifyQuerySuggestions(q),
    rank: { metadataGate: false, entityTruthSoft: false, pageFusion: false, keywordConfidence: false, exactLookup: false },
    k: 3, structural: false, graphFloorRatio: undefined, graphSignalsOn: false, backlinkBoostOn: false,
    rerankWanted: true, votes: { vectorVoted: true, lexicalVoted: true }, explainAcc: null,
    ...(gate ? { rerankGate: gate } : {}),
    onRerank: (o) => outcomes.push(o),
  });
  const pool = ["people/alice", "notes/acme-1", "notes/acme-2", "notes/acme-3"].map((s, i) => hit(s, 1 - i / 10));

  // Value: protects=a relational answer stays in the first k through a reranker that judges
  // text only; fails_when=the stage returns the reranker's order unpinned (alice falls to 4th).
  it("re-pins the relational page the reranker demoted out of the first k", async () => {
    const outcomes: RerankOutcome[] = [];
    const out = await rerankWindow(pool, ctxFor({ relationalPages: new Set([page("people/alice")]) }, outcomes), reversed);
    expect(out[0]!.documentId).toBe("people/alice");
    expect(outcomes).toEqual([{ outcome: "ran", pinned: 1 }]);
  });

  // Value: protects=the gate never skips the paid rerank, it only records what it would do;
  // fails_when=a confident head skips the call live.
  it("runs the reranker on a certain head and, in shadow mode, records that it would skip", async () => {
    const saved = process.env["MEMRAIN_RERANK_GATE"];
    try {
      let calls = 0;
      const counting = async (q: string, w: Hit[]) => { calls++; return reversed(q, w); };
      const gate = { vectorTopPage: page("people/alice"), keywordTopPage: page("people/alice"), relationalPages: new Set<string>() };
      delete process.env["MEMRAIN_RERANK_GATE"];
      const off: RerankOutcome[] = [];
      await rerankWindow(pool, ctxFor(gate, off), counting);
      expect(calls).toBe(1);
      expect(off).toEqual([{ outcome: "ran", pinned: 0 }]);
      process.env["MEMRAIN_RERANK_GATE"] = "shadow";
      const shadow: RerankOutcome[] = [];
      const out = await rerankWindow(pool, ctxFor(gate, shadow), counting);
      expect(calls).toBe(2);
      expect(slugs(out)).toEqual(slugs([...pool].reverse()));
      expect(shadow).toEqual([{ outcome: "ran", pinned: 0, would_skip: true, gate_reason: "arms_agree" }]);
    } finally {
      if (saved === undefined) delete process.env["MEMRAIN_RERANK_GATE"];
      else process.env["MEMRAIN_RERANK_GATE"] = saved;
    }
  });

  it("in shadow mode does not grade a head whose title another hit shares as certain", async () => {
    const saved = process.env["MEMRAIN_RERANK_GATE"];
    process.env["MEMRAIN_RERANK_GATE"] = "shadow";
    try {
      const atlas = [hit("notes/atlas-a", 1, "Project Atlas Budget"), hit("notes/atlas-b", 0.9, "Project Atlas Budget"), hit("notes/x", 0.8)];
      const twin: RerankOutcome[] = [];
      await rerankWindow(atlas, ctxFor({ relationalPages: new Set<string>() }, twin, "project atlas budget"), reversed);
      expect(twin[0]!.would_skip).toBe(false);
      const single: RerankOutcome[] = [];
      await rerankWindow([atlas[0]!, hit("notes/y", 0.9), hit("notes/x", 0.8)], ctxFor({ relationalPages: new Set<string>() }, single, "project atlas budget"), reversed);
      expect(single[0]).toMatchObject({ would_skip: true, gate_reason: "exact_title_match" });
    } finally {
      if (saved === undefined) delete process.env["MEMRAIN_RERANK_GATE"];
      else process.env["MEMRAIN_RERANK_GATE"] = saved;
    }
  });

  it("runs the reranker once when the arms disagree", async () => {
    let calls = 0;
    const counting = async (q: string, w: Hit[]) => { calls++; return reversed(q, w); };
    const gate = { vectorTopPage: page("people/alice"), keywordTopPage: page("notes/acme-1"), relationalPages: new Set<string>() };
    const out = await rerankWindow(pool, ctxFor(gate, []), counting);
    expect(calls).toBe(1);
    expect(slugs(out)).toEqual(slugs([...pool].reverse()));
  });
});
