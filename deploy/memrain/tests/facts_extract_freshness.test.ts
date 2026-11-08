import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { deletePage, getPage, putPage } from "../src/core/pages.ts";
import * as extraction from "../src/core/facts-extract.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { getFactsQueue } from "../src/core/facts-queue.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { checkFactsInputWindows } from "../src/core/doctor-ops.ts";

const BODY = "Alice prefers tea and has worked on the Paris project since March. ".repeat(3);
for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`extraction freshness ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  for (const state of ["missing", "deleted", "stale", "live"] as const) it(`checks ${state} page before paying`, async () => {
    const slug = `notes/freshness-${state}`;
    if (state !== "missing") await putPage(db.storage, { slug, markdown_body: state === "stale" ? `${BODY} Updated.` : BODY });
    if (state === "deleted") await deletePage(db.storage, slug);
    let calls = 0;
    const sonnetFn: SonnetFn = async () => {
      calls++;
      return { text: '{"facts":[]}', modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 10 } };
    };
    const result = await extraction.extractFactsForPage(db.storage, { slug, type: "note", body: BODY, sonnetFn });
    expect(calls).toBe(state === "live" ? 1 : 0);
    expect(result.spentUsd > 0).toBe(state === "live");
  });
  it("does not persist a model answer after its source changed", async () => {
    const slug = "notes/changes-during-model";
    await putPage(db.storage, { slug, markdown_body: BODY });
    const result = await extraction.extractFactsForPage(db.storage, { slug, type: "note", body: BODY, sonnetFn: async () => {
      await putPage(db.storage, { slug, markdown_body: `${BODY} Correction.` });
      return { text: '{"facts":[{"entity":"people/alice","fact":"Alice prefers tea","kind":"preference"}]}', modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 20 } };
    } });
    expect(result.spentUsd).toBeGreaterThan(0);
    expect(result.factsWritten).toBe(0);
    expect((await db.storage.engine().query("SELECT id FROM entity_facts WHERE source_slug = $1", [slug])).rows).toHaveLength(0);
  });
  it("queues only the stored append and 500 preceding characters", async () => {
    const slug = "notes/append-tail";
    const old = `OLD_START ${BODY.repeat(100)} CONTEXT_END`;
    await putPage(db.storage, { slug, markdown_body: old });
    const saved = process.env.MEMRAIN_FACTS_EXTRACTION;
    const savedMirror = process.env.MEMRAIN_PAGE_MIRROR_SYNC;
    process.env.MEMRAIN_FACTS_EXTRACTION = "1";
    process.env.MEMRAIN_PAGE_MIRROR_SYNC = "0";
    const jobs: Array<() => Promise<void>> = [];
    const queue = spyOn(getFactsQueue(), "enqueue").mockImplementation(job => jobs.push(job));
    let seen: extraction.ExtractForPageOptions | undefined;
    const extract = spyOn(extraction, "extractFactsForPage").mockImplementation(async (_storage, opts) => {
      seen = opts;
      return { factsWritten: 0, factsSkipped: 0, factsFailed: 0, spentUsd: 0, absorbed: null, windowsRun: 0, junkSkipped: 0, truncated_chars: 0 };
    });
    try {
      const result = await dispatchTool(db.storage, { name: "page_append", arguments: { slug, content: "NEW_TAIL Alice will relocate to Rome next spring." } });
      expect(result.isError).toBeFalsy();
      expect(jobs).toHaveLength(1);
      await jobs[0]!();
      const page = (await getPage(db.storage, slug))!;
      expect(seen!.body).toBe(page.markdown_body.slice(old.length - 500));
      expect(seen!.body).toContain("NEW_TAIL");
      expect(seen!.body).not.toContain("OLD_START");
      expect(seen!.expectedContentHash).toBe(page.content_hash);
      const diagnostic = await checkFactsInputWindows(db.storage.engine());
      expect(diagnostic).toMatchObject({ ok: true, status: "ok" });
      expect(diagnostic.detail).toContain("1 live page(s)");
      expect(diagnostic.detail).toContain(`${page.markdown_body.length} characters total`);
    } finally {
      queue.mockRestore(); extract.mockRestore();
      if (saved === undefined) delete process.env.MEMRAIN_FACTS_EXTRACTION; else process.env.MEMRAIN_FACTS_EXTRACTION = saved;
      if (savedMirror === undefined) delete process.env.MEMRAIN_PAGE_MIRROR_SYNC; else process.env.MEMRAIN_PAGE_MIRROR_SYNC = savedMirror;
    }
  });
});
