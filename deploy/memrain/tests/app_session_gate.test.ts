/**
 * Gate 5: a member's /app session opens /app and nothing else.
 *
 * The invite → passkey → session flow runs through handleApp with real
 * SimpleWebAuthn verification and a software authenticator. The gate itself
 * is checked through the real server: a member cookie on /admin/api/* is
 * refused, /s/* never reads or sets it, and every memrain_app cookie the
 * server sets is `Path=/app; HttpOnly; Secure; SameSite=Strict`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { Storage } from "../src/core/storage.ts";
import { addMember, disableMember, type MemberActor } from "../src/core/members.ts";
import { registerSource } from "../src/core/sources.ts";
import { mintMemberInvite } from "../src/core/member-invites.ts";
import { APP_COOKIE, createMemberSession } from "../src/core/member-sessions.ts";
import { handleApp } from "../src/http/app.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { SoftAuthenticator } from "./helpers/soft-authenticator.ts";

const ORIGIN = "https://acme.example.test";
const RP_ID = "acme.example.test";
const OPS: MemberActor = { actor: "ops", via: "cli" };
const HOUR = 3600_000;

let tmp: string;
let storage: Storage;
const savedApp = process.env["MEMRAIN_APP"];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-app-gate-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  for (const id of ["alice", "bob"]) {
    await registerSource(e, { id: `person-${id}`, kind: "other", pathPrefix: `/person-${id}` });
    await addMember(e, id, { personalSource: `person-${id}`, displayName: id === "alice" ? "Alice" : "Bob" }, OPS);
  }
});
afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  process.env["MEMRAIN_APP"] = "1";
});
afterEach(() => {
  if (savedApp === undefined) delete process.env["MEMRAIN_APP"];
  else process.env["MEMRAIN_APP"] = savedApp;
});

/** Every memrain_app Set-Cookie carries the four attributes. */
function assertAppCookies(res: Response): void {
  for (const sc of res.headers.getSetCookie()) {
    if (!sc.startsWith(`${APP_COOKIE}=`) && !sc.startsWith(`${APP_COOKIE}_preauth=`)) continue;
    expect(sc).toContain("; Path=/app;");
    expect(sc).toContain("; HttpOnly");
    expect(sc).toContain("; Secure");
    expect(sc).toContain("; SameSite=Strict");
  }
}

class Browser {
  jar = new Map<string, string>();
  constructor(readonly origin: string = ORIGIN) {}

  absorb(res: Response): void {
    assertAppCookies(res);
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (value === "" || attrs.some(a => a.trim().toLowerCase() === "max-age=0")) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  request(path: string, method = "GET", body?: unknown): Request {
    const headers: Record<string, string> = {};
    if (method !== "GET") headers.origin = this.origin;
    if (this.jar.size > 0) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) headers["content-type"] = "application/json";
    return new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }

  async call(path: string, method = "GET", body?: unknown): Promise<Response> {
    const req = this.request(path, method, body);
    const res = (await handleApp(req, new URL(req.url), { storage, publicUrl: ORIGIN })) ?? new Response("Not Found", { status: 404 });
    this.absorb(res);
    return res;
  }

  post(path: string, body: unknown = {}): Promise<Response> {
    return this.call(path, "POST", body);
  }
}

async function invite(member = "alice"): Promise<string> {
  return (await mintMemberInvite(storage.engine(), member, 72 * HOUR)).token;
}

async function enrol(b: Browser, soft: SoftAuthenticator, token: string): Promise<Response> {
  expect((await b.post("/app/invite/open", { token })).status).toBe(200);
  const optRes = await b.post("/app/invite/passkey/options", { token });
  expect(optRes.status).toBe(200);
  const opts = ((await optRes.json()) as { optionsJSON: PublicKeyCredentialCreationOptionsJSON }).optionsJSON;
  return b.post("/app/invite/passkey/verify", { token, response: soft.register(opts), label: "Laptop" });
}

