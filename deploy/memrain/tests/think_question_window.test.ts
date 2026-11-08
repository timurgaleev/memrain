import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { runThink } from "../src/core/synthesis/think.ts";
import * as hybrid from "../src/core/search/hybrid.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

const model: SonnetFn = async () => ({ text: '{"answer":"No dated evidence.","citations":[],"gaps":[]}', modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 10 } });
for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`think date window ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  for (const [question, day] of [
    ["What happened on 2026-02-28?", "2026-02-28"],
    ["What happened 2026-02-30?", undefined],
    ["Compare 2026-02-28 and 2026-03-01", undefined],
    ...["since", "after", "before", "until", "from", "by", "between"].map(p => [`What happened ${p} 2026-02-28?`, undefined]),
  ]) it(`bounds only an unambiguous day: ${question}`, async () => {
    const search = spyOn(hybrid, "hybridSearch").mockResolvedValue([]);
    try {
      const result = await runThink(db.storage, { question: question!, sonnetFn: model });
      const opts = search.mock.calls[0]![2]!;
      if (typeof opts === "number") throw new Error("Expected structured search options");
      expect([opts.since, opts.until]).toEqual([day, day]);
      expect((result as unknown as Record<string, unknown>).window_source).toBe(day ? "question" : undefined);
    } finally { search.mockRestore(); }
  });
  it("keeps explicit bounds and reports excerpt truncation", async () => {
    const search = spyOn(hybrid, "hybridSearch").mockResolvedValue([{
      chunkId: "chunk", documentId: "doc", sourcePath: "notes/long.md", title: "Long", content: "Evidence. ".repeat(1500), score: 1, intent: "topic",
    }]);
    try {
      const result = await runThink(db.storage, { question: "What happened 2026-02-28?", since: "2026-01-01", until: "2026-12-31", sonnetFn: model });
      expect(search.mock.calls[0]![2]).toMatchObject({ since: "2026-01-01", until: "2026-12-31" });
      expect(result).toMatchObject({ window_source: "explicit", evidence_truncated: true });
    } finally { search.mockRestore(); }
  });
  it("keeps the inferred day on graph evidence and reports graph excerpts", async () => {
    for (const [name, date] of [["matching", "2026-02-28"], ["later", "2026-03-01"], ["undated", undefined]]) {
      await putPage(db.storage, { slug: `notes/${name}`, markdown_body: `${name} evidence. `.repeat(200), compiled_truth: date ? { date } : {} });
    }
    let prompt = "";
    const result = await runThink(db.storage, { question: "What happened 2026-02-28?", anchors: ["notes/matching", "notes/later", "notes/undated"], pagesFn: async () => [], sonnetFn: async req => { prompt = req.user; return model(req); } });
    expect(prompt).toContain("matching evidence");
    expect(prompt).not.toContain("later evidence");
    expect(prompt).not.toContain("undated evidence");
    expect(result).toMatchObject({ pagesGathered: 1, window_source: "question", evidence_truncated: true });
  });

});
