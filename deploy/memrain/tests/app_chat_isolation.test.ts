/**
 * Gate 6: two members never see each other's threads, and a member's chat
 * reads and writes only under the member's own grant.
 *
 *   - a thread of member A is "not found" to member B: read, delete, list;
 *   - a member whose id is `operator` does not see the operator's threads,
 *     and an operator cookie does not open /app as anyone;
 *   - a saved answer lands in the member's personal source at tier member,
 *     never over another source's page of the same name;
 *   - an answer cites only pages from the member's read set;
 *   - a member without a personal source gets `member_not_ready`.
 *
 * The model is a stub; nothing is spent.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { registerSource } from "../src/core/sources.ts";
import { addMember, type MemberActor } from "../src/core/members.ts";
import { APP_COOKIE, createMemberSession } from "../src/core/member-sessions.ts";
import { createChatThread } from "../src/core/chat/store.ts";
import { operatorOwner } from "../src/core/chat/chat-service.ts";
import { readTrustTiers } from "../src/core/trust-frame.ts";
import { handleApp } from "../src/http/app.ts";
import { RateLimiter } from "../src/mcp/rate_limit.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";

setDefaultTimeout(60_000);

const ORIGIN = "https://acme.example.test";
const MODEL = "eu.anthropic.claude-haiku-5-5";
const OPS: MemberActor = { actor: "ops", via: "cli" };
const ENV_KEYS = ["MEMRAIN_APP", "MEMRAIN_CHAT", "MEMRAIN_DAILY_BUDGET_USD", "MEMRAIN_CHAT_MODELS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

let tmp: string;
let storage: Storage;
const cookies = new Map<string, string>();

/** Cites every page ref it was shown, plus the team page it was never shown. */
const model: SonnetFn = async (input) => {
  const text = JSON.stringify(input);
  const shown = [...new Set(text.match(/page:\/\/[\w./-]+/g) ?? [])];
  const refs = [...shown, "page://team-x/notes/team-garden"];
  return {
    text: JSON.stringify({
      answer: `Tomatoes go in the north bed ${refs.map(r => `[${r}]`).join(" ")}.`,
      citations: refs.map(ref => ({ ref, kind: "page" })),
      gaps: [],
    }),
    modelId: MODEL,
    usage: { inputTokens: 800, outputTokens: 100 },
  };
};

async function page(slug: string, body: string, source: string): Promise<void> {
  await putPage(storage, { slug, markdown_body: body, title: slug, source_id: source });
  await indexPageIntoSearch(storage, { slug, markdown_body: body, title: slug, source_id: source } as never, { embedFn: deterministicEmbedQuery });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-app-chat-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  for (const id of ["alice", "bob", "operator"]) {
    await registerSource(e, { id: `person-${id}`, kind: "other", pathPrefix: `/person-${id}` });
    await addMember(e, id, { personalSource: `person-${id}` }, OPS);
    cookies.set(id, (await createMemberSession(e, id, "passkey")).id);
  }
  await addMember(e, "dana", {}, OPS);
  cookies.set("dana", (await createMemberSession(e, "dana", "passkey")).id);
  await registerSource(e, { id: "team-x", kind: "other", pathPrefix: "/team-x" });
  await page("notes/alice-garden", "Alice's garden plan: tomatoes go in the north bed.", "person-alice");
  await page("notes/team-garden", "The team garden plan: tomatoes go in the south bed.", "team-x");
});
afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  process.env["MEMRAIN_APP"] = "1";
  process.env["MEMRAIN_CHAT"] = "1";
  process.env["MEMRAIN_DAILY_BUDGET_USD"] = "5";
  delete process.env["MEMRAIN_CHAT_MODELS"];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function call(member: string | null, method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN };
  const c = cookie ?? (member ? `${APP_COOKIE}=${cookies.get(member)}` : undefined);
  if (c) headers.cookie = c;
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await handleApp(req, new URL(req.url), {
    storage, publicUrl: ORIGIN, chatModel: model, embedQuery: deterministicEmbedQuery, sendLimiter: new RateLimiter({ capacity: 5, refillPerSecond: 0 }),
  });
  if (!res) throw new Error(`not handled: ${path}`);
  return res;
}