describe("invite → passkey → /app session", () => {
  it("registers a passkey from an invite and signs in with it later", async () => {
    const b = new Browser();
    const soft = new SoftAuthenticator(ORIGIN, RP_ID);
    const res = await enrol(b, soft, await invite());
    expect(res.status).toBe(200);
    expect(b.jar.has(APP_COOKIE)).toBe(true);
    const me = await b.call("/app/api/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ member_id: "alice", ready: true });

    // A fresh browser signs in with the same passkey.
    const b2 = new Browser();
    const lo = await b2.post("/app/login/options");
    expect(lo.status).toBe(200);
    const lopts = ((await lo.json()) as { optionsJSON: PublicKeyCredentialRequestOptionsJSON }).optionsJSON;
    const lv = await b2.post("/app/login/verify", { response: soft.assert(lopts) });
    expect(lv.status).toBe(200);
    expect((await b2.call("/app/api/me")).status).toBe(200);

    // Sign-out ends that session only.
    expect((await b2.post("/app/logout")).status).toBe(200);
    expect((await b2.call("/app/api/me")).status).toBe(401);
    expect((await b.call("/app/api/me")).status).toBe(200);
  });

  it("refuses a spent, revoked or expired invite with 410 and a reused one too", async () => {
    const token = await invite();
    const b = new Browser();
    expect((await enrol(b, new SoftAuthenticator(ORIGIN, RP_ID), token)).status).toBe(200);
    const again = new Browser();
    expect((await again.post("/app/invite/open", { token })).status).toBe(410);

    const stale = await invite();
    await invite();
    expect((await new Browser().post("/app/invite/open", { token: stale })).status).toBe(410);

    const short = (await mintMemberInvite(storage.engine(), "alice", 60_000, { nowMs: Date.now() - 120_000 })).token;
    expect((await new Browser().post("/app/invite/open", { token: short })).status).toBe(410);
  });

  it("never reads the token from the query string", async () => {
    const token = await invite();
    const b = new Browser();
    const res = await b.post(`/app/invite/open?token=${token}`, {});
    expect(res.status).toBe(400);
    expect((await new Browser().post("/app/invite/open", { token })).status).toBe(200);
  });

  it("gives a device without a passkey one 7-day session, and spends the invite", async () => {
    const token = await invite();
    const b = new Browser();
    expect((await b.post("/app/invite/open", { token })).status).toBe(200);
    const res = await b.post("/app/invite/session", { token });
    expect(res.status).toBe(200);
    const sc = res.headers.getSetCookie().find(c => c.startsWith(`${APP_COOKIE}=`))!;
    expect(sc).toContain(`Max-Age=${7 * 24 * 3600}`);
    expect((await b.call("/app/api/me")).status).toBe(200);
    expect((await b.post("/app/invite/session", { token })).status).toBe(410);
  });

  it("refuses a cross-site POST", async () => {
    const token = await invite();
    const b = new Browser("https://evil.example.test");
    expect((await b.post("/app/invite/open", { token })).status).toBe(403);
  });

  it("drops the session of a disabled member on the next request", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "person-carol", kind: "other", pathPrefix: "/person-carol" });
    await addMember(e, "carol", { personalSource: "person-carol" }, OPS);
    const b = new Browser();
    expect((await enrol(b, new SoftAuthenticator(ORIGIN, RP_ID), await invite("carol"))).status).toBe(200);
    expect((await b.call("/app/api/me")).status).toBe(200);
    await disableMember(e, "carol", OPS);
    expect((await b.call("/app/api/me")).status).toBe(401);
  });

  it("answers 404 on every /app path while MEMRAIN_APP is off", async () => {
    delete process.env["MEMRAIN_APP"];
    const s = await createMemberSession(storage.engine(), "alice", "passkey");
    for (const path of ["/app", "/app/api/me", "/app/login/options"]) {
      const req = new Request(`${ORIGIN}${path}`, { headers: { cookie: `${APP_COOKIE}=${s.id}` } });
      const res = await handleApp(req, new URL(req.url), { storage, publicUrl: ORIGIN });
      expect({ path, status: res?.status }).toEqual({ path, status: 404 });
    }
  });
});

describe("gate 5 through the server", () => {
  let server: ServerHandle;
  let base: string;
  let cookie: string;

  beforeAll(async () => {
    process.env["MEMRAIN_APP"] = "1";
    server = startServer({
      host: "127.0.0.1", port: 0, storage, publicBearerToken: "pub-bearer-for-test",
      adminBootstrapToken: "boot-secret-token-for-app-gate", publicUrl: ORIGIN,
    });
    base = `http://127.0.0.1:${server.port}`;
    cookie = `${APP_COOKIE}=${(await createMemberSession(storage.engine(), "alice", "passkey")).id}`;
  });
  afterAll(async () => {
    await server.stop();
  });

  it("a member cookie does not open the admin API", async () => {
    for (const path of ["/admin/api/chat/threads", "/admin/api/members", "/admin/api/stats"]) {
      const res = await fetch(`${base}${path}`, { headers: { cookie } });
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
      expect(res.headers.getSetCookie().some(c => c.startsWith(`${APP_COOKIE}=`))).toBe(false);
    }
  });

  it("the same cookie opens /app", async () => {
    const res = await fetch(`${base}/app/api/me`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("/admin and /s never set memrain_app", async () => {
    for (const path of ["/admin", "/admin/", "/s/abc"]) {
      const res = await fetch(`${base}${path}`, { headers: { cookie } });
      expect(res.headers.getSetCookie().some(c => c.startsWith(`${APP_COOKIE}`))).toBe(false);
    }
  });
});
