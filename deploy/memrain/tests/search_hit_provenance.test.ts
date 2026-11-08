import { afterAll, beforeAll, expect, it } from "bun:test";
import { openRankFixture, runSearch, type RankFixture } from "./rank-flags-fixture.ts";
import { applyAliasHop } from "../src/core/search/alias-hop.ts";
import { putPage } from "../src/core/pages.ts";

let fx: RankFixture;
beforeAll(async () => {
  fx = await openRankFixture();
  await fx.storage.engine().query("UPDATE documents SET source_id='default', effective_date='2026-06-01', updated_at='2026-07-02' WHERE id='zephyr_page'");
  await fx.storage.engine().query("UPDATE documents SET source_id='default', effective_date=NULL, updated_at='2026-07-03' WHERE id='zephyr_truth'");
});
afterAll(async () => { await fx.close(); });

it("returns effective or updated dates and owning source on fresh and cached hits", async () => {
  const fresh = await runSearch(fx.storage, "zephyr rollout", { noCache: false });
  const expected = (hits: typeof fresh.hits) => {
    expect(hits.find(h => h.documentId === "zephyr_page")).toMatchObject({ source_id: "default", date: "2026-06-01", date_source: "effective" });
    expect(hits.find(h => h.documentId === "zephyr_truth")).toMatchObject({ source_id: "default", date: "2026-07-03", date_source: "updated" });
  };
  expected(fresh.hits);
  let cached = fresh;
  for (let i = 0; i < 40 && cached.meta?.cache !== "hit"; i++) {
    await Bun.sleep(10);
    cached = await runSearch(fx.storage, "zephyr rollout", { noCache: false });
  }
  expect(cached.meta?.cache).toBe("hit");
  expected(cached.hits);
});

it("carries provenance on an alias-injected result too", async () => {
  await putPage(fx.storage, { slug: "projects/zephyr", compiled_truth: { aliases: ["Zed project"] }, markdown_body: "Project" });
  const hits = await applyAliasHop([], fx.storage, "Zed project", "topic", ["default"]);
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ source_id: "default", date: "2026-06-01", date_source: "effective" });
});
