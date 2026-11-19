/**
 * The feedback stage of hybrid search: off, it reads nothing; on without
 * ratings, search returns exactly what it returned before; a rated page moves
 * within 1 ± λ without its score being rewritten, and a cached ordering does
 * not outlive the weights it was ranked with.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { applyFeedbackStage } from "../src/core/search/feedback-boost.ts";
import { recordRating } from "../src/core/feedback/store.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";

setDefaultTimeout(60_000);

const saved = process.env["MEMRAIN_FEEDBACK"];
afterEach(() => {
  if (saved === undefined) delete process.env["MEMRAIN_FEEDBACK"];
  else process.env["MEMRAIN_FEEDBACK"] = saved;
});

let tmp: string;
let storage: Storage;

const PAGES: Array<[string, string, string]> = [
  ["notes/beds-north", "North bed", "The garden tomato plan puts tomatoes in the north bed, next to the basil and the peppers."],
  ["notes/beds-south", "South fence", "Our garden tomato plan: cherry tomatoes go along the south fence, watered by the drip line."],
  ["notes/compost", "Compost", "Compost goes on the beds in autumn before the frost."],
];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-feedback-stage-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const [slug, title, body] of PAGES) {
    await putPage(storage, { slug, markdown_body: body, title });
    await indexPageIntoSearch(storage, { slug, markdown_body: body, title }, { embedFn: deterministicEmbedQuery });
  }
});
afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const hit = (slug: string, score: number) => ({ score, payload: { sourcePath: `page://${slug}` } });
const throwingEngine = new Proxy({}, { get: () => () => { throw new Error("feedback off must not touch the engine"); } }) as unknown as Engine;

describe("feedback stage", () => {
  it("off: returns the list itself and reads nothing", async () => {
    delete process.env["MEMRAIN_FEEDBACK"];
    const hits = [hit("notes/a", 2), hit("notes/b", 1)];
    expect(await applyFeedbackStage(throwingEngine, hits)).toBe(hits);
    process.env["MEMRAIN_FEEDBACK"] = "0";
    expect(await applyFeedbackStage(throwingEngine, hits)).toBe(hits);
  });

  it("on, a failing read leaves the list as it was", async () => {
    process.env["MEMRAIN_FEEDBACK"] = "1";
    const hits = [hit("notes/a", 2), hit("notes/b", 1)];
    expect(await applyFeedbackStage(throwingEngine, hits)).toBe(hits);
  });

  it("on, a well-rated page moves up by at most λ and keeps its score", async () => {
    process.env["MEMRAIN_FEEDBACK"] = "1";
    const e = storage.engine();
    for (const m of ["ann", "bob", "cid", "dan"]) {
      expect((await recordRating(e, { sourceId: "default", slug: "notes/compost", principal: `member:${m}`, tier: "member", rating: 1, signal: "explicit" })).ok).toBe(true);
    }
    await recordRating(e, { sourceId: "default", slug: "notes/compost", principal: "operator", tier: "owner", rating: 1, signal: "explicit" });
    const close = [hit("notes/beds-north", 1.0), hit("notes/compost", 0.95)];
    const out = await applyFeedbackStage(e, close);
    expect(out.map(h => h.payload.sourcePath)).toEqual(["page://notes/compost", "page://notes/beds-north"]);
    expect(out.find(h => h.payload.sourcePath === "page://notes/compost")!.score).toBe(0.95);
    // Beyond λ the order holds.
    const far = [hit("notes/beds-north", 1.0), hit("notes/compost", 0.85)];
    expect((await applyFeedbackStage(e, far)).map(h => h.payload.sourcePath)).toEqual(["page://notes/beds-north", "page://notes/compost"]);
    await e.query(`DELETE FROM retrieval_feedback`);
    await e.query(`DELETE FROM retrieval_weights`);
  });
});

describe("hybrid search with feedback", () => {
  let lastCache = "";
  const search = (noCache: boolean) =>
    hybridSearch(storage, "garden tomato plan", {
      k: 3,
      embedQuery: deterministicEmbedQuery,
      noCache,
      noTelemetry: true,
      onMeta: (m) => { lastCache = m.cache; },
    });

  it("without ratings, returns exactly what it returned with feedback off", async () => {
    delete process.env["MEMRAIN_FEEDBACK"];
    const off = await search(true);
    process.env["MEMRAIN_FEEDBACK"] = "1";
    const on = await search(true);
    expect(off.length).toBeGreaterThan(1);
    // Recency decay moves scores in the ninth digit between two calls.
    const view = (hits: typeof off) => hits.map(h => ({ ...h, score: Number(h.score.toPrecision(7)) }));
    expect(view(on)).toEqual(view(off));
  });

  it("a rating made after a cached search is seen by the next search", async () => {
    process.env["MEMRAIN_FEEDBACK"] = "1";
    const e = storage.engine();
    const first = await search(false);
    const second = first[1]!;
    const slug = second.sourcePath.replace(/^page:\/\//, "");
    // Let the fire-and-forget cache write land, and prove it is served.
    for (let i = 0; i < 40; i++) {
      const n = (await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM query_cache`)).rows[0]!.n;
      if (n > 0) break;
      await Bun.sleep(25);
    }
    expect((await search(false)).map(h => h.chunkId)).toEqual(first.map(h => h.chunkId));
    expect(lastCache).toBe("hit");
    const gap = first[0]!.score / second.score;
    expect(gap).toBeLessThan(1.1);
    for (const m of ["ann", "bob", "cid", "dan", "eve", "fay"]) {
      await recordRating(e, { sourceId: "default", slug, principal: `member:${m}`, tier: "member", rating: 1, signal: "explicit" });
    }
    await recordRating(e, { sourceId: "default", slug, principal: "operator", tier: "owner", rating: 1, signal: "explicit" });
    const after = await search(false);
    expect(lastCache).toBe("miss");
    expect(after[0]!.sourcePath).toBe(second.sourcePath);
  });
});
