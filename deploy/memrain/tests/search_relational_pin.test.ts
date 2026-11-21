/**
 * The two-pass rerank keeps relational answers at the head and is skipped when
 * the head is already certain (relational-pin.ts, confidence-grade.ts,
 * stages/pipeline.ts rerankWindow). The reranker is a stub function here: no
 * Bedrock, no module mocks.
 */
import { describe, expect, it } from "bun:test";
import { pinRelationalRows, RELATIONAL_PIN_MAX } from "../src/core/search/relational-pin.ts";
import { rerankConfident } from "../src/core/search/confidence-grade.ts";
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
    // alice held 1st before the rerank and gets it back; bob held 4th and keeps it.
    expect(slugs(out.hits)).toEqual(["people/alice", "notes/a", "notes/b", "people/bob", "notes/c"]);
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

  // Value: protects=the pin only restores places, so a low relational row never takes the
  // reranker's top answers; fails_when=relational rows are moved to the head regardless.
  it("leaves relational rows the reranker did not demote where they are", () => {
    const window = ["t0", "t1", "t2", "t3", "t4", "r5", "r6", "r7"].map((s, i) => hit(s, 1 - i / 10));
    const reranked = [window[1]!, window[0]!, window[3]!, window[2]!, window[4]!, window[5]!, window[6]!, window[7]!];
    const out = pinRelationalRows(reranked, window, new Set(["r5", "r6", "r7"].map(page)));
    expect(slugs(out.hits)).toEqual(slugs(reranked));
  });

  it("is a no-op without relational pages in the window", () => {
    const reranked = [...pre].reverse();
    expect(slugs(pinRelationalRows(reranked, pre, new Set([page("elsewhere")])).hits)).toEqual(slugs(reranked));
    expect(slugs(pinRelationalRows(reranked, pre, new Set()).hits)).toEqual(slugs(reranked));
  });
});

describe("rerankConfident", () => {
  it("is strong on a title phrase match or both arms putting the top page first", () => {
    const base = { query: "ledger reconciliation", topTitle: "Other", topPage: page("a") };
    expect(rerankConfident({ ...base, topTitle: "Ledger reconciliation runbook" })).toBe(true);
    expect(rerankConfident({ ...base, vectorTopPage: page("a"), keywordTopPage: page("a") })).toBe(true);
    expect(rerankConfident({ ...base, vectorTopPage: page("a"), keywordTopPage: page("b") })).toBe(false);
    expect(rerankConfident({ ...base, keywordTopPage: page("a") })).toBe(false);
    expect(rerankConfident(base)).toBe(false);
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

  // Value: protects=no paid call when both arms put the top page first;
  // fails_when=the gate is ignored and the reranker runs.
  it("skips the reranker when the head is certain", async () => {
    let calls = 0;
    const counting = async (q: string, w: Hit[]) => { calls++; return reversed(q, w); };
    const outcomes: RerankOutcome[] = [];
    const gate = { vectorTopPage: page("people/alice"), keywordTopPage: page("people/alice"), relationalPages: new Set<string>() };
    const out = await rerankWindow(pool, ctxFor(gate, outcomes), counting);
    expect(calls).toBe(0);
    expect(slugs(out)).toEqual(slugs(pool));
    expect(outcomes).toEqual([{ outcome: "skipped_confident", pinned: 0 }]);
  });

  // Value: protects=a rerank still separates two pages whose titles both hold the query;
  // fails_when=a title phrase match on the top hit alone skips the call.
  it("runs the reranker when another hit in the window also holds the query in its title", async () => {
    let calls = 0;
    const counting = async (q: string, w: Hit[]) => { calls++; return reversed(q, w); };
    const atlas = [hit("notes/atlas-2023", 1, "Project Atlas Budget 2023"), hit("notes/atlas-2026", 0.9, "Project Atlas Budget 2026"), hit("notes/x", 0.8)];
    await rerankWindow(atlas, ctxFor({ relationalPages: new Set<string>() }, [], "project atlas budget"), counting);
    expect(calls).toBe(1);
    const single = [atlas[0]!, hit("notes/y", 0.9), hit("notes/x", 0.8)];
    await rerankWindow(single, ctxFor({ relationalPages: new Set<string>() }, [], "project atlas budget"), counting);
    expect(calls).toBe(1);
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
