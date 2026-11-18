/**
 * Rating an Ask answer's sources over HTTP (POST /admin/api/feedback): only the
 * owner of a finished answer may rate, only the pages that answer cites, and
 * only in a source the owner can read. Off, the route does not exist.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { handleAdminApi, type AdminApiDeps } from "../src/http/admin-api.ts";
import { handleFeedbackApi } from "../src/http/feedback-api.ts";
import { appendChatMessage, createChatThread, type ChatOwner } from "../src/core/chat/store.ts";
import { principalHash } from "../src/core/feedback/store.ts";

setDefaultTimeout(60_000);

const ORIGIN = "https://brain.example.test";
const saved = process.env["MEMRAIN_FEEDBACK"];
afterEach(() => {
  if (saved === undefined) delete process.env["MEMRAIN_FEEDBACK"];
  else process.env["MEMRAIN_FEEDBACK"] = saved;
});

let tmp: string;
let storage: Storage;
const OPERATOR: ChatOwner = { key: "operator", sourceId: "default", spendId: "memrain_chat_operator" };
const MEMBER: ChatOwner = { key: "member:ann", sourceId: "person-ann", spendId: "memrain_chat_m_ann", readSources: ["person-ann"], fenceDiary: true };
let okAnswer = 0;
let refusedAnswer = 0;
let memberAnswer = 0;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-feedback-api-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: "person-ann", kind: "github", pathPrefix: "/ann" });
  await putPage(storage, { slug: "notes/garden", markdown_body: "Tomatoes go north.", title: "Garden" });
  await putPage(storage, { slug: "notes/other", markdown_body: "Something else.", title: "Other" });
  await putPage(storage, { slug: "ann/plan", markdown_body: "Ann's plan.", title: "Plan", source_id: "person-ann" });
  const t = await createChatThread(e, OPERATOR, "Garden");
  okAnswer = await appendChatMessage(e, t, {
    role: "assistant", content: "North [1]", status: "ok",
    citations: [{ n: 1, slug: "notes/garden", title: "Garden", kind: "page" }, { n: 2, slug: "ann/plan", title: "Plan", kind: "page" }],
  });
  refusedAnswer = await appendChatMessage(e, t, { role: "assistant", content: "", status: "refused", citations: [{ n: 1, slug: "notes/garden", title: "Garden", kind: "page" }] });
  const mt = await createChatThread(e, MEMBER, "Plan");
  memberAnswer = await appendChatMessage(e, mt, {
    role: "assistant", content: "Plan [1]", status: "ok",
    citations: [{ n: 1, slug: "ann/plan", title: "Plan", kind: "page" }, { n: 2, slug: "notes/garden", title: "Garden", kind: "page" }],
  });
});
afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const post = (body: unknown, path = "/admin/api/feedback", origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
function deps(extra: Partial<AdminApiDeps> = {}): AdminApiDeps {
  return { storage, publicUrl: ORIGIN, requireAdmin: () => true, sessionCooldown: () => null, ...extra };
}
async function admin(r: Request, d = deps()): Promise<Response> {
  const res = await handleAdminApi(r, new URL(r.url), d);
  if (!res) throw new Error("not handled");
  return res;
}
const rows = async () => (await storage.engine().query<{ slug: string; principal_hash: string; query_id: string; signal: string }>(
  `SELECT slug, principal_hash, query_id, signal FROM retrieval_feedback ORDER BY id`)).rows;

describe("feedback API", () => {
  it("off: the route answers 404 and stores nothing", async () => {
    delete process.env["MEMRAIN_FEEDBACK"];
    expect((await admin(post({ message_id: okAnswer, slug: "notes/garden", rating: 1 }))).status).toBe(404);
    expect((await admin(new Request(`${ORIGIN}/admin/api/feedback`))).status).toBe(404);
    expect(await rows()).toEqual([]);
  });

  it("sits behind the admin session and same-origin gates", async () => {
    process.env["MEMRAIN_FEEDBACK"] = "1";
    expect((await admin(post({ message_id: okAnswer, slug: "notes/garden", rating: 1 }), deps({ requireAdmin: () => false }))).status).toBe(401);
    expect((await admin(post({ message_id: okAnswer, slug: "notes/garden", rating: 1 }, "/admin/api/feedback", "https://evil.example.test"))).status).toBe(403);
    expect(await rows()).toEqual([]);
  });

  it("says whether rating is on", async () => {
    process.env["MEMRAIN_FEEDBACK"] = "1";
    const res = await admin(new Request(`${ORIGIN}/admin/api/feedback`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });

  it("rates a page the owner's finished answer cites", async () => {
    process.env["MEMRAIN_FEEDBACK"] = "1";
    const res = await admin(post({ message_id: String(okAnswer), slug: "notes/garden", rating: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await rows()).toEqual([{ slug: "notes/garden", principal_hash: principalHash("operator"), query_id: String(okAnswer), signal: "explicit" }]);
  });

  it("refuses a slug the answer does not cite, an unfinished answer, someone else's answer and bad input", async () => {
    process.env["MEMRAIN_FEEDBACK"] = "1";
    const before = (await rows()).length;
    expect((await admin(post({ message_id: okAnswer, slug: "notes/other", rating: 1 }))).status).toBe(400);
    expect((await admin(post({ message_id: refusedAnswer, slug: "notes/garden", rating: 1 }))).status).toBe(409);
    expect((await admin(post({ message_id: memberAnswer, slug: "ann/plan", rating: 1 }))).status).toBe(404);
    expect((await admin(post({ message_id: 999_999, slug: "notes/garden", rating: 1 }))).status).toBe(404);
    expect((await admin(post({ message_id: okAnswer, slug: "notes/garden", rating: 5 }))).status).toBe(400);
    expect((await admin(post({ message_id: "x", slug: "notes/garden", rating: 1 }))).status).toBe(400);
    expect((await admin(new Request(`${ORIGIN}/admin/api/feedback`, { method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" }, body: "{}" }))).status).toBe(415);
    expect((await rows()).length).toBe(before);
  });

  it("a member rates only pages in the sources it can read", async () => {
    process.env["MEMRAIN_FEEDBACK"] = "1";
    const before = (await rows()).length;
    const own = await handleFeedbackApi(post({ message_id: memberAnswer, slug: "ann/plan", rating: -1 }, "/app/api/feedback"), { storage, owner: MEMBER });
    expect(own.status).toBe(200);
    const foreign = await handleFeedbackApi(post({ message_id: memberAnswer, slug: "notes/garden", rating: 1 }, "/app/api/feedback"), { storage, owner: MEMBER });
    expect(foreign.status).toBe(403);
    const mine = (await rows()).slice(before);
    expect(mine.map(r => [r.slug, r.principal_hash])).toEqual([["ann/plan", principalHash("member:ann")]]);
    const tier = await storage.engine().query<{ tier: string }>(`SELECT tier FROM retrieval_feedback WHERE slug = 'ann/plan'`);
    expect(tier.rows.map(r => r.tier)).toEqual(["member"]);
  });
});