async function ask(member: string, message: string): Promise<{ thread_id: string; message_id: number; status: string; citations: Array<{ slug: string }> }> {
  const res = await call(member, "POST", "/app/api/chat", { message });
  expect(res.status).toBe(200);
  const text = await res.text();
  const answer = text.split("\n\n").find(b => b.startsWith("event: answer"));
  if (!answer) throw new Error(`no answer in: ${text.slice(0, 400)}`);
  return JSON.parse(answer.split("\n").slice(1).join("\n").slice("data: ".length));
}

describe("gate 6: members do not see each other's threads", () => {
  it("a thread of A is not found for B: read, delete and list", async () => {
    const a = await ask("alice", "Where do the tomatoes go?");
    expect((await call("bob", "GET", `/app/api/chat/threads/${a.thread_id}`)).status).toBe(404);
    expect((await call("bob", "DELETE", `/app/api/chat/threads/${a.thread_id}`)).status).toBe(404);
    expect(((await (await call("bob", "GET", "/app/api/chat/threads")).json()) as { threads: unknown[] }).threads).toEqual([]);
    expect((await call("bob", "POST", `/app/api/chat/messages/${a.message_id}/save`)).status).toBe(404);
    // Still there for its owner.
    expect((await call("alice", "GET", `/app/api/chat/threads/${a.thread_id}`)).status).toBe(200);
  });

  it("a member named operator does not see the operator's threads", async () => {
    const opThread = await createChatThread(storage.engine(), operatorOwner(), "the operator's own question");
    const list = (await (await call("operator", "GET", "/app/api/chat/threads")).json()) as { threads: Array<{ id: string }> };
    expect(list.threads.map(t => t.id)).not.toContain(opThread);
    expect((await call("operator", "GET", `/app/api/chat/threads/${opThread}`)).status).toBe(404);
  });

  it("an admin cookie does not open /app as anyone", async () => {
    const res = await call(null, "GET", "/app/api/chat/threads", undefined, "memrain_admin=whatever");
    expect(res.status).toBe(401);
  });
});

describe("a member's grant in chat", () => {
  it("cites only pages from the member's read set", async () => {
    const a = await ask("alice", "Where do the tomatoes go in the garden plan?");
    expect(a.status).toBe("ok");
    const slugs = a.citations.map(c => c.slug);
    expect(slugs).toContain("notes/alice-garden");
    expect(slugs).not.toContain("notes/team-garden");
  });

  it("saves an answer into the personal source at tier member, never over another source's page", async () => {
    const a = await ask("alice", "garden tomatoes north bed");
    // Squat the slug the save would take first, in another source.
    const day = new Date().toISOString().slice(0, 10);
    await putPage(storage, { slug: `chats/${day}-garden-tomatoes-north-bed`, markdown_body: "Not Alice's.", title: "squat", source_id: "team-x" });
    const res = await call("alice", "POST", `/app/api/chat/messages/${a.message_id}/save`);
    expect(res.status).toBe(200);
    const { slug } = (await res.json()) as { slug: string };
    expect(slug).not.toBe(`chats/${day}-garden-tomatoes-north-bed`);
    const row = await storage.engine().query<{ source_id: string }>(`SELECT source_id FROM pages WHERE slug = $1`, [slug]);
    expect(row.rows[0]?.source_id).toBe("person-alice");
    expect((await readTrustTiers(storage.engine(), { pages: [slug] })).pages.get(slug)).toBe("member");
    const squat = await storage.engine().query<{ markdown_body: string; source_id: string }>(
      `SELECT markdown_body, source_id FROM pages WHERE slug = $1`, [`chats/${day}-garden-tomatoes-north-bed`],
    );
    expect(squat.rows[0]).toEqual({ markdown_body: "Not Alice's.", source_id: "team-x" });
  });

  it("a member without a personal source is not ready for chat", async () => {
    const res = await call("dana", "POST", "/app/api/chat", { message: "hello?" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "member_not_ready" });
    expect(((await (await call("dana", "GET", "/app/api/me")).json()) as { ready: boolean }).ready).toBe(false);
  });
});
