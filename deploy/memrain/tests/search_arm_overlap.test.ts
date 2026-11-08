import { afterAll, beforeAll, expect, it, spyOn, setSystemTime } from "bun:test";
import { FIXED_NOW, openRankFixture, runSearch, type RankFixture } from "./rank-flags-fixture.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";

let fx: RankFixture;
beforeAll(async () => { setSystemTime(FIXED_NOW); fx = await openRankFixture(); });
afterAll(async () => { setSystemTime(); await fx.close(); });

it("starts keyword and title retrieval before the embedding completes, preserving ranking", async () => {
  const baseline = await runSearch(fx.storage, "zephyr rollout", { intent: "topic" });
  const e = fx.storage.engine();
  const original = e.query.bind(e);
  let release!: () => void;
  const embeddingGate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const lexicalStarted = new Promise<void>(resolve => { started = resolve; });
  let keyword = false;
  let title = false;
  const query = spyOn(e, "query").mockImplementation(async (sql, params) => {
    if (sql.includes("search_vector")) keyword = true;
    if (sql.includes("AS ident_title")) title = true;
    if (keyword && title) started();
    return original(sql, params);
  });
  const result = runSearch(fx.storage, "zephyr rollout", {
    intent: "topic", embedQuery: async text => { await embeddingGate; return deterministicEmbedQuery(text); },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([lexicalStarted, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    expect({ keyword, title }).toEqual({ keyword: true, title: true });
  } finally {
    clearTimeout(timer);
    release();
    query.mockRestore();
    expect((await result).hits).toEqual(baseline.hits);
  }
});
