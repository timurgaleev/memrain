/**
 * Tests for the eval-replay regression harness.
 *
 * Coverage:
 *   - scoreOne: hit / miss / no-expected math
 *   - recordQuery: insert + idempotent update
 *   - listQueries: tag filter + limit
 *   - replayAll: aggregate metrics, baseline deltas, --promote behaviour
 *
 * The hybrid-search side is stubbed via the `searcher` option so tests
 * stay offline and deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  recordQuery,
  listQueries,
  getQuery,
  deleteQuery,
  replayAll,
  scoreOne,
} from "../src/core/eval-replay.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-eval-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("scoreOne", () => {
  it("returns hit + rank 1 + rr 1 for the top result", () => {
    expect(scoreOne(["d1", "d2", "d3"], "d1")).toEqual({
      hit: true,
      rank: 1,
      rr: 1,
    });
  });
  it("returns hit + rank 3 + rr 0.333… for third result", () => {
    const r = scoreOne(["a", "b", "c"], "c");
    expect(r.hit).toBe(true);
    expect(r.rank).toBe(3);
    expect(r.rr).toBeCloseTo(1 / 3, 6);
  });
  it("returns miss when expected is absent", () => {
    expect(scoreOne(["a", "b"], "z")).toEqual({
      hit: false,
      rank: null,
      rr: 0,
    });
  });
  it("ranks documents, not chunks: two chunks of one document hold one rank", () => {
    const r = scoreOne(["b", "b", "a"], "a");
    expect(r.rank).toBe(2);
    expect(r.rr).toBe(0.5);
  });
  it("returns nulls when no expected doc provided", () => {
    expect(scoreOne(["a"], null)).toEqual({
      hit: null,
      rank: null,
      rr: null,
    });
  });
});

describe("recordQuery", () => {
  it("creates a row with sane defaults", async () => {
    const r = await recordQuery(storage.engine(), {
      id: "q1",
      query: "home assistant zigbee",
      tag: "good",
    });
    expect(r.id).toBe("q1");
    expect(r.k).toBe(5);
    expect(r.tag).toBe("good");
    expect(r.source).toBe("manual");
    expect(r.expectedDocId).toBeNull();
  });

  it("is idempotent — same id updates in place", async () => {
    await recordQuery(storage.engine(), {
      id: "q1",
      query: "v1",
      tag: "good",
    });
    const updated = await recordQuery(storage.engine(), {
      id: "q1",
      query: "v2",
      tag: "bad",
      notes: "actually wrong",
    });
    expect(updated.query).toBe("v2");
    expect(updated.tag).toBe("bad");
    expect(updated.notes).toBe("actually wrong");
    const all = await listQueries(storage.engine(), {});
    expect(all.length).toBe(1);
  });

  it("rejects an invalid tag", async () => {
    await expect(
      recordQuery(storage.engine(), {
        id: "q1",
        query: "x",
        tag: "ugly" as never,
      }),
    ).rejects.toThrow();
  });

  it("rejects out-of-range k", async () => {
    await expect(
      recordQuery(storage.engine(), {
        id: "q1",
        query: "x",
        tag: "good",
        k: 0,
      }),
    ).rejects.toThrow();
  });
});

describe("listQueries + delete", () => {
  it("filters by tag", async () => {
    await recordQuery(storage.engine(), { id: "g", query: "g", tag: "good" });
    await recordQuery(storage.engine(), { id: "b", query: "b", tag: "bad" });
    const goods = await listQueries(storage.engine(), { tag: "good" });
    expect(goods.map((r) => r.id)).toEqual(["g"]);
    const all = await listQueries(storage.engine(), {});
    expect(all.length).toBe(2);
  });

  it("delete removes the row", async () => {
    await recordQuery(storage.engine(), { id: "x", query: "x", tag: "good" });
    const ok = await deleteQuery(storage.engine(), "x");
    expect(ok).toBe(true);
    expect(await getQuery(storage.engine(), "x")).toBeNull();
  });
});

describe("replayAll", () => {
  it("scores hits and misses, computes meanRR over rows with an expected doc", async () => {
    const e = storage.engine();
    await recordQuery(e, {
      id: "q1",
      query: "alpha",
      tag: "good",
      expectedDocId: "d1",
    });
    await recordQuery(e, {
      id: "q2",
      query: "beta",
      tag: "good",
      expectedDocId: "d2",
    });
    await recordQuery(e, {
      id: "q3",
      query: "gamma",
      tag: "bad",
      // no expected — counts in totalQueries but not in scored.
    });

    const stub = async (q: string) => {
      if (q === "alpha") return [{ documentId: "d1" }, { documentId: "x" }];
      if (q === "beta") return [{ documentId: "x" }, { documentId: "y" }];
      return [{ documentId: "z" }];
    };

    const r = await replayAll(storage, { searcher: stub });
    expect(r.totalQueries).toBe(3);
    expect(r.scored).toBe(2);
    // q1 hits at rank 1 (rr=1), q2 misses (rr=0); meanRR = 0.5
    expect(r.meanRR).toBe(0.5);
    expect(r.hitRate).toBe(0.5);
    expect(r.baseline).toBeUndefined();
    expect(r.perQuery.find((p) => p.queryId === "q1")?.hit).toBe(true);
    expect(r.perQuery.find((p) => p.queryId === "q2")?.hit).toBe(false);
    expect(r.perQuery.find((p) => p.queryId === "q3")?.hit).toBeNull();
  });

  it("computes run-to-run stability (jaccard + top1) vs the promoted baseline", async () => {
    const e = storage.engine();
    // Baselines are persisted by --promote only for expected-doc queries, so
    // stability currently rides on those (broadening to all queries is a TODO).
    await recordQuery(e, { id: "s1", query: "alpha", tag: "good", k: 3, expectedDocId: "a" });

    // First run promotes the baseline: top-3 = [a, b, c].
    const baseStub = async () => [
      { documentId: "a" },
      { documentId: "b" },
      { documentId: "c" },
    ];
    await replayAll(storage, { searcher: baseStub, promote: true });

    // Second run: rank-1 unchanged (a), one of three swapped (c→x).
    // jaccard top-3 = |{a,b}| / |{a,b,c,x}| = 2/4 = 0.5; top1 stable.
    const nextStub = async () => [
      { documentId: "a" },
      { documentId: "b" },
      { documentId: "x" },
    ];
    const r = await replayAll(storage, { searcher: nextStub });
    const pq = r.perQuery.find((p) => p.queryId === "s1");
    expect(pq?.stability).toEqual({ jaccard: 0.5, top1: true });
    expect(r.stability).toEqual({
      scored: 1,
      meanJaccard: 0.5,
      top1StableRate: 1,
    });
  });

  it("leaves stability null + aggregate absent when there is no baseline", async () => {
    const e = storage.engine();
    await recordQuery(e, { id: "nb", query: "alpha", tag: "good" });
    const stub = async () => [{ documentId: "a" }];
    const r = await replayAll(storage, { searcher: stub });
    expect(r.perQuery.find((p) => p.queryId === "nb")?.stability).toBeNull();
    expect(r.stability).toBeUndefined();
  });

  it("threads searchMode into the searcher dispatch", async () => {
    const e = storage.engine();
    await recordQuery(e, {
      id: "h",
      query: "alpha",
      tag: "good",
      expectedDocId: "d1",
      searchMode: "hybrid",
    });
    await recordQuery(e, {
      id: "k",
      query: "beta",
      tag: "good",
      expectedDocId: "d2",
      searchMode: "keyword",
    });

    const seen: { query: string; mode: string }[] = [];
    const stub = async (
      query: string,
      _opts: unknown,
      mode: "hybrid" | "keyword",
    ) => {
      seen.push({ query, mode });
      return [{ documentId: query === "alpha" ? "d1" : "d2" }];
    };

    const r = await replayAll(storage, { searcher: stub });
    expect(r.scored).toBe(2);
    expect(r.meanRR).toBe(1);
    // Replay walks the set in id order ("h" < "k"), not capture order.
    expect(seen).toEqual([
      { query: "alpha", mode: "hybrid" },
      { query: "beta", mode: "keyword" },
    ]);
  });

  it("replays the same subset under a limit, whatever order the rows were captured in", async () => {
    const e = storage.engine();
    // Captured newest-last: c, then a, then b.
    for (const id of ["c", "a", "b"]) {
      await recordQuery(e, { id, query: id, tag: "good", expectedDocId: id });
    }
    const stub = async (q: string) => [{ documentId: q }];
    const first = await replayAll(storage, { searcher: stub, limit: 2 });
    expect(first.perQuery.map((p) => p.queryId)).toEqual(["a", "b"]);
    await recordQuery(e, { id: "d", query: "d", tag: "good", expectedDocId: "d" });
    const second = await replayAll(storage, { searcher: stub, limit: 2 });
    expect(second.perQuery.map((p) => p.queryId)).toEqual(["a", "b"]);
    expect(second.replayedIdsSha256).toBe(first.replayedIdsSha256);
    const all = await replayAll(storage, { searcher: stub });
    expect(all.replayedIdsSha256).not.toBe(first.replayedIdsSha256);
  });

  it("dedups repeated documents before scoring and stability", async () => {
    const e = storage.engine();
    await recordQuery(e, { id: "q", query: "q", tag: "good", k: 3, expectedDocId: "a" });
    const stub = async () => [{ documentId: "b" }, { documentId: "b" }, { documentId: "a" }];
    const r = await replayAll(storage, { searcher: stub });
    const pq = r.perQuery[0]!;
    expect(pq.resultDocIds).toEqual(["b", "a"]);
    expect(pq.rank).toBe(2);
    expect(r.meanRR).toBe(0.5);
  });

  it("counts queries without an expected doc instead of dropping them silently", async () => {
    const e = storage.engine();
    await recordQuery(e, { id: "scored", query: "s", tag: "good", expectedDocId: "a" });
    await recordQuery(e, { id: "quiet", query: "quiet", tag: "bad" });
    await recordQuery(e, { id: "noisy", query: "noisy", tag: "bad" });
    const stub = async (q: string) => (q === "quiet" ? [] : [{ documentId: "a" }]);
    const r = await replayAll(storage, { searcher: stub });
    expect(r.scored).toBe(1);
    expect(r.unscored).toEqual({ count: 2, returnedAny: 1 });
  });

  it("rejects an invalid searchMode at capture time", async () => {
    await expect(
      recordQuery(storage.engine(), {
        id: "x",
        query: "q",
        tag: "good",
        searchMode: "fancy" as never,
      }),
    ).rejects.toThrow();
  });

  it("--promote persists the baseline; subsequent run reports deltas", async () => {
    const e = storage.engine();
    await recordQuery(e, {
      id: "q1",
      query: "alpha",
      tag: "good",
      expectedDocId: "d1",
    });
    // First run hits at rank 1.
    const stubA = async () => [{ documentId: "d1" }, { documentId: "x" }];
    const first = await replayAll(storage, { searcher: stubA, promote: true });
    expect(first.meanRR).toBe(1);
    expect(first.baseline).toBeUndefined(); // no prior baseline yet

    // Second run regresses — d1 falls out of top-k.
    const stubB = async () => [{ documentId: "x" }, { documentId: "y" }];
    const second = await replayAll(storage, { searcher: stubB });
    expect(second.meanRR).toBe(0);
    expect(second.baseline).toBeDefined();
    expect(second.baseline?.meanRR).toBe(1);
    expect(second.baseline?.deltaMeanRR).toBe(-1);
    expect(second.baseline?.deltaHitRate).toBe(-1);
    const q1 = second.perQuery.find((p) => p.queryId === "q1")!;
    expect(q1.delta?.hit).toBe(-1);
    expect(q1.delta?.rr).toBe(-1);
  });
});
