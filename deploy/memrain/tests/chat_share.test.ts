/**
 * Password links to one chat answer (MEMRAIN_CHAT_SHARE): created only by the
 * answer's owner and only for a finished answer, viewed at /s/<token> without
 * any cookie, showing the answer and its source titles and nothing of the
 * pages behind them. Wrong passwords lock the link; expiry and revocation end it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { handleAdminApi, type AdminApiDeps } from "../src/http/admin-api.ts";
import { handleShareCreate, handleShareView } from "../src/http/share.ts";
import { appendChatMessage, createChatThread, eraseOwnerChat, type ChatOwner } from "../src/core/chat/store.ts";
import { RateLimiter } from "../src/mcp/rate_limit.ts";
import { startServer } from "../src/http/server.ts";
import { addMember, disableMember, enableMember, removeMember } from "../src/core/members.ts";

setDefaultTimeout(60_000);

const ORIGIN = "https://brain.example.test";
const PASSWORD = "correct horse battery";
const PAGE_BODY = "The secret garden plan body that must never leave the brain.";
const saved = process.env["MEMRAIN_CHAT_SHARE"];
afterEach(() => {
  if (saved === undefined) delete process.env["MEMRAIN_CHAT_SHARE"];
  else process.env["MEMRAIN_CHAT_SHARE"] = saved;
});

let tmp: string;
let storage: Storage;
const OPERATOR: ChatOwner = { key: "operator", sourceId: "default", spendId: "memrain_chat_operator" };
const MEMBER: ChatOwner = { key: "member:ann", sourceId: "default", spendId: "memrain_chat_m_ann", readSources: ["default"], fenceDiary: true };
let okAnswer = 0;
let refusedAnswer = 0;
let memberAnswer = 0;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-chat-share-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await putPage(storage, { slug: "notes/garden", markdown_body: PAGE_BODY, title: "Garden <plan>" });
  const t = await createChatThread(e, OPERATOR, "Garden");
  await appendChatMessage(e, t, { role: "user", content: "Where do tomatoes go?" });
  okAnswer = await appendChatMessage(e, t, {
    role: "assistant", content: "Tomatoes go in the north bed [1].", status: "ok",
    citations: [{ n: 1, slug: "notes/garden", title: "Garden <plan>", kind: "page" }],
  });
  refusedAnswer = await appendChatMessage(e, t, { role: "assistant", content: "", status: "refused" });
  const mt = await createChatThread(e, MEMBER, "Mine");
  memberAnswer = await appendChatMessage(e, mt, { role: "assistant", content: "Ann's answer.", status: "ok" });
});
afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function deps(extra: Partial<AdminApiDeps> = {}): AdminApiDeps {
  return { storage, publicUrl: ORIGIN, requireAdmin: () => true, sessionCooldown: () => null, ...extra };
}
async function admin(r: Request, d = deps()): Promise<Response> {
  const res = await handleAdminApi(r, new URL(r.url), d);
  if (!res) throw new Error("not handled");
  return res;
}
const createReq = (id: number | string, body: unknown = { password: PASSWORD }, prefix = "/admin/api/chat") =>
  new Request(`${ORIGIN}${prefix}/messages/${id}/share`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
async function create(id: number): Promise<string> {
  const res = await admin(createReq(id));
  expect(res.status).toBe(200);
  const body = await res.json() as { url: string; expires_at: string };
  expect(body.url).toMatch(/^\/s\/[A-Za-z0-9_-]{43}$/);
  const days = (Date.parse(body.expires_at) - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.9);
  expect(days).toBeLessThanOrEqual(7);
  return body.url;
}
const generous = () => new RateLimiter({ capacity: 1000, refillPerSecond: 1000 });
async function view(path: string, password?: string, limiter = generous()): Promise<Response> {
  const req = password === undefined
    ? new Request(`${ORIGIN}${path}`)
    : new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }).toString() });
  const res = await handleShareView(req, new URL(req.url), storage, { limiter });
  if (!res) throw new Error("not handled");
  return res;
}

describe("chat share links", () => {
  it("off: creating answers 404 and /s/ is not handled", async () => {
    delete process.env["MEMRAIN_CHAT_SHARE"];
    expect((await admin(createReq(okAnswer))).status).toBe(404);
    const req = new Request(`${ORIGIN}/s/${"a".repeat(43)}`);
    expect(await handleShareView(req, new URL(req.url), storage)).toBeNull();
    expect((await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM chat_shares`)).rows[0]!.n).toBe(0);
  });

  it("says whether sharing is on", async () => {
    process.env["MEMRAIN_CHAT_SHARE"] = "1";
    const res = await admin(new Request(`${ORIGIN}/admin/api/chat/share`));
    expect(await res.json()).toEqual({ enabled: true });
  });

  it("creates a link for the owner's finished answer and keeps only hashes", async () => {
    process.env["MEMRAIN_CHAT_SHARE"] = "1";
    const url = await create(okAnswer);
    const token = url.slice(3);
    const rows = await storage.engine().query<{ token_hash: string; password_hash: string; owner_key: string }>(`SELECT token_hash, password_hash, owner_key FROM chat_shares`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.token_hash).not.toContain(token);
    expect(rows.rows[0]!.password_hash).not.toContain(PASSWORD);
    expect(rows.rows[0]!.owner_key).toBe("operator");
  });

  it("refuses someone else's answer, an unfinished answer and a short password", async () => {
    process.env["MEMRAIN_CHAT_SHARE"] = "1";
    expect((await admin(createReq(memberAnswer))).status).toBe(404);
    expect((await admin(createReq(999_999))).status).toBe(404);
    expect((await admin(createReq(refusedAnswer))).status).toBe(409);
    expect((await admin(createReq(okAnswer, { password: "short" }))).status).toBe(400);
    expect((await admin(createReq(okAnswer, {}))).status).toBe(400);
    // The member router passes the member as owner: the operator's answer is not theirs.
    const asMember = await handleShareCreate(createReq(okAnswer, { password: PASSWORD }, "/app/api/chat"), new URL(`${ORIGIN}/app/api/chat/messages/${okAnswer}/share`), storage, MEMBER);
    expect(asMember?.status).toBe(404);
    const own = await handleShareCreate(createReq(memberAnswer, { password: PASSWORD }, "/app/api/chat"), new URL(`${ORIGIN}/app/api/chat/messages/${memberAnswer}/share`), storage, MEMBER);
    expect(own?.status).toBe(200);
  });

  it("shows a password form first, then the answer and its source titles, never a page body", async () => {
    process.env["MEMRAIN_CHAT_SHARE"] = "1";
    const url = await create(okAnswer);
    const form = await view(url);
    expect(form.status).toBe(200);
    expect(form.headers.get("cache-control")).toContain("no-store");
    expect(form.headers.get("x-robots-tag")).toContain("noindex");
    expect(form.headers.get("content-security-policy")).toContain("default-src 'none'");
    const formHtml = await form.text();
    expect(formHtml).toContain('name="password"');
    expect(formHtml).not.toContain("north bed");
    const shown = await view(url, PASSWORD);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("cache-control")).toContain("no-store");
    const html = await shown.text();
    expect(html).toContain("Tomatoes go in the north bed [1].");
    expect(html).toContain("Garden &lt;plan&gt;");
    expect(html).not.toContain("Garden <plan>");
    expect(html).not.toContain(PAGE_BODY);
    expect(html).not.toContain("Where do tomatoes go?");
    expect(html).toContain("noindex");
  });

  it("locks the link after five wrong passwords", async () => {
    process.env["MEMRAIN_CHAT_SHARE"] = "1";
    const url = await create(okAnswer);
    for (let i = 0; i < 4; i++) expect((await view(url, "wrong password!")).status).toBe(401);
    expect((await view(url, "wrong password!")).status).toBe(429);
    expect((await view(url, PASSWORD)).status).toBe(429);
    await storage.engine().query(`UPDATE chat_shares SET locked_until = NOW() - interval '1 second'`);
    expect((await view(url, PASSWORD)).status).toBe(200);
  });

  it("parallel wrong passwords never check more than five against the hash before the lock", async () => {
    process.env["MEMRAIN_CHAT_SHARE"] = "1";
    const url = await create(okAnswer);
    const pw = Bun.password as { verify: typeof Bun.password.verify };
    const original = pw.verify;
    let checked = 0;
    pw.verify = (async (...args: Parameters<typeof Bun.password.verify>) => {
      checked++;
      return original.apply(Bun.password, args);
    }) as typeof Bun.password.verify;
    let statuses: number[];
    try {
      statuses = await Promise.all(Array.from({ length: 20 }, () => view(url, "wrong password!").then((r) => r.status)));
    } finally {
      pw.verify = original;
    }
    expect(checked).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(4);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    expect((await view(url, PASSWORD)).status).toBe(429);
  });

  it("a link revoked while its password is being checked shows nothing", async () => {
    process.env["MEMRAIN_CHAT_SHARE"] = "1";
    const url = await create(okAnswer);
    const pw = Bun.password as { verify: typeof Bun.password.verify };
    const original = pw.verify;
    pw.verify = (async (...args: Parameters<typeof Bun.password.verify>) => {
      await storage.engine().query(`UPDATE chat_shares SET revoked_at = NOW()`);
      return original.apply(Bun.password, args);
    }) as typeof Bun.password.verify;
    try {
      expect((await view(url, PASSWORD)).status).toBe(410);
    } finally {
      pw.verify = original;
    }
  });

  it("throttles password attempts per client across links", async () => {
    process.env["MEMRAIN_CHAT_SHARE"] = "1";
    const url = await create(okAnswer);
    const tight = new RateLimiter({ capacity: 2, refillPerSecond: 0.001 });
    expect((await view(url, PASSWORD, tight)).status).toBe(200);
    expect((await view(url, PASSWORD, tight)).status).toBe(200);
    expect((await view(url, PASSWORD, tight)).status).toBe(429);
  });

  it("answers 410 once the link expired or was revoked, and 404 for an unknown token", async () => {
    process.env["MEMRAIN_CHAT_SHARE"] = "1";
    const expired = await create(okAnswer);
    await storage.engine().query(`UPDATE chat_shares SET expires_at = NOW() - interval '1 second' WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`, [expired.slice(3)]);
    expect((await view(expired)).status).toBe(410);
    expect((await view(expired, PASSWORD)).status).toBe(410);
    const revoked = await create(okAnswer);
    const del = await admin(new Request(`${ORIGIN}/admin/api/chat/messages/${okAnswer}/share`, { method: "DELETE", headers: { origin: ORIGIN } }));
    expect(del.status).toBe(200);
    expect((await view(revoked, PASSWORD)).status).toBe(410);
    expect((await view(`/s/${"b".repeat(43)}`)).status).toBe(404);
    expect((await view("/s/short")).status).toBe(404);
  });

  it("the server serves /s/ to a public visitor without any credential, only while sharing is on", async () => {
    process.env["MEMRAIN_CHAT_SHARE"] = "1";
    const url = await create(okAnswer);
    const server = startServer({ host: "127.0.0.1", port: 0, storage, publicBearerToken: "pub-bearer-for-test" });
    try {
      const pub = { "Cf-Connecting-Ip": "203.0.113.9" };
      const shown = await fetch(`http://127.0.0.1:${server.port}${url}`, { headers: pub });
      expect(shown.status).toBe(200);
      expect(await shown.text()).toContain('name="password"');
      const opened = await fetch(`http://127.0.0.1:${server.port}${url}`, {
        method: "POST",
        headers: { ...pub, "content-type": "application/x-www-form-urlencoded", cookie: "memrain_admin=forged" },
        body: new URLSearchParams({ password: PASSWORD }).toString(),
      });
      expect(opened.status).toBe(200);
      expect(opened.headers.get("set-cookie")).toBeNull();
      expect(await opened.text()).toContain("north bed");
      // Off, the path is guarded exactly as before: no bearer, no page.
      delete process.env["MEMRAIN_CHAT_SHARE"];
      expect((await fetch(`http://127.0.0.1:${server.port}${url}`, { headers: pub })).status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  it("closes a member's links while the member is disabled, and for good once removed", async () => {
    process.env["MEMRAIN_CHAT_SHARE"] = "1";
    const e = storage.engine();
    const who = { actor: "test", via: "cli" } as const;
    await addMember(e, "bea", {}, who);
    const bea: ChatOwner = { key: "member:bea", sourceId: "default", spendId: "memrain_chat_m_bea", readSources: ["default"], fenceDiary: true };
    const t = await createChatThread(e, bea, "Group notes");
    const answer = await appendChatMessage(e, t, { role: "assistant", content: "Built from the group source.", status: "ok" });
    const res = await handleShareCreate(createReq(answer, { password: PASSWORD }, "/app/api/chat"), new URL(`${ORIGIN}/app/api/chat/messages/${answer}/share`), storage, bea);
    expect(res?.status).toBe(200);
    const url = (await res!.json() as { url: string }).url;
    expect((await view(url, PASSWORD)).status).toBe(200);
    await disableMember(e, "bea", who);
    expect((await view(url)).status).toBe(410);
    expect((await view(url, PASSWORD)).status).toBe(410);
    await enableMember(e, "bea", who);
    expect((await view(url, PASSWORD)).status).toBe(200);
    await removeMember(e, "bea", who);
    expect((await view(url, PASSWORD)).status).toBe(410);
    // An operator link does not depend on any member row.
    expect((await view(await create(okAnswer), PASSWORD)).status).toBe(200);
  });

  it("goes with the answer when the owner's chat is erased", async () => {
    process.env["MEMRAIN_CHAT_SHARE"] = "1";
    const url = await create(okAnswer);
    await eraseOwnerChat(storage.engine(), "operator", true);
    expect((await view(url, PASSWORD)).status).toBe(404);
    expect((await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM chat_shares WHERE owner_key = 'operator'`)).rows[0]!.n).toBe(0);
  });
});
