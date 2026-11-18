/**
 * The admin chat HTTP surface, behind handleAdminApi's admin-session and
 * same-origin gates: the streamed turn, threads, models and save-as-page.
 * The model is a stub (AdminApiDeps.chatModel); nothing is spent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { handleAdminApi, type AdminApiDeps } from "../src/http/admin-api.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";

setDefaultTimeout(60_000);

const ORIGIN = "https://brain.example.test";
const MODEL = "eu.anthropic.claude-haiku-5-5";
const ENV_KEYS = ["MEMRAIN_CHAT", "MEMRAIN_DAILY_BUDGET_USD", "MEMRAIN_CHAT_MODELS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
function chatOn(): void {
  process.env["MEMRAIN_CHAT"] = "1";
  process.env["MEMRAIN_DAILY_BUDGET_USD"] = "5";
  delete process.env["MEMRAIN_CHAT_MODELS"];
}
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let tmp: string;
let storage: Storage;
let reply = (): string => JSON.stringify({ answer: "Tomatoes go in the north bed [page://notes/garden].", citations: [{ ref: "page://notes/garden", kind: "page" }], gaps: ["no harvest date"] });
let calls = 0;
const model: SonnetFn = async () => { calls++; return { text: reply(), modelId: MODEL, usage: { inputTokens: 800, outputTokens: 100 } }; };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-chat-api-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const body = "The garden plan: tomatoes go in the north bed.";
  await putPage(storage, { slug: "notes/garden", markdown_body: body, title: "Garden plan" });
  await indexPageIntoSearch(storage, { slug: "notes/garden", markdown_body: body, title: "Garden plan" }, { embedFn: deterministicEmbedQuery });
});
afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function deps(extra: Partial<AdminApiDeps> = {}): AdminApiDeps {
  return { storage, publicUrl: ORIGIN, requireAdmin: () => true, sessionCooldown: () => null, chatModel: model, embedQuery: deterministicEmbedQuery, ...extra };
}
const req = (method: string, path: string, body?: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
async function call(r: Request, d = deps()): Promise<Response> {
  const res = await handleAdminApi(r, new URL(r.url), d);
  if (!res) throw new Error(`not handled: ${r.method} ${r.url}`);
  return res;
}

/** Parse an SSE body into its events. */
async function events(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await res.text();
  return text.split("\n\n").filter(b => b.startsWith("event:")).map(block => {
    const [ev, ...rest] = block.split("\n");
    return { event: ev!.slice("event: ".length), data: JSON.parse(rest.join("\n").slice("data: ".length)) };
  });
}

