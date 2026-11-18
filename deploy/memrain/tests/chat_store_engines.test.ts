/**
 * The chat store's SQL on both engines: owner-keyed reads, messages with
 * their JSON fields, retention, erase and export.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import {
  appendChatMessage,
  confirmAnswer,
  createChatThread,
  deleteChatThread,
  eraseOwnerChat,
  exportChatThreads,
  getChatThread,
  listChatThreads,
  ownedAnswer,
  purgeOldChat,
  recentTurns,
  setSavedSlug,
  threadMessages,
  type ChatOwner,
} from "../src/core/chat/store.ts";

setDefaultTimeout(60_000);

const owner = (key: string): ChatOwner => ({ key, sourceId: "default", spendId: `memrain_chat_${key}` });

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`chat store (${name})`, () => {
  it("keeps each owner's threads apart and round-trips a message", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const a = owner("a");
      const id = await createChatThread(e, a, "Garden");
      await appendChatMessage(e, id, { role: "user", content: "where?" });
      const answerId = await appendChatMessage(e, id, {
        role: "assistant", content: "North bed [1].", status: "ok", model: "m", costUsd: 0.0012, inputTokens: 10, outputTokens: 5,
        citations: [{ n: 1, slug: "notes/garden", title: "Garden", kind: "page" }], gaps: ["harvest date"], trace: [{ step: "intent", note: "other" }],
      });
      const msgs = (await threadMessages(e, a, id))!;
      expect(msgs[1]).toMatchObject({ id: answerId, status: "ok", cost_usd: 0.0012, citations: [{ n: 1, slug: "notes/garden" }], gaps: ["harvest date"], trace: [{ step: "intent" }], saved_slug: null });
      expect(typeof msgs[1]!.created_at).toBe("string");
      expect(await recentTurns(e, id, 6)).toEqual([{ role: "user", content: "where?" }, { role: "assistant", content: "North bed [1]." }]);
      expect((await ownedAnswer(e, a, answerId))?.question).toBe("where?");
      expect(await ownedAnswer(e, owner("b"), answerId)).toBeNull();
      const refused = await appendChatMessage(e, id, { role: "assistant", content: "Made up, cites nothing.", status: "refused" });
      expect(await recentTurns(e, id, 6)).toEqual([{ role: "user", content: "where?" }, { role: "assistant", content: "North bed [1]." }]);
      await e.query(`DELETE FROM chat_messages WHERE id = $1`, [refused]);
      const second = await appendChatMessage(e, id, { role: "assistant", content: "Unconfirmed.", status: "error" });
      await confirmAnswer(e, second);
      expect((await threadMessages(e, a, id))!.map(m => m.status)).toEqual([null, "ok", "ok"]);
      await e.query(`DELETE FROM chat_messages WHERE id = $1`, [second]);
      await setSavedSlug(e, answerId, "chats/x");
      expect((await threadMessages(e, a, id))![1]!.saved_slug).toBe("chats/x");
      expect(await getChatThread(e, owner("b"), id)).toBeNull();
      expect((await listChatThreads(e, a))[0]).toMatchObject({ id, title: "Garden", message_count: 2 });
      expect(await deleteChatThread(e, owner("b"), id)).toBe(false);
      expect((await exportChatThreads(e, { ownerKey: "a" }))[0]!.messages).toHaveLength(2);
      expect(await eraseOwnerChat(e, "a", false)).toEqual({ threads: 1, messages: 2 });
      await e.query(`UPDATE chat_messages SET created_at = NOW() - interval '100 days'`);
      await e.query(`UPDATE chat_threads SET updated_at = NOW() - interval '100 days'`);
      expect(await purgeOldChat(e, { days: 90 })).toEqual({ messages: 2, threads: 1, capped: false });
      expect(await eraseOwnerChat(e, "a", true)).toEqual({ threads: 0, messages: 0 });
    } finally { await db.close(); }
  });

  it("retention retitles a thread whose first question expired, or clears its title", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const a = owner("a");
      const kept = await createChatThread(e, a, "Expired question");
      const emptied = await createChatThread(e, a, "Also expired");
      await appendChatMessage(e, kept, { role: "user", content: "Expired question" });
      await appendChatMessage(e, emptied, { role: "user", content: "Also expired" });
      await e.query(`UPDATE chat_messages SET created_at = NOW() - interval '100 days'`);
      await appendChatMessage(e, kept, { role: "user", content: "Later question" });
      expect(await purgeOldChat(e, { days: 90 })).toMatchObject({ messages: 2 });
      const titles = new Map((await listChatThreads(e, a)).map(t => [t.id, t.title]));
      expect(titles.get(kept)).toBe("Later question");
      expect(titles.get(emptied)).toBeNull();
    } finally { await db.close(); }
  });
});
