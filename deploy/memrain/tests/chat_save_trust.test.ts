/**
 * A chat answer saved as a page keeps the trust of the evidence it cites: an
 * answer resting on a synced Slack channel must not become owner text.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { readExternalTrust, readTrustTiers } from "../src/core/trust-frame.ts";
import { appendChatMessage, createChatThread, type ChatCitation, type ChatOwner } from "../src/core/chat/store.ts";
import { saveAnswerAsPage } from "../src/core/chat/save.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

const owner: ChatOwner = { key: "operator", sourceId: "default", spendId: "memrain_chat_operator" };

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`saving a chat answer keeps its evidence's trust (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  let storage: typeof db.storage;

  beforeAll(async () => {
    db = await open();
    storage = db.storage;
    await registerSource(storage.engine(), { id: "team-chat", kind: "chat", pathPrefix: "chat/" });
    await putPage(storage, { slug: "notes/vendor", markdown_body: "Vendor X is paid monthly.", title: "Vendor" });
    await putPage(storage, { slug: "chat/general/day", markdown_body: "Vendor X has a new bank account.", title: "general", source_id: "team-chat" });
  });
  afterAll(async () => {
    await db.close();
  });

  /** `evidenceTier` is what the turn recorded for everything it showed the model; owner unless a test says otherwise. */
  async function savedAnswer(question: string, answer: string, citations: ChatCitation[], evidenceTier: string | null = "owner"): Promise<string> {
    const engine = storage.engine();
    const thread = await createChatThread(engine, owner, question);
    await appendChatMessage(engine, thread, { role: "user", content: question });
    const id = await appendChatMessage(engine, thread, { role: "assistant", content: answer, status: "ok", citations, evidenceTier });
    const r = await saveAnswerAsPage(storage, owner, id);
    if (!r.ok) throw new Error(`save refused: ${r.error}`);
    return r.slug;
  }

  const tierOf = async (slug: string) => (await readTrustTiers(storage.engine(), { pages: [slug] })).pages.get(slug);

  it("an answer citing only owner pages stays owner text", async () => {
    const slug = await savedAnswer("how is vendor x paid?", "Monthly [1].", [{ n: 1, slug: "notes/vendor", title: "Vendor", kind: "page" }]);
    expect(await tierOf(slug)).toBe("owner");
  });

  it("an answer citing a chat-source page is saved below owner and framed on read", async () => {
    const slug = await savedAnswer("vendor x bank account?", "Vendor X has a new bank account [1].", [
      { n: 1, slug: "notes/vendor", title: "Vendor", kind: "page" },
      { n: 2, slug: "chat/general/day", title: "general", kind: "page" },
    ]);
    expect(await tierOf(slug)).toBe("external");
    expect((await readExternalTrust(storage.engine(), { pages: [slug] })).pages.has(slug)).toBe(true);
  });

  it("an answer citing a take distilled from chat text is saved below owner", async () => {
    await storage.engine().query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
       VALUES ('take-chat-1', 'chat/general/day', 'h1', 'v1', 'Vendor X changed banks', 'test')`,
    );
    const slug = await savedAnswer("did vendor x change banks?", "Yes [1].", [{ n: 1, slug: "take-chat-1", title: "Vendor X changed banks", kind: "take" }]);
    expect(await tierOf(slug)).toBe("external");
  });

  it("an in-process writer can cap the tier in the write itself; an MCP argument cannot", async () => {
    const put = async (slug: string, opts: Parameters<typeof dispatchTool>[2], extra: Record<string, unknown> = {}) => {
      const r = await dispatchTool(storage, { name: "page_put", arguments: { slug, markdown_body: "Body.", expected_version: 0, ...extra } }, opts);
      expect(r.isError).toBeFalsy();
    };
    await put("notes/capped", { trustCeiling: "external" });
    expect(await tierOf("notes/capped")).toBe("external");
    await putPage(storage, { slug: "notes/capped", markdown_body: "An owner edit.", title: "capped" });
    expect(await tierOf("notes/capped")).toBe("external");
    await dispatchTool(storage, { name: "page_put", arguments: { slug: "notes/uncapped", markdown_body: "Body.", expected_version: 0, trust_tier: "external" } });
    expect(await tierOf("notes/uncapped")).not.toBe("external");
  });

  it("a cited slug that also names another source's page counts that page too", async () => {
    // page://team-chat/chat/general/day is both the team-chat page chat/general/day and
    // a default page slugged team-chat/chat/general/day: the less trusted one decides.
    await putPage(storage, { slug: "team-chat/chat/general/day", markdown_body: "An owner page.", title: "owner copy" });
    const slug = await savedAnswer("vendor x account again?", "It changed [1].", [{ n: 1, slug: "team-chat/chat/general/day", title: "owner copy", kind: "page" }]);
    expect(await tierOf(slug)).toBe("external");
  });

  it("evidence the model was shown but the answer does not cite still lowers the saved tier", async () => {
    const slug = await savedAnswer("vendor x payment?", "Monthly [1].", [{ n: 1, slug: "notes/vendor", title: "Vendor", kind: "page" }], "external");
    expect(await tierOf(slug)).toBe("external");
  });

  it("an answer stored before its evidence was recorded is not vouched for", async () => {
    const slug = await savedAnswer("vendor x payment, older?", "Monthly [1].", [{ n: 1, slug: "notes/vendor", title: "Vendor", kind: "page" }], null);
    expect(await tierOf(slug)).toBe("external");
  });

  it("evidence that can no longer be found is not vouched for", async () => {
    const slug = await savedAnswer("what about the gone page?", "It said so [1].", [{ n: 1, slug: "notes/gone", title: "gone", kind: "page" }]);
    expect(await tierOf(slug)).not.toBe("owner");
  });
});
