/**
 * P5-C5: chat history does not pile up for ever, can be erased per owner and
 * leaves with a data export.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { purgePhase } from "../src/core/cycle/purge.ts";
import { appendChatMessage, createChatThread, listChatThreads, purgeOldChat, type ChatOwner } from "../src/core/chat/store.ts";
import { runErase } from "../src/commands/erase.ts";
import { runExport } from "../src/commands/export.ts";

let tmp: string;
let storage: Storage;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-chat-ret-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const owner = (key: string, sourceId = "default"): ChatOwner => ({ key, sourceId, spendId: `memrain_chat_${key}` });
const NOW = new Date("2026-11-18T12:00:00Z");

async function threadAged(o: ChatOwner, title: string, daysOld: number): Promise<string> {
  const e = storage.engine();
  const id = await createChatThread(e, o, title);
  await appendChatMessage(e, id, { role: "user", content: `${title}?` });
  await appendChatMessage(e, id, { role: "assistant", content: `${title}.`, status: "ok" });
  const at = new Date(NOW.getTime() - daysOld * 86_400_000).toISOString();
  await e.query(`UPDATE chat_messages SET created_at = $2 WHERE thread_id = $1::uuid`, [id, at]);
  await e.query(`UPDATE chat_threads SET created_at = $2, updated_at = $2 WHERE id = $1::uuid`, [id, at]);
  return id;
}

async function silently<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

describe("chat retention", () => {
  it("removes messages past the window and the threads they leave empty", async () => {
    const old = await threadAged(owner("operator"), "old", 91);
    const recent = await threadAged(owner("operator"), "recent", 89);
    const r = await purgeOldChat(storage.engine(), { days: 90, now: NOW });
    expect(r).toEqual({ messages: 2, threads: 1, capped: false });
    const left = (await listChatThreads(storage.engine(), owner("operator"))).map(t => t.id);
    expect(left).toEqual([recent]);
    expect(left).not.toContain(old);
    expect(await purgeOldChat(storage.engine(), { days: null, now: NOW })).toEqual({ messages: 0, threads: 0, capped: false });
  });

  it("does not keep a purged question alive in its thread's title", async () => {
    const e = storage.engine();
    const o = owner("operator");
    const id = await threadAged(o, "my salary is 90k, should I ask for more", 91);
    // A later turn in the same thread is still inside the window.
    await appendChatMessage(e, id, { role: "user", content: "what about a  bonus\ninstead?" });
    await appendChatMessage(e, id, { role: "assistant", content: "Maybe.", status: "ok" });
    const gone = await threadAged(o, "every turn of this one expires", 91);
    await e.query(`UPDATE chat_threads SET updated_at = $2 WHERE id = $1::uuid`, [gone, NOW.toISOString()]);
    await purgeOldChat(e, { days: 90, now: NOW });
    const titles = new Map((await listChatThreads(e, o)).map(t => [t.id, t.title]));
    expect(titles.get(id)).toBe("what about a bonus instead?");
    // A thread left with no question has no title to show.
    expect(titles.get(gone)).toBeNull();
  });

  it("runs in the purge phase under MEMRAIN_CHAT_RETENTION_DAYS (0 keeps everything)", async () => {
    await threadAged(owner("operator"), "ancient", 400);
    const saved = process.env["MEMRAIN_CHAT_RETENTION_DAYS"];
    try {
      process.env["MEMRAIN_CHAT_RETENTION_DAYS"] = "0";
      expect((await purgePhase(storage.engine())).purged_chat_messages).toBe(0);
      delete process.env["MEMRAIN_CHAT_RETENTION_DAYS"];
      expect((await purgePhase(storage.engine())).purged_chat_messages).toBe(2);
    } finally {
      if (saved === undefined) delete process.env["MEMRAIN_CHAT_RETENTION_DAYS"];
      else process.env["MEMRAIN_CHAT_RETENTION_DAYS"] = saved;
    }
  });
});

describe("chat erase and export", () => {
  it("erase chat previews, then removes one owner's threads only", async () => {
    await threadAged(owner("member-a"), "a1", 1);
    await threadAged(owner("member-a"), "a2", 1);
    await threadAged(owner("member-b"), "b1", 1);
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => out.push(s);
    try {
      expect(await runErase({ sub: "chat", owner: "member-a", source: "", storage })).toBe(0);
      expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, dry_run: true, owner: "member-a", threads: 2, messages: 4 });
      expect((await listChatThreads(storage.engine(), owner("member-a")))).toHaveLength(2);
      expect(await runErase({ sub: "chat", owner: "member-a", source: "", apply: true, storage })).toBe(0);
    } finally {
      console.log = log;
    }
    expect(await listChatThreads(storage.engine(), owner("member-a"))).toEqual([]);
    expect(await listChatThreads(storage.engine(), owner("member-b"))).toHaveLength(1);
    await expect(runErase({ sub: "chat", owner: "", source: "", storage })).rejects.toThrow();
  });

  it("export writes the threads of the asked owner and sources, nobody else's", async () => {
    await registerSource(storage.engine(), { id: "team", kind: "github", pathPrefix: "/team" });
    const mine = await threadAged(owner("member-a"), "mine", 1);
    await threadAged(owner("member-b"), "theirs", 1);
    await threadAged(owner("member-a", "team"), "team-thread", 1);
    const dir = join(tmp, "out");
    await silently(() => runExport({ dir, storage, chatOwner: "member-a", sourceIds: ["default"] }));
    const files = readdirSync(join(dir, "_chat"));
    expect(files).toEqual([`${mine}.json`]);
    const exported = JSON.parse(readFileSync(join(dir, "_chat", files[0]!), "utf8"));
    expect(exported).toMatchObject({ id: mine, owner_key: "member-a", title: "mine" });
    expect(exported.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
  });

  it("a source-scoped export leaves out the operator's threads, which read the whole brain", async () => {
    const op = await threadAged(owner("operator"), "whole brain", 1);
    const member = await threadAged(owner("member-a"), "mine", 1);
    const scoped = join(tmp, "scoped");
    await silently(() => runExport({ dir: scoped, storage, sourceIds: ["default"] }));
    expect(readdirSync(join(scoped, "_chat"))).toEqual([`${member}.json`]);
    const asked = join(tmp, "asked");
    await silently(() => runExport({ dir: asked, storage, chatOwner: "operator", sourceIds: ["default"] }));
    expect(readdirSync(join(asked, "_chat"))).toEqual([`${op}.json`]);
  });
});
