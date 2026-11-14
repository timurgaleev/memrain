/**
 * Connector pages stay out of the paid phases that predate connectors.
 *
 * Mail, calendar, chat and meeting text is extracted only by the connector
 * pipeline's own extractor, under its own caps. Locks, on both engines: with
 * MEMRAIN_FACTS_EXTRACTION=1 the conversation-facts backfill never selects a
 * connector page, whether it is known by its type or by the connector item
 * that wrote it; the on-write extraction gate refuses a connector page type;
 * and the contextual-LLM tier never runs over a connector page's chunks.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { createAccount } from "../src/core/connectors/accounts.ts";
import { conversationFactsBackfillPhase } from "../src/core/cycle/conversation-facts-backfill.ts";
import { isFactsExtractionEligible } from "../src/core/facts-extract.ts";
import { isConnectorPageType } from "../src/core/connectors/page-kind.ts";
import { mirrorPage } from "../src/core/page-index.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";
import { deterministicEmbed } from "./det-embed.ts";

const BODY = "Alice told Bob on Monday that the migration to the new billing system is planned for March, with Carol owning it.";
const embedFn = async (text: string) => deterministicEmbed(text);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector pages and paid phases (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeEach(async () => {
    process.env.MEMRAIN_FACTS_EXTRACTION = "1";
    db = await open();
  });
  afterEach(async () => {
    delete process.env.MEMRAIN_FACTS_EXTRACTION;
    await db.close();
  });

  it("the facts backfill skips connector pages and still mines the rest", async () => {
    const e = db.storage.engine();
    await registerSource(e, { id: "mail-src", kind: "mailbox", pathPrefix: "mail/" });
    const acct = await createAccount(e, { sourceId: "mail-src", provider: "test", services: ["items"], principalRef: "admin:test", accountLabel: "a@test" });
    // An eligible type written by a connector run: known by its item row.
    await putPage(db.storage, { slug: "mail/thread-1", type: "note", title: "t", markdown_body: BODY, source_id: "mail-src" });
    await e.query(`INSERT INTO connector_items (account_id, external_id, page_slug) VALUES ($1, 'x1', 'mail/thread-1')`, [acct.id]);
    // A connector page type, eligible or not, is never mined.
    await putPage(db.storage, { slug: "mail/thread-2", type: "connector-mail", allowAdHocType: true, title: "t", markdown_body: BODY, source_id: "mail-src" });
    await putPage(db.storage, { slug: "notes/mine", type: "note", title: "m", markdown_body: BODY });

    const asked: string[] = [];
    const sonnetFn: SonnetFn = async (input) => {
      asked.push(input.user);
      return { text: JSON.stringify({ facts: [] }), modelId: "eu.anthropic.claude-sonnet-4-5-v1:0", usage: { inputTokens: 10, outputTokens: 2 } };
    };
    const r = await conversationFactsBackfillPhase(db.storage, { sonnetFn });
    expect(r.pagesConsidered).toBe(1);
    expect(r.pagesProcessed).toBe(1);
    expect(asked.every((u) => !u.includes("mail/thread"))).toBe(true);
  });

  it("the on-write gate refuses a connector page type", () => {
    expect(isConnectorPageType("connector-meeting")).toBe(true);
    expect(isConnectorPageType("meeting")).toBe(false);
    expect(isFactsExtractionEligible("connector-meeting", BODY).ok).toBe(false);
    expect(isFactsExtractionEligible("meeting", BODY).ok).toBe(true);
  });

  it("the contextual-LLM tier never runs over a connector page", async () => {
    const e = db.storage.engine();
    await registerSource(e, { id: "cal-src", kind: "calendar", pathPrefix: "cal/" });
    let calls = 0;
    const contextualLlmFn: LlmFn = async () => {
      calls++;
      return { text: "context", usage: { inputTokens: 1, outputTokens: 1 } } as Awaited<ReturnType<LlmFn>>;
    };
    const conn = await putPage(db.storage, { slug: "cal/event-1", type: "connector-calendar", allowAdHocType: true, title: "e", markdown_body: BODY, source_id: "cal-src" });
    expect(await mirrorPage(db.storage, { slug: "cal/event-1", title: "e", markdown_body: BODY, content_hash: conn.content_hash, source_id: "cal-src" },
      { remote: true, embedFn, contextualLlmFn })).toBe(true);
    expect(calls).toBe(0);
    const mine = await putPage(db.storage, { slug: "notes/own", type: "note", title: "o", markdown_body: BODY });
    expect(await mirrorPage(db.storage, { slug: "notes/own", title: "o", markdown_body: BODY, content_hash: mine.content_hash },
      { remote: true, embedFn, contextualLlmFn })).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });
});
