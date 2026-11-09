import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { conversationFactsBackfillPhase } from "../src/core/cycle/conversation-facts-backfill.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

const BODY = "Alice plans to deliver the Paris project next spring and confirmed the agreed budget today. ".repeat(2);
for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`fact backfill holds ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("parks unreadable input before LIMIT, reopens edits, and clears a clean retry", async () => {
    await putPage(db.storage, { slug: "notes/good-held-test", markdown_body: BODY });
    await putPage(db.storage, { slug: "notes/bad-held-test", markdown_body: `${BODY} BAD_PAYLOAD` });
    await db.storage.engine().query("UPDATE pages SET updated_at = now() + interval '1 hour' WHERE slug = 'notes/bad-held-test'");
    let calls = 0;
    let bad = true;
    const sonnetFn: SonnetFn = async input => {
      calls++;
      return { text: bad && input.user.includes("BAD_PAYLOAD") ? "broken response" : '{"facts":[]}', modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 10 } };
    };
    const run = () => conversationFactsBackfillPhase(db.storage, { sonnetFn, maxPages: 1 });
    expect((await run()).errors).toHaveLength(1);
    expect((await run()).zeroYieldRecorded).toBe(1);
    expect(calls).toBe(2);
    await run(); expect(calls).toBe(2);
    const holds = () => db.storage.engine().query<{ attempts: number; kind: string }>("SELECT attempts, kind FROM synth_failures WHERE phase = 'facts-backfill'");
    expect((await holds()).rows).toEqual([{ attempts: 1, kind: "unparseable" }]);
    await putPage(db.storage, { slug: "notes/bad-held-test", markdown_body: `${BODY} BAD_PAYLOAD changed` });
    await run(); expect(calls).toBe(3);
    expect((await holds()).rows).toEqual([{ attempts: 1, kind: "unparseable" }]);
    await db.storage.engine().query("UPDATE synth_failures SET next_eligible_at = now() - interval '1 second' WHERE phase = 'facts-backfill'");
    bad = false;
    expect((await run()).zeroYieldRecorded).toBe(1);
    expect((await holds()).rows).toEqual([]);
    await run(); expect(calls).toBe(4);
  });
  it("holds truncated output but retries transient model failures", async () => {
    for (const mode of ["truncated", "transient"] as const) {
      const slug = `notes/${mode}`;
      await putPage(db.storage, { slug, markdown_body: BODY });
      let calls = 0;
      const sonnetFn: SonnetFn = async () => {
        calls++;
        if (mode === "transient") throw new Error("503 Service Unavailable");
        return { text: '{"facts":[]}', stopReason: "max_tokens", modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 10 } };
      };
      await conversationFactsBackfillPhase(db.storage, { sonnetFn });
      const first = calls;
      expect(first).toBeGreaterThan(0);
      await conversationFactsBackfillPhase(db.storage, { sonnetFn });
      expect(calls).toBe(mode === "truncated" ? first : first * 2);
      const holds = await db.storage.engine().query<{ kind: string }>("SELECT kind FROM synth_failures WHERE phase = 'facts-backfill' AND doc_id = $1", [`page://${slug}`]);
      expect(holds.rows).toEqual(mode === "truncated" ? [{ kind: "truncated" }] : []);
    }
  });
});