describe("admin chat API", () => {
  it("refuses a caller without an admin session and a cross-origin send", async () => {
    chatOn();
    expect((await call(req("GET", "/admin/api/chat/threads"), deps({ requireAdmin: () => false }))).status).toBe(401);
    expect((await call(req("POST", "/admin/api/chat", { message: "hi" }, "https://evil.example.test"))).status).toBe(403);
  });

  it("lists the models with prices, the cap and the switch", async () => {
    chatOn();
    const off = await (await call(req("GET", "/admin/api/chat/models"))).json() as Record<string, unknown>;
    expect(off).toMatchObject({ enabled: true, default: MODEL, answer_cap_usd: 0.02 });
    expect((off.models as Array<Record<string, unknown>>)[0]).toMatchObject({ id: MODEL, label: "Claude Haiku 5.5", input_usd_per_m: 0.11, output_usd_per_m: 0.55 });
    delete process.env["MEMRAIN_CHAT"];
    expect(await (await call(req("GET", "/admin/api/chat/models"))).json()).toMatchObject({ enabled: false });
  });

  it("streams trace events, the answer and done; the thread and its messages read back", async () => {
    chatOn();
    const res = await call(req("POST", "/admin/api/chat", { message: "where do the tomatoes go?" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const evs = await events(res);
    expect(evs.at(-1)).toEqual({ event: "done", data: {} });
    const answer = evs.at(-2)!;
    expect(answer.event).toBe("answer");
    expect(answer.data).toMatchObject({ status: "ok", model: MODEL, citations: [{ n: 1, slug: "notes/garden", title: "Garden plan", kind: "page" }], gaps: ["no harvest date"] });
    expect(String(answer.data.answer)).toContain("[1]");
    expect(evs.slice(0, -2).every(e => e.event === "trace")).toBe(true);

    const threadId = String(answer.data.thread_id);
    const list = await (await call(req("GET", "/admin/api/chat/threads"))).json() as { threads: Array<Record<string, unknown>> };
    expect(list.threads.find(t => t.id === threadId)).toMatchObject({ title: "where do the tomatoes go?", message_count: 2 });
    const one = await (await call(req("GET", `/admin/api/chat/threads/${threadId}`))).json() as { thread: Record<string, unknown>; messages: Array<Record<string, unknown>> };
    expect(one.thread.id).toBe(threadId);
    expect(one.messages.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(Object.keys(one.messages[1]!).sort()).toEqual(
      ["citations", "content", "cost_usd", "created_at", "gaps", "id", "model", "role", "saved_slug", "status", "trace"]);
    expect((one.messages[1]!.trace as unknown[]).length).toBeGreaterThan(0);
  });

  it("an unknown or foreign thread id is 404, and a deleted thread is gone", async () => {
    chatOn();
    expect((await call(req("GET", "/admin/api/chat/threads/0f0f0f0f-0000-4000-8000-00000000dead"))).status).toBe(404);
    expect((await call(req("GET", "/admin/api/chat/threads/not-a-uuid"))).status).toBe(404);
    const evs = await events(await call(req("POST", "/admin/api/chat", { message: "where do the tomatoes go?" })));
    const id = String(evs.at(-2)!.data.thread_id);
    expect(await (await call(req("DELETE", `/admin/api/chat/threads/${id}`))).json()).toEqual({ ok: true });
    expect((await call(req("GET", `/admin/api/chat/threads/${id}`))).status).toBe(404);
    expect((await call(req("DELETE", `/admin/api/chat/threads/${id}`))).status).toBe(404);
  });

  it("an invalid send is a 400 carrying an invalid_params error event; no model is called", async () => {
    chatOn();
    const before = calls;
    for (const body of [{ message: "" }, { message: "hi", model: "vendor.unpriced-v1" }, { message: "hi", thread_id: "0f0f0f0f-0000-4000-8000-00000000dead" }, { message: 7 }]) {
      const res = await call(req("POST", "/admin/api/chat", body));
      expect(res.status).toBe(400);
      const evs = await events(res);
      expect(evs[0]).toMatchObject({ event: "error", data: { code: "invalid_params" } });
      expect(evs.at(-1)!.event).toBe("done");
    }
    expect(calls).toBe(before);
  });

  it("with chat off the answer says disabled and no model is called", async () => {
    const before = calls;
    const evs = await events(await call(req("POST", "/admin/api/chat", { message: "where do the tomatoes go?" })));
    expect(evs.at(-2)).toMatchObject({ event: "answer", data: { status: "disabled", code: "chat_disabled" } });
    expect(calls).toBe(before);
  });

  it("saves an answer as a page through the normal write path, once", async () => {
    chatOn();
    const evs = await events(await call(req("POST", "/admin/api/chat", { message: "Where do the tomatoes go?" })));
    const messageId = evs.at(-2)!.data.message_id;
    const res = await call(req("POST", `/admin/api/chat/messages/${messageId}/save`, {}));
    expect(res.status).toBe(200);
    const { slug } = await res.json() as { slug: string };
    expect(slug).toMatch(/^chats\/\d{4}-\d{2}-\d{2}-where-do-the-tomatoes-go$/);
    const page = await getPage(storage, slug);
    expect(page?.markdown_body).toContain("Tomatoes go in the north bed [1]");
    expect(page?.markdown_body).toContain("[[notes/garden|Garden plan]]");
    expect(await (await call(req("POST", `/admin/api/chat/messages/${messageId}/save`, {}))).json()).toEqual({ slug });
    const thread = await (await call(req("GET", `/admin/api/chat/threads/${evs.at(-2)!.data.thread_id}`))).json() as { messages: Array<{ saved_slug: string | null }> };
    expect(thread.messages[1]!.saved_slug).toBe(slug);
    expect((await call(req("POST", "/admin/api/chat/messages/999999/save", {}))).status).toBe(404);
  });

  it("saves through the secret scanner: redacted by default, refused under reject", async () => {
    chatOn();
    const key = ["AK", "IA", "QWERTYUIOPASDFGH"].join("");
    const old = reply;
    const oldDisposition = process.env["MEMRAIN_SECRET_SCAN_DISPOSITION"];
    reply = () => JSON.stringify({ answer: `The key is ${key} [page://notes/garden].`, citations: [{ ref: "page://notes/garden", kind: "page" }], gaps: [] });
    try {
      const first = await events(await call(req("POST", "/admin/api/chat", { message: "which key?" })));
      const redacted = await call(req("POST", `/admin/api/chat/messages/${first.at(-2)!.data.message_id}/save`, {}));
      expect(redacted.status).toBe(200);
      const page = await getPage(storage, ((await redacted.json()) as { slug: string }).slug);
      expect(page?.markdown_body).not.toContain(key);

      process.env["MEMRAIN_SECRET_SCAN_DISPOSITION"] = "reject";
      const second = await events(await call(req("POST", "/admin/api/chat", { message: "which key again?" })));
      const res = await call(req("POST", `/admin/api/chat/messages/${second.at(-2)!.data.message_id}/save`, {}));
      expect(res.status).toBe(422);
      const body = await res.json() as { error: string; message?: string };
      expect(body.error).not.toBe("internal error");
      expect(JSON.stringify(body)).not.toContain(key);
    } finally {
      reply = old;
      if (oldDisposition === undefined) delete process.env["MEMRAIN_SECRET_SCAN_DISPOSITION"];
      else process.env["MEMRAIN_SECRET_SCAN_DISPOSITION"] = oldDisposition;
    }
  });

  it("a client that drops the stream mid-answer releases the turn's hold", async () => {
    chatOn();
    let started!: () => void;
    const modelStarted = new Promise<void>(r => { started = r; });
    const hanging: SonnetFn = () => { started(); return new Promise(() => {}); };
    const res = await call(req("POST", "/admin/api/chat", { message: "where do the tomatoes go?" }), deps({ chatModel: hanging }));
    const reader = res.body!.getReader();
    await modelStarted;
    const pending = async () => (await storage.engine().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mcp_spend_reservations WHERE status = 'pending' AND client_id = 'memrain_chat_operator'`)).rows[0]!.n;
    expect(await pending()).toBe(1);
    await reader.cancel();
    const deadline = Date.now() + 5000;
    while ((await pending()) > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    expect(await pending()).toBe(0);
  });
});
