/**
 * Admin passkey sign-in end to end, through createAdminAuth with real
 * SimpleWebAuthn verification and a software authenticator.
 *
 * The server is reached the way it is in production: over plain http behind a
 * TLS-terminating proxy that preserves Host, with MEMRAIN_PUBLIC_URL naming the
 * https origin the browser actually uses.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { Storage } from "../src/core/storage.ts";
import { createAdminAuth, type AdminAuth } from "../src/http/admin.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import { FAILURE_FLOOR_MS } from "../src/http/admin-passkey.ts";
import { credentialHash, getPasskey, listAuthEvents, listPasskeys } from "../src/core/admin-passkey-store.ts";
import { SoftAuthenticator } from "./helpers/soft-authenticator.ts";

const BOOT = "boot-secret-token-for-passkey-tests";
const ORIGIN = "https://brain.example.com";
const RP_ID = "brain.example.com";
const INTERNAL = "http://brain.example.com";
const MIN = 60_000;
const HOUR = 60 * MIN;

let tmp: string;
let storage: Storage;
let auth: AdminAuth;
let clock: number;

function tick(ms: number): void {
  clock += ms;
  setSystemTime(new Date(clock));
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-passkey-flow-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterAll(async () => {
  setSystemTime();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const TABLES = ["admin_auth_events", "admin_setup_links", "admin_recovery_codes", "admin_passkeys", "admin_owner"];
beforeEach(async () => {
  for (const t of TABLES) await storage.engine().query(`DELETE FROM ${t}`);
  clock = Date.now();
  setSystemTime(new Date(clock));
  auth = createAdminAuth({ bootstrapToken: BOOT, publicUrl: ORIGIN, storage });
});
afterEach(() => setSystemTime());

interface CallOpts {
  method?: string;
  body?: unknown;
  rawBody?: RequestInit["body"];
  headers?: Record<string, string>;
  json?: boolean;
}

/** A browser: a cookie jar, a client IP, an Origin. */
class Browser {
  jar = new Map<string, string>();
  /** `ip: null` sends no client-IP header: the caller resolves to the shared "internal" key. */
  constructor(readonly ip: string | null = "198.51.100.7", readonly origin: string | null = ORIGIN) {}

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => a.trim().toLowerCase() === "max-age=0");
      if (expired || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  request(path: string, o: CallOpts = {}): Request {
    const method = o.method ?? (o.body !== undefined || o.rawBody !== undefined ? "POST" : "GET");
    const headers: Record<string, string> = { ...(this.ip !== null ? { "cf-connecting-ip": this.ip } : {}), ...(o.headers ?? {}) };
    if (this.origin && method !== "GET") headers.origin = this.origin;
    if (this.jar.size > 0) headers.cookie = this.cookieHeader();
    let body: RequestInit["body"] | undefined = o.rawBody;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      if (o.json !== false) headers["content-type"] ??= "application/json";
    }
    return new Request(`${INTERNAL}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  }

  async call(path: string, o: CallOpts = {}): Promise<Response> {
    const req = this.request(path, o);
    const url = new URL(req.url);
    const res = (await auth.handleAuthRoute(req, url))
      ?? (await handleAdminApi(req, url, { storage, requireAdmin: auth.requireAdmin, sessionCooldown: auth.sessionCooldown, publicUrl: ORIGIN }))
      ?? new Response("Not Found", { status: 404 });
    this.absorb(res);
    return res;
  }

  post(path: string, body: unknown = {}, headers?: Record<string, string>): Promise<Response> {
    return this.call(path, { body, ...(headers ? { headers } : {}) });
  }

  signedIn(): boolean {
    return auth.requireAdmin(this.request("/admin/api/x"));
  }
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.clone().json()) as Record<string, unknown>;
}

async function bearerLink(ttl?: number): Promise<string> {
  const req = new Request(`${INTERNAL}/admin/api/setup-links`, {
    method: "POST",
    headers: { authorization: `Bearer ${BOOT}`, ...(ttl !== undefined ? { "content-type": "application/json" } : {}) },
    ...(ttl !== undefined ? { body: JSON.stringify({ ttl_hours: ttl }) } : {}),
  });
  const res = (await auth.handleAuthRoute(req, new URL(req.url)))!;
  expect(res.status).toBe(200);
  const url = ((await res.json()) as { url: string }).url;
  return url.slice(url.indexOf("#enroll/") + "#enroll/".length);
}

async function registerOptions(b: Browser): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const res = await b.post("/admin/api/passkey/register/options");
  expect(res.status).toBe(200);
  return ((await res.json()) as { optionsJSON: PublicKeyCredentialCreationOptionsJSON }).optionsJSON;
}

async function enroll(b: Browser, token: string, soft = new SoftAuthenticator(ORIGIN, RP_ID)): Promise<{ soft: SoftAuthenticator; body: Record<string, unknown> }> {
  expect((await b.post("/admin/api/passkey/enroll/redeem", { token })).status).toBe(200);
  const opts = await registerOptions(b);
  const res = await b.post("/admin/api/passkey/register/verify", { response: soft.register(opts), label: "Laptop" });
  expect(res.status).toBe(200);
  return { soft, body: await json(res) };
}

async function loginOptions(b: Browser): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const res = await b.post("/admin/api/passkey/login/options");
  expect(res.status).toBe(200);
  return ((await res.json()) as { optionsJSON: PublicKeyCredentialRequestOptionsJSON }).optionsJSON;
}

async function login(b: Browser, soft: SoftAuthenticator, over: Parameters<SoftAuthenticator["assert"]>[1] = {}): Promise<Response> {
  const opts = await loginOptions(b);
  return b.post("/admin/api/passkey/login/verify", { response: soft.assert(opts, over) });
}

async function reauth(b: Browser, soft: SoftAuthenticator): Promise<Response> {
  const res = await b.post("/admin/api/passkey/reauth/options");
  expect(res.status).toBe(200);
  const opts = ((await res.json()) as { optionsJSON: PublicKeyCredentialRequestOptionsJSON }).optionsJSON;
  return b.post("/admin/api/passkey/reauth/verify", { response: soft.assert(opts) });
}

async function operator(): Promise<Browser> {
  const b = new Browser("203.0.113.9");
  const res = await b.post("/admin/login", { token: BOOT });
  expect(res.status).toBe(200);
  return b;
}

/** Owner enrolled via a setup link, then past the 24 h cooldown. */
async function settledOwner(): Promise<{ b: Browser; soft: SoftAuthenticator; codes: string[] }> {
  const b = new Browser();
  const { soft, body } = await enroll(b, await bearerLink());
  tick(25 * HOUR);
  const fresh = new Browser();
  expect((await login(fresh, soft)).status).toBe(200);
  return { b: fresh, soft, codes: body.recovery_codes as string[] };
}

/**
 * Pause the first query matching `pattern` (also inside a transaction) until
 * `release()`; `hit` resolves once it is paused. `restore()` undoes the hook.
 */
function gateQuery(pattern: RegExp, fail = false): { hit: Promise<void>; release: () => void; restore: () => void } {
  const real = storage.engine.bind(storage);
  let onHit!: () => void;
  let release!: () => void;
  const hit = new Promise<void>((r) => (onHit = r));
  const open = new Promise<void>((r) => (release = r));
  let armed = true;
  const wrap = (eng: ReturnType<Storage["engine"]>): ReturnType<Storage["engine"]> =>
    new Proxy(eng, {
      get(t, prop) {
        if (prop === "query") {
          return async (sql: string, params?: unknown[]) => {
            if (armed && pattern.test(sql)) {
              armed = false;
              onHit();
              if (fail) throw new Error("injected failure");
              await open;
            }
            return t.query(sql, params as never);
          };
        }
        if (prop === "transaction") {
          return (fn: (tx: typeof t) => Promise<unknown>) => t.transaction((tx) => fn(wrap(tx)));
        }
        const v = (t as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  storage.engine = () => wrap(real());
  return { hit, release, restore: () => { storage.engine = real; } };
}

/** Sign out everywhere from `b` while another request is paused, then let it go. */
async function signOutDuring(b: Browser, gate: ReturnType<typeof gateQuery>, paused: Promise<Response>): Promise<Response> {
  await gate.hit;
  const out = b.post("/admin/api/sign-out-everywhere");
  while (b.signedIn()) await Bun.sleep(1);
  gate.release();
  expect((await out).status).toBe(200);
  return paused;
}

/**
 * With `paused` stopped at the gate (inside the passkey lock), sign out
 * everywhere from `b`, check whether the sign-out had to wait, then let both
 * finish.
 */
async function signOutWhilePaused(b: Browser, gate: ReturnType<typeof gateQuery>, paused: Promise<Response>): Promise<{ res: Response; waited: boolean }> {
  await gate.hit;
  const out = b.post("/admin/api/sign-out-everywhere");
  await Bun.sleep(30);
  const waited = b.signedIn();
  gate.release();
  const [res, done] = await Promise.all([paused, out]);
  expect(done.status).toBe(200);
  expect(b.signedIn()).toBe(false);
  return { res, waited };
}

/** A settled owner signed in (and stepped up) in a second browser. */
async function steppedUpSession(soft: SoftAuthenticator, ip: string): Promise<Browser> {
  const a = new Browser(ip);
  expect((await login(a, soft)).status).toBe(200);
  expect((await reauth(a, soft)).status).toBe(200);
  return a;
}

async function events(): Promise<{ event: string; outcome: string; reason: string | null; notice: boolean; credential: string | null }[]> {
  return (await listAuthEvents(storage.engine(), 200)).reverse();
}

describe("enroll and sign in", () => {
  it("setup link → redeem → register → recovery codes → a session requireAdmin accepts", async () => {
    const b = new Browser();
    const token = await bearerLink();
    const redeem = await b.post("/admin/api/passkey/enroll/redeem", { token });
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toEqual({ ok: true, expires_in: 900 });
    const sc = redeem.headers.getSetCookie()[0]!;
    expect(sc).toMatch(/^__Host-memrain_preauth=[0-9a-f]{64}; /);
    for (const attr of ["Path=/", "HttpOnly", "SameSite=Strict", "Secure"]) expect(sc.split("; ")).toContain(attr);
    expect(sc).not.toMatch(/Domain=/i);
    // The pre-auth cookie with its grant is not a session.
    expect(b.signedIn()).toBe(false);

    const opts = await registerOptions(b);
    expect(opts.rp.id).toBe(RP_ID);
    expect(opts.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    const soft = new SoftAuthenticator(ORIGIN, RP_ID);
    const verify = await b.post("/admin/api/passkey/register/verify", { response: soft.register(opts), label: "Laptop" });
    expect(verify.status).toBe(200);
    const body = await json(verify);
    expect(body.passkey).toEqual({ id: soft.credentialId, label: "Laptop" });
    expect(body.recovery_codes).toHaveLength(10);
    expect(b.jar.has("__Host-memrain_preauth")).toBe(false);
    expect(b.signedIn()).toBe(true);
    // The very first passkey via a setup link raises no notice.
    expect((await events()).filter((x) => x.notice)).toEqual([]);
  });

  it("login mints a fresh session id, expires the pre-auth cookie and ignores a planted session value", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const b = new Browser();
    b.jar.set("memrain_admin", "a".repeat(64));
    const res = await login(b, soft);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, notices: 0 });
    expect(b.jar.get("memrain_admin")).toMatch(/^[0-9a-f]{64}$/);
    expect(b.jar.get("memrain_admin")).not.toBe("a".repeat(64));
    expect(b.jar.has("__Host-memrain_preauth")).toBe(false);
    expect(b.signedIn()).toBe(true);
  });

  it("an https config ignores an unprefixed pre-auth cookie", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const b = new Browser();
    const opts = await loginOptions(b);
    const id = b.jar.get("__Host-memrain_preauth")!;
    b.jar.delete("__Host-memrain_preauth");
    b.jar.set("memrain_preauth", id);
    const res = await b.post("/admin/api/passkey/login/verify", { response: soft.assert(opts) });
    expect(res.status).toBe(401);
    expect(b.signedIn()).toBe(false);
  });

  it("uses the unprefixed, /admin-scoped cookie on an http localhost config", async () => {
    auth = createAdminAuth({ bootstrapToken: BOOT, publicUrl: "http://localhost:8080", storage });
    const b = new Browser("198.51.100.7", "http://localhost:8080");
    const res = await b.post("/admin/api/passkey/login/options");
    const sc = res.headers.getSetCookie()[0]!;
    expect(sc).toMatch(/^memrain_preauth=[0-9a-f]{64}; Path=\/admin; HttpOnly; SameSite=Strict; Max-Age=900$/);
  });

  it("a passkey login keeps the parked /authorize request answerable", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const b = new Browser();
    const park = await b.call("/admin/login?return_to=" + encodeURIComponent("/authorize?client_id=c1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb"));
    expect(park.status).toBe(302);
    expect((await login(b, soft)).status).toBe(200);
    const pending = await b.call("/admin/api/pending-resume");
    expect(pending.status).toBe(200);
    expect((await pending.json() as { client_id: string }).client_id).toBe("c1");
  });

  it("sessionOf and requireAdmin agree when current and legacy cookies are both sent", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const b = new Browser();
    expect((await login(b, soft)).status).toBe(200);
    const live = b.jar.get("memrain_admin")!;
    // A dead legacy value sent ahead of the live one: both views still see the live session.
    b.jar.clear();
    b.jar.set("memex_admin", "f".repeat(64));
    b.jar.set("memrain_admin", live);
    expect(b.signedIn()).toBe(true);
    expect((await b.call("/admin/api/passkeys")).status).toBe(200);
    b.jar.set("memrain_admin", "e".repeat(64));
    expect(b.signedIn()).toBe(false);
    expect((await b.call("/admin/api/passkeys")).status).toBe(401);
  });
});

describe("challenges", () => {
  it("a replayed challenge is refused", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const b = new Browser();
    const opts = await loginOptions(b);
    const before = new Map(b.jar);
    const response = soft.assert(opts);
    expect((await b.post("/admin/api/passkey/login/verify", { response })).status).toBe(200);
    // The same pre-auth cookie and the same signed assertion, sent again.
    const replay = new Browser();
    replay.jar = before;
    expect((await replay.post("/admin/api/passkey/login/verify", { response })).status).toBe(401);
    expect(replay.signedIn()).toBe(false);
  });

  it("a challenge is used once even when the first attempt fails", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const b = new Browser();
    const opts = await loginOptions(b);
    expect((await b.post("/admin/api/passkey/login/verify", { response: soft.assert(opts, { origin: "https://evil.example" }) })).status).toBe(401);
    expect((await b.post("/admin/api/passkey/login/verify", { response: soft.assert(opts) })).status).toBe(401);
  });

  it("a substituted clientDataJSON challenge is refused", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const b = new Browser();
    await loginOptions(b);
    const other = new Browser("198.51.100.99");
    const foreign = await loginOptions(other);
    expect((await b.post("/admin/api/passkey/login/verify", { response: soft.assert(foreign) })).status).toBe(401);
  });

  it("is bound to its pre-auth cookie and its purpose", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const a = new Browser();
    const opts = await loginOptions(a);
    const other = new Browser("198.51.100.8");
    await loginOptions(other);
    expect((await other.post("/admin/api/passkey/login/verify", { response: soft.assert(opts) })).status).toBe(401);

    // A login challenge presented to reauth/verify, and a reauth challenge to login/verify.
    const s = new Browser();
    expect((await login(s, soft)).status).toBe(200);
    const lo = await loginOptions(s);
    expect((await s.post("/admin/api/passkey/reauth/verify", { response: soft.assert(lo) })).status).toBe(401);
    const ro = ((await (await s.post("/admin/api/passkey/reauth/options")).json()) as { optionsJSON: PublicKeyCredentialRequestOptionsJSON }).optionsJSON;
    expect((await s.post("/admin/api/passkey/login/verify", { response: soft.assert(ro) })).status).toBe(401);
  });

  it("a login challenge cannot complete a registration", async () => {
    const b = new Browser();
    await b.post("/admin/api/passkey/enroll/redeem", { token: await bearerLink() });
    const lo = await loginOptions(b);
    const soft = new SoftAuthenticator(ORIGIN, RP_ID);
    const fake = soft.register({ challenge: lo.challenge, user: { id: "AAAA" } } as PublicKeyCredentialCreationOptionsJSON);
    expect((await b.post("/admin/api/passkey/register/verify", { response: fake })).status).toBe(401);
    expect((await events()).some((x) => x.event === "passkey.register_failed" && x.reason === "bad_challenge")).toBe(true);
  });

  it("a reauth challenge from session A is refused under session B, and a session register challenge dies with sign-out-everywhere", async () => {
    const { soft } = await settledOwner();
    const a = new Browser("198.51.100.20");
    const bb = new Browser("198.51.100.21");
    expect((await login(a, soft)).status).toBe(200);
    expect((await login(bb, soft)).status).toBe(200);
    const ro = ((await (await a.post("/admin/api/passkey/reauth/options")).json()) as { optionsJSON: PublicKeyCredentialRequestOptionsJSON }).optionsJSON;
    expect((await bb.post("/admin/api/passkey/reauth/verify", { response: soft.assert(ro) })).status).toBe(401);

    expect((await reauth(a, soft)).status).toBe(200);
    const opts = await registerOptions(a);
    expect((await a.post("/admin/api/sign-out-everywhere")).status).toBe(200);
    const second = new SoftAuthenticator(ORIGIN, RP_ID);
    expect((await a.post("/admin/api/passkey/register/verify", { response: second.register(opts) })).status).toBe(401);
  });

  it("expires after 5 minutes", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const b = new Browser();
    const opts = await loginOptions(b);
    tick(5 * MIN + 1000);
    expect((await b.post("/admin/api/passkey/login/verify", { response: soft.assert(opts) })).status).toBe(401);
  });
});

describe("ceremony checks", () => {
  it("refuses a wrong origin, a wrong rpIdHash, a missing UV flag and a foreign user handle", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const cases: [Parameters<SoftAuthenticator["assert"]>[1], string][] = [
      [{ origin: "https://evil.example" }, "bad_origin"],
      [{ rpID: "evil.example" }, "bad_rpid"],
      [{ uv: false }, "no_uv"],
      [{ userHandle: Buffer.alloc(32, 7).toString("base64url") }, "user_handle_mismatch"],
    ];
    for (const [over, reason] of cases) {
      const b = new Browser(`198.51.100.${30 + cases.findIndex((c) => c[1] === reason)}`);
      expect((await login(b, soft, over)).status).toBe(401);
      expect(b.signedIn()).toBe(false);
      expect((await events()).some((x) => x.event === "passkey.login_failed" && x.reason === reason)).toBe(true);
    }
  });

  it("refuses a registration from a wrong origin", async () => {
    const b = new Browser();
    await b.post("/admin/api/passkey/enroll/redeem", { token: await bearerLink() });
    const opts = await registerOptions(b);
    const soft = new SoftAuthenticator("https://evil.example", RP_ID);
    expect((await b.post("/admin/api/passkey/register/verify", { response: soft.register(opts) })).status).toBe(401);
    expect((await events()).some((x) => x.event === "passkey.register_failed" && x.reason === "bad_origin")).toBe(true);
  });

  it("a counter regression is refused, audited as a notice, and the credential kept; 0/0 passes twice", async () => {
    const synced = await settledOwner();
    expect((await login(new Browser("198.51.100.40"), synced.soft)).status).toBe(200);
    expect((await login(new Browser("198.51.100.41"), synced.soft)).status).toBe(200);

    const counted = new SoftAuthenticator(ORIGIN, RP_ID);
    counted.synced = false;
    counted.counter = 5;
    const owner = new Browser("198.51.100.42");
    expect((await login(owner, synced.soft)).status).toBe(200);
    expect((await reauth(owner, synced.soft)).status).toBe(200);
    const opts = await registerOptions(owner);
    expect((await owner.post("/admin/api/passkey/register/verify", { response: counted.register(opts) })).status).toBe(200);
    counted.counter = 6;
    expect((await login(new Browser("198.51.100.43"), counted)).status).toBe(200);
    const res = await login(new Browser("198.51.100.44"), counted, { counter: 3 });
    expect(res.status).toBe(401);
    const ev = (await events()).find((x) => x.event === "passkey.counter_regression")!;
    expect(ev).toMatchObject({ notice: true, credential: credentialHash(counted.credentialId) });
    expect((await login(new Browser("198.51.100.45"), counted, { counter: 7 })).status).toBe(200);
  });

  it("a discoverable login without the owner's user handle is refused", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    soft.userHandle = null;
    const b = new Browser("198.51.100.50");
    expect((await login(b, soft)).status).toBe(401);
    expect(b.signedIn()).toBe(false);
    expect((await events()).some((x) => x.event === "passkey.login_failed" && x.reason === "missing_user_handle")).toBe(true);
  });

  it("reauth accepts an assertion without a user handle, since it names the credentials", async () => {
    const { b, soft } = await settledOwner();
    soft.userHandle = null;
    expect((await reauth(b, soft)).status).toBe(200);
  });

  it("a non-string user handle is refused as a mismatch", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const b = new Browser("198.51.100.51");
    const response = soft.assert(await loginOptions(b));
    (response.response as unknown as Record<string, unknown>).userHandle = 123;
    expect((await b.post("/admin/api/passkey/login/verify", { response })).status).toBe(401);
    expect((await events()).some((x) => x.event === "passkey.login_failed" && x.reason === "user_handle_mismatch")).toBe(true);
  });

  it("unknown and known-but-wrong credentials both take at least the failure floor, on login and reauth", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const stranger = new SoftAuthenticator(ORIGIN, RP_ID);
    stranger.userHandle = soft.userHandle;
    const cases = [
      [new Browser("198.51.100.62"), stranger, {}],
      [new Browser("198.51.100.63"), soft, { origin: "https://evil.example" }],
    ] as const;
    for (const [b, s, over] of cases) {
      const opts = await loginOptions(b);
      const t0 = performance.now();
      const res = await b.post("/admin/api/passkey/login/verify", { response: s.assert(opts, over) });
      expect(res.status).toBe(401);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(FAILURE_FLOOR_MS - 5);
    }
    const owner = new Browser("198.51.100.64");
    expect((await login(owner, soft)).status).toBe(200);
    const ro = ((await (await owner.post("/admin/api/passkey/reauth/options")).json()) as { optionsJSON: PublicKeyCredentialRequestOptionsJSON }).optionsJSON;
    const t0 = performance.now();
    expect((await owner.post("/admin/api/passkey/reauth/verify", { response: stranger.assert(ro) })).status).toBe(401);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(FAILURE_FLOOR_MS - 5);
    const ro2 = ((await (await owner.post("/admin/api/passkey/reauth/options")).json()) as { optionsJSON: PublicKeyCredentialRequestOptionsJSON }).optionsJSON;
    const t1 = performance.now();
    expect((await owner.post("/admin/api/passkey/reauth/verify", { response: soft.assert(ro2, { origin: "https://evil.example" }) })).status).toBe(401);
    expect(performance.now() - t1).toBeGreaterThanOrEqual(FAILURE_FLOOR_MS - 5);
  });

  it("an unknown credential gets the same body as any other failure", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const stranger = new SoftAuthenticator(ORIGIN, RP_ID);
    stranger.userHandle = soft.userHandle;
    const a = await login(new Browser("198.51.100.60"), stranger);
    const b = await login(new Browser("198.51.100.61"), soft, { origin: "https://evil.example" });
    expect(a.status).toBe(401);
    expect(await a.json()).toEqual(await b.json());
  });
});

describe("setup links and grants", () => {
  it("used, expired and unknown links get one identical 400 and no grant cookie", async () => {
    const used = await bearerLink();
    await enroll(new Browser(), used);
    const expiring = await bearerLink(1);
    tick(HOUR + 1000);
    const bodies: unknown[] = [];
    for (const token of [used, expiring, "A".repeat(43)]) {
      const b = new Browser(`198.51.100.${70 + bodies.length}`);
      const res = await b.post("/admin/api/passkey/enroll/redeem", { token });
      expect(res.status).toBe(400);
      expect(res.headers.getSetCookie()).toEqual([]);
      bodies.push(await res.json());
    }
    expect(bodies).toEqual([{ error: "invalid_token" }, { error: "invalid_token" }, { error: "invalid_token" }]);
    const reasons = (await events()).filter((x) => x.event === "setup_link.redeem_failed").map((x) => x.reason);
    expect(reasons).toEqual(["used", "expired", "unknown"]);
  });

  it("a cancelled ceremony does not burn the link: another browser gets it after 15 minutes, not before", async () => {
    const token = await bearerLink();
    const a = new Browser("198.51.100.80");
    expect((await a.post("/admin/api/passkey/enroll/redeem", { token })).status).toBe(200);
    await registerOptions(a); // ...and the user cancels.
    // The same browser may retry at once.
    expect((await a.post("/admin/api/passkey/enroll/redeem", { token })).status).toBe(200);
    const b = new Browser("198.51.100.81");
    expect((await b.post("/admin/api/passkey/enroll/redeem", { token })).status).toBe(400);
    tick(15 * MIN + 1000);
    await enroll(b, token);
    expect(b.signedIn()).toBe(true);
  });

  it("a grant is single use and expires after 15 minutes", async () => {
    const a = new Browser();
    const token = await bearerLink();
    expect((await a.post("/admin/api/passkey/enroll/redeem", { token })).status).toBe(200);
    const preauth = a.jar.get("__Host-memrain_preauth")!;
    const opts = await registerOptions(a);
    expect((await a.post("/admin/api/passkey/register/verify", { response: new SoftAuthenticator(ORIGIN, RP_ID).register(opts) })).status).toBe(200);
    // Replaying the grant cookie: no grant behind it any more.
    const replay = new Browser("198.51.100.90");
    replay.jar.set("__Host-memrain_preauth", preauth);
    expect((await replay.post("/admin/api/passkey/register/options")).status).toBe(401);

    const late = new Browser("198.51.100.91");
    expect((await late.post("/admin/api/passkey/enroll/redeem", { token: await bearerLink() })).status).toBe(200);
    tick(15 * MIN + 1000);
    expect((await late.post("/admin/api/passkey/register/options")).status).toBe(401);
  });

  it("a grant is not a session: it reaches no management or data route", async () => {
    await settledOwner();
    const g = new Browser("198.51.100.92");
    expect((await g.post("/admin/api/passkey/enroll/redeem", { token: await bearerLink() })).status).toBe(200);
    expect(g.signedIn()).toBe(false);
    expect((await g.call("/admin/api/full-stats")).status).toBe(401);
    expect((await g.call("/admin/api/passkeys")).status).toBe(401);
    expect((await g.post("/admin/api/passkeys/rename", { id: "x", label: "y" })).status).toBe(401);
    expect((await g.post("/admin/api/passkeys/revoke", { id: "x" })).status).toBe(401);
    expect((await g.post("/admin/api/setup-links", {})).status).toBe(401);
    expect((await g.post("/admin/api/recovery-codes/regenerate")).status).toBe(401);
    expect((await g.call("/admin/api/security/events")).status).toBe(401);
  });

  it("a link or code is retired after 5 reservations, with exactly one notice", async () => {
    const { codes } = await settledOwner();
    for (const [kind, path, body, failed, cap] of [
      ["setup_link", "/admin/api/passkey/enroll/redeem", { token: await bearerLink() }, "setup_link.redeem_failed", "setup_link.cap_reached"],
      ["recovery", "/admin/api/passkey/recovery", { code: codes[4] }, "recovery.failed", "recovery.cap_reached"],
    ] as const) {
      const b = new Browser(kind === "setup_link" ? "198.51.100.97" : "198.51.100.98");
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        statuses.push((await b.post(path, body)).status);
        tick(15 * MIN + 1000); // the lease lapses, so the next redeem is a new reservation
      }
      expect({ kind, statuses }).toEqual({ kind, statuses: [200, 200, 200, 200, 200, 400, 400, 400] });
      const all = await events();
      expect(all.filter((x) => x.event === cap).map((x) => x.notice)).toEqual([true]);
      expect(all.filter((x) => x.event === failed).map((x) => [x.reason, x.notice])).toEqual([
        ["exhausted", false], ["exhausted", false], ["exhausted", false],
      ]);
      // Another browser is refused too.
      expect((await new Browser("198.51.100.99").post(path, body)).status).toBe(400);
    }
  });

  it("retrying within a live reservation never burns a link or code", async () => {
    const { codes } = await settledOwner();
    for (const [path, body] of [
      ["/admin/api/passkey/enroll/redeem", { token: await bearerLink() }],
      ["/admin/api/passkey/recovery", { code: codes[5] }],
    ] as const) {
      const b = new Browser(path.endsWith("recovery") ? "198.51.100.88" : "198.51.100.87");
      for (let i = 0; i < 8; i++) expect({ path, i, s: (await b.post(path, body)).status }).toEqual({ path, i, s: 200 });
    }
    expect((await events()).filter((x) => x.event.endsWith(".cap_reached"))).toEqual([]);
  });

  it("recovery: a code yields an enroll grant, not a session, and is spent only by the new passkey", async () => {
    const { codes } = await settledOwner();
    const b = new Browser("198.51.100.93");
    const res = await b.post("/admin/api/passkey/recovery", { code: codes[0] });
    expect(res.status).toBe(200);
    expect(b.signedIn()).toBe(false);
    // Cancelled: the code is not spent; after 15 minutes another browser may use it.
    tick(15 * MIN + 1000);
    const c = new Browser("198.51.100.94");
    expect((await c.post("/admin/api/passkey/recovery", { code: codes[0] })).status).toBe(200);
    const opts = await registerOptions(c);
    const verify = await c.post("/admin/api/passkey/register/verify", { response: new SoftAuthenticator(ORIGIN, RP_ID).register(opts) });
    expect(verify.status).toBe(200);
    expect(c.signedIn()).toBe(true);
    expect((await new Browser("198.51.100.95").post("/admin/api/passkey/recovery", { code: codes[0] })).status).toBe(400);
    const bad = await new Browser("198.51.100.96").post("/admin/api/passkey/recovery", { code: "nope" });
    expect(await bad.json()).toEqual({ error: "invalid_code" });
  });
});

describe("request gate", () => {
  const POSTS = [
    "/admin/api/passkey/enroll/redeem",
    "/admin/api/passkey/recovery",
    "/admin/api/passkey/register/options",
    "/admin/api/passkey/register/verify",
    "/admin/api/passkey/login/options",
    "/admin/api/passkey/login/verify",
    "/admin/api/passkey/reauth/options",
    "/admin/api/passkey/reauth/verify",
    "/admin/api/passkeys/rename",
    "/admin/api/passkeys/revoke",
    "/admin/api/recovery-codes/regenerate",
    "/admin/api/setup-links",
    "/admin/api/security/notices/ack",
  ];

  it("refuses a cross-origin, sibling or scheme-mismatched Origin on every POST, and accepts the configured one behind the proxy", async () => {
    for (const origin of ["https://evil.example", "https://other.example.com", "http://brain.example.com", "null"]) {
      const b = new Browser("198.51.100.100", origin);
      for (const p of POSTS) expect({ p, origin, s: (await b.post(p, {})).status }).toEqual({ p, origin, s: 403 });
    }
    // The server sees http://127.0.0.1:8080; the browser's Origin is the configured https one.
    expect((await new Browser().post("/admin/api/passkey/login/options")).status).toBe(200);
    // No Origin, Sec-Fetch-Site same-origin: allowed. No headers and no bearer: refused.
    const noOrigin = new Browser("198.51.100.101", null);
    expect((await noOrigin.post("/admin/api/passkey/login/options", {}, { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await noOrigin.post("/admin/api/passkey/login/options", {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await noOrigin.post("/admin/api/passkey/login/options")).status).toBe(403);
  });

  it("a junk bearer without Origin is refused on every passkey POST and leaves the login throttle alone", async () => {
    for (const p of POSTS.filter((x) => x !== "/admin/api/setup-links")) {
      const req = new Request(`${INTERNAL}${p}`, {
        method: "POST",
        headers: { authorization: "Bearer junk", "content-type": "application/json" },
        body: "{}",
      });
      expect({ p, s: (await auth.handleAuthRoute(req, new URL(req.url)))!.status }).toEqual({ p, s: 403 });
    }
    // The 12 junk requests above came from the shared key; the owner can still log in.
    const login = await auth.handleAuthRoute(
      new Request(`${INTERNAL}/admin/login`, { method: "POST", body: JSON.stringify({ token: BOOT }) }),
      new URL(`${INTERNAL}/admin/login`),
    );
    expect(login!.status).toBe(200);
  });

  it("setup-links without Origin: a valid bearer mints, a wrong one is refused at the gate", async () => {
    expect(await bearerLink()).toMatch(/^[\w-]{43}$/);
    const wrong = new Request(`${INTERNAL}/admin/api/setup-links`, { method: "POST", headers: { authorization: "Bearer nope" } });
    expect((await auth.handleAuthRoute(wrong, new URL(wrong.url)))!.status).toBe(403);
  });

  it("refuses a non-JSON body (415), except an empty body carrying the bootstrap bearer", async () => {
    const b = new Browser();
    for (const p of POSTS) {
      const res = await b.call(p, { method: "POST", rawBody: "token=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
      expect({ p, s: res.status }).toEqual({ p, s: 415 });
    }
    const req = new Request(`${INTERNAL}/admin/api/setup-links`, { method: "POST", headers: { authorization: `Bearer ${BOOT}` } });
    expect((await auth.handleAuthRoute(req, new URL(req.url)))!.status).toBe(200);
  });

  it("caps the body at 16 KiB, declared or chunked", async () => {
    for (const p of ["/admin/api/passkey/enroll/redeem", "/admin/api/passkey/recovery", "/admin/api/passkey/login/verify", "/admin/api/passkey/register/verify"]) {
      const b = new Browser();
      const declared = await b.call(p, { method: "POST", rawBody: "x".repeat(1024 * 1024), headers: { "content-type": "application/json" } });
      expect({ p, s: declared.status }).toEqual({ p, s: 413 });
      const stream = new ReadableStream({
        start(c) {
          for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode("y".repeat(1024)));
          c.close();
        },
      });
      const chunked = await b.call(p, { method: "POST", rawBody: stream, headers: { "content-type": "application/json" } });
      expect({ p, s: chunked.status }).toEqual({ p, s: 413 });
    }
  });

  it("management calls without a session get 401", async () => {
    const b = new Browser();
    expect((await b.call("/admin/api/passkeys")).status).toBe(401);
    expect((await b.call("/admin/api/security/events")).status).toBe(401);
    expect((await b.call("/admin/api/security/notices")).status).toBe(401);
    for (const p of ["/admin/api/passkeys/rename", "/admin/api/passkeys/revoke", "/admin/api/recovery-codes/regenerate", "/admin/api/security/notices/ack", "/admin/api/passkey/reauth/options"]) {
      expect({ p, s: (await b.post(p, { id: "x", label: "y" })).status }).toEqual({ p, s: 401 });
    }
  });

  it("with MEMRAIN_PUBLIC_URL unset every passkey route is 503, and bootstrap plus magic link still work", async () => {
    auth = createAdminAuth({ bootstrapToken: BOOT, storage });
    const b = new Browser("198.51.100.110", "http://127.0.0.1:8080");
    const status = await b.call("/admin/api/passkey/status");
    expect(await status.json()).toEqual({ available: false, reason: "public_url_unset" });
    for (const p of POSTS) expect({ p, s: (await b.post(p, {})).status }).toEqual({ p, s: 503 });
    expect((await b.call("/admin/api/passkeys")).status).toBe(503);
    expect((await b.post("/admin/login", { token: BOOT })).status).toBe(200);
    expect(b.signedIn()).toBe(true);
    const mint = await auth.handleAuthRoute(
      new Request(`${INTERNAL}/admin/api/issue-magic-link`, { method: "POST", headers: { authorization: `Bearer ${BOOT}` } }),
      new URL(`${INTERNAL}/admin/api/issue-magic-link`),
    );
    const link = new URL(((await mint!.json()) as { url: string }).url);
    const redeemed = await auth.handleAuthRoute(new Request(`${INTERNAL}${link.pathname}`), link);
    expect(redeemed!.status).toBe(302);
  });

  it("status reports availability only", async () => {
    const res = await new Browser().call("/admin/api/passkey/status");
    expect(await res.json()).toEqual({ available: true });
  });
});

describe("setup-links route", () => {
  it("bootstrap bearer mints (via=api); wrong bearer without Origin is refused at the gate; a session needs step-up; bearer wins over a session", async () => {
    const ok = await bearerLink();
    expect(ok).toMatch(/^[\w-]{43}$/);
    const wrong = new Request(`${INTERNAL}/admin/api/setup-links`, { method: "POST", headers: { authorization: "Bearer nope" } });
    expect((await auth.handleAuthRoute(wrong, new URL(wrong.url)))!.status).toBe(403);

    const { b } = await settledOwner();
    const res = await b.post("/admin/api/setup-links", {});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "reauth_required" });
    const both = await b.post("/admin/api/setup-links", {}, { authorization: `Bearer ${BOOT}` });
    expect(both.status).toBe(200);
    const issued = (await events()).filter((x) => x.event === "setup_link.issued");
    expect(issued.length).toBeGreaterThanOrEqual(3);
    const rows = await storage.engine().query<{ via: string }>(`SELECT via FROM admin_auth_events WHERE event = 'setup_link.issued'`);
    expect(new Set(rows.rows.map((r) => r.via))).toEqual(new Set(["api"]));
  });

  it("validates ttl_hours (1 and 72 ok, 0 and 73 refused, default 24 h) and revokes the previous link", async () => {
    const mint = (body: unknown) => {
      const req = new Request(`${INTERNAL}/admin/api/setup-links`, {
        method: "POST",
        headers: { authorization: `Bearer ${BOOT}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return auth.handleAuthRoute(req, new URL(req.url)) as Promise<Response>;
    };
    for (const ttl of [0, 73, 1.5, "24"]) expect((await mint({ ttl_hours: ttl })).status).toBe(400);
    const one = await mint({ ttl_hours: 1 });
    expect(Date.parse(((await one.json()) as { expires_at: string }).expires_at) - clock).toBe(HOUR);
    const max = await mint({ ttl_hours: 72 });
    const maxBody = (await max.json()) as { url: string; expires_at: string };
    expect(Date.parse(maxBody.expires_at) - clock).toBe(72 * HOUR);
    expect(maxBody.url.startsWith(`${ORIGIN}/admin/#enroll/`)).toBe(true);
    const def = (await (await mint({})).json()) as { url: string; expires_at: string };
    expect(Date.parse(def.expires_at) - clock).toBe(24 * HOUR);
    const prev = maxBody.url.split("#enroll/")[1]!;
    expect((await new Browser().post("/admin/api/passkey/enroll/redeem", { token: prev })).status).toBe(400);
  });

  it("bearer attempts share the bootstrap login throttle", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const req = new Request(`${INTERNAL}/admin/api/setup-links`, {
        method: "POST",
        headers: { authorization: "Bearer wrong", "cf-connecting-ip": "198.51.100.120" },
      });
      last = (await auth.handleAuthRoute(req, new URL(req.url)))!.status;
    }
    expect(last).toBe(429);
    const login = await auth.handleAuthRoute(
      new Request(`${INTERNAL}/admin/login`, { method: "POST", headers: { "cf-connecting-ip": "198.51.100.120" }, body: JSON.stringify({ token: BOOT }) }),
      new URL(`${INTERNAL}/admin/login`),
    );
    expect(login!.status).toBe(429);
  });
});

describe("step-up, revoke and cooldown", () => {
  it("revoke, regenerate and setup-link need a fresh step-up that lasts 5 minutes", async () => {
    const { b, soft } = await settledOwner();
    for (const [p, body] of [["/admin/api/recovery-codes/regenerate", {}], ["/admin/api/setup-links", {}]] as const) {
      expect(await (await b.post(p, body)).json()).toEqual({ error: "reauth_required" });
    }
    expect((await reauth(b, soft)).status).toBe(200);
    expect((await b.post("/admin/api/recovery-codes/regenerate")).status).toBe(200);
    expect((await b.post("/admin/api/setup-links", {})).status).toBe(200);
    tick(5 * MIN + 1000);
    expect(await (await b.post("/admin/api/recovery-codes/regenerate")).json()).toEqual({ error: "reauth_required" });
  });

  it("a bootstrap session is fresh for 10 minutes; with no passkeys it is always fresh", async () => {
    const op = await operator();
    tick(11 * MIN);
    expect((await op.post("/admin/api/setup-links", {})).status).toBe(200);
    await enroll(new Browser(), await bearerLink());
    expect(await (await op.post("/admin/api/setup-links", {})).json()).toEqual({ error: "reauth_required" });
    const op2 = await operator();
    expect((await op2.post("/admin/api/recovery-codes/regenerate")).status).toBe(200);
  });

  it("revoking the last passkey needs confirm_last; revoking X ends X's sessions and leaves Y's", async () => {
    const { b, soft } = await settledOwner();
    expect((await reauth(b, soft)).status).toBe(200);
    expect((await b.post("/admin/api/passkeys/revoke", { id: soft.credentialId })).status).toBe(409);

    const y = new SoftAuthenticator(ORIGIN, RP_ID);
    const opts = await registerOptions(b);
    expect((await b.post("/admin/api/passkey/register/verify", { response: y.register(opts), label: "Phone" })).status).toBe(200);
    const ySession = new Browser("198.51.100.130");
    expect((await login(ySession, y)).status).toBe(200);
    const op = await operator();
    expect((await op.post("/admin/api/passkeys/revoke", { id: soft.credentialId })).status).toBe(200);
    expect(b.signedIn()).toBe(false);
    expect((await b.call("/admin/api/passkeys")).status).toBe(401);
    expect(ySession.signedIn()).toBe(true);
    expect((await events()).find((x) => x.event === "passkey.revoked")).toMatchObject({ notice: true });
  });

  it("the owner's first passkey from a setup link starts without the cooldown, a later link's does not", async () => {
    const owner = new Browser();
    const { soft } = await enroll(owner, await bearerLink());
    expect(owner.signedIn()).toBe(true);
    // A new client connects an agent on day one.
    expect((await owner.post("/admin/api/api-keys", { name: "day-one" })).status).not.toBe(403);
    expect((await owner.post("/admin/api/register-client", { name: "Day one agent" })).status).not.toBe(403);
    const list = await json(await owner.call("/admin/api/passkeys"));
    expect(list.session_in_cooldown).toBe(false);
    expect((list.passkeys as { in_cooldown: boolean }[])[0]!.in_cooldown).toBe(false);
    // The exemption is stored, so a fresh sign-in keeps it.
    const again = new Browser("198.51.100.150");
    expect((await login(again, soft)).status).toBe(200);
    expect((await again.post("/admin/api/api-keys", { name: "after-login" })).status).not.toBe(403);
    // A second link while a passkey exists is the theft case: cooldown applies.
    const second = new Browser("198.51.100.151");
    await enroll(second, await bearerLink());
    const r = await second.post("/admin/api/api-keys", { name: "persist" });
    expect(r.status).toBe(403);
    expect((await r.json()) as Record<string, unknown>).toMatchObject({ error: "cooldown" });
  });

  it("a passkey from a setup link or recovery code is in a 24 h cooldown; bootstrap never is", async () => {
    await settledOwner();
    // A second passkey through a fresh link: the theft case.
    const thief = new Browser("198.51.100.140");
    const { soft } = await enroll(thief, await bearerLink());
    expect(thief.signedIn()).toBe(true);
    const until = clock + 24 * HOUR;
    const refused = [
      thief.post("/admin/api/security/notices/ack"),
      thief.post("/admin/api/passkeys/revoke", { id: "x" }),
      thief.post("/admin/api/recovery-codes/regenerate"),
      thief.post("/admin/api/setup-links", {}),
      thief.post("/admin/api/passkey/register/options"),
      thief.post("/admin/api/api-keys", { name: "persist" }),
      thief.post("/admin/api/register-client", { name: "persist" }),
    ];
    for (const r of await Promise.all(refused)) {
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ error: "cooldown", until: new Date(until).toISOString() });
    }
    // Still usable for reading.
    const list = await json(await thief.call("/admin/api/passkeys"));
    expect(list.session_in_cooldown).toBe(true);
    expect((await thief.call("/admin/api/security/notices")).status).toBe(200);

    tick(24 * HOUR + 1000);
    const later = new Browser("198.51.100.141");
    expect((await login(later, soft)).status).toBe(200);
    expect((await later.post("/admin/api/security/notices/ack")).status).toBe(200);

    const op = await operator();
    const created = await op.post("/admin/api/api-keys", { name: "operator-key" });
    expect(created.status).not.toBe(403);
  });

  it("a cooldown session is refused on every admin data POST but the tool route, on approve-resume and on sign-out-everywhere", async () => {
    // Read the route list from the source so a POST added later is covered
    // without anyone remembering to extend this test.
    const src = readFileSync(join(import.meta.dir, "../src/http/admin-api.ts"), "utf8");
    const posts = [...src.matchAll(/p === "(\/admin\/api\/[^"]+)" && req\.method === "POST"/g)].map((m) => m[1]!);
    const allowed = new Set(["/admin/api/tool"]);
    const guarded = posts.filter((p) => !allowed.has(p));
    expect(guarded).toEqual(expect.arrayContaining([
      "/admin/api/enrollments", "/admin/api/set-redirect-uris", "/admin/api/rescope-client",
      "/admin/api/update-client-ttl", "/admin/api/revoke-client", "/admin/api/invalidate-tokens",
      "/admin/api/api-keys/revoke", "/admin/api/revoke-grant", "/admin/api/revoke-enrollment",
    ]));
    const { b: owner } = await settledOwner();
    const thief = new Browser("198.51.100.145");
    await enroll(thief, await bearerLink());
    for (const p of [...guarded, "/admin/api/approve-resume", "/admin/api/sign-out-everywhere"]) {
      const r = await thief.post(p, { handle: "x", client_id: "c", name: "n", redirect_uris: ["https://evil.example/cb"] });
      expect({ p, status: r.status, error: (await json(r)).error }).toEqual({ p, status: 403, error: "cooldown" });
    }
    expect(owner.signedIn()).toBe(true);
    expect(thief.signedIn()).toBe(true);
    const tool = await thief.post("/admin/api/tool", { name: "page_list", args: {} });
    expect(tool.status).not.toBe(403);
    expect((await thief.post("/admin/api/dismiss-resume")).status).toBe(200);
    // An operator session is never in cooldown.
    const op = await operator();
    expect((await op.post("/admin/api/enrollments", {})).status).not.toBe(403);
  });

  it("register/verify re-checks the step-up: options asked while fresh cannot be used once it lapses", async () => {
    const { b, soft } = await settledOwner();
    expect((await reauth(b, soft)).status).toBe(200);
    tick(4 * MIN);
    const opts = await registerOptions(b);
    tick(2 * MIN); // step-up over, challenge still within its 5 minutes
    const res = await b.post("/admin/api/passkey/register/verify", { response: new SoftAuthenticator(ORIGIN, RP_ID).register(opts), label: "Late" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "reauth_required" });
  });

  it("a cooldown session cannot rename a passkey; after the cooldown it can", async () => {
    const { soft: owner } = await settledOwner();
    const thief = new Browser("198.51.100.146");
    const { soft } = await enroll(thief, await bearerLink());
    const r = await thief.post("/admin/api/passkeys/rename", { id: owner.credentialId, label: "Old phone" });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "cooldown" });
    expect((await listPasskeys(storage.engine())).find((x) => x.id === owner.credentialId)!.label).toBe("Laptop");
    tick(25 * HOUR);
    const later = new Browser("198.51.100.147");
    expect((await login(later, soft)).status).toBe(200);
    expect((await later.post("/admin/api/passkeys/rename", { id: owner.credentialId, label: "Old phone" })).status).toBe(200);
  });

  it("an operator session past 10 minutes steps up with a passkey, or signs in again with the token", async () => {
    const { soft } = await settledOwner();
    const op = await operator();
    tick(11 * MIN);
    expect(await (await op.post("/admin/api/setup-links", {})).json()).toEqual({ error: "reauth_required" });
    expect((await reauth(op, soft)).status).toBe(200);
    expect((await op.post("/admin/api/setup-links", {})).status).toBe(200);
    const op2 = await operator();
    expect((await op2.post("/admin/api/setup-links", {})).status).toBe(200);
  });

  it("a recovery-code passkey is in cooldown too", async () => {
    const { codes } = await settledOwner();
    const b = new Browser("198.51.100.150");
    await b.post("/admin/api/passkey/recovery", { code: codes[1] });
    const opts = await registerOptions(b);
    expect((await b.post("/admin/api/passkey/register/verify", { response: new SoftAuthenticator(ORIGIN, RP_ID).register(opts) })).status).toBe(200);
    expect((await b.post("/admin/api/recovery-codes/regenerate")).status).toBe(403);
  });

  it("a recovery-code passkey is in cooldown even when no other passkey exists", async () => {
    const { soft, codes } = await settledOwner();
    const op = await operator();
    expect((await op.post("/admin/api/passkeys/revoke", { id: soft.credentialId, confirm_last: true })).status).toBe(200);
    const b = new Browser("198.51.100.152");
    expect((await b.post("/admin/api/passkey/recovery", { code: codes[2] })).status).toBe(200);
    const opts = await registerOptions(b);
    expect((await b.post("/admin/api/passkey/register/verify", { response: new SoftAuthenticator(ORIGIN, RP_ID).register(opts) })).status).toBe(200);
    const r = await b.post("/admin/api/api-keys", { name: "persist" });
    expect(r.status).toBe(403);
    expect((await r.json()) as Record<string, unknown>).toMatchObject({ error: "cooldown" });
  });
});

describe("notices", () => {
  it("the enrolling session cannot dismiss its own notice; an older credential and the operator can; acked rows stay listed", async () => {
    const { soft: owner } = await settledOwner();
    const thief = new Browser("198.51.100.160");
    await enroll(thief, await bearerLink());
    const mine = (await json(await thief.call("/admin/api/security/notices"))).notices as { ackable: boolean; event: string }[];
    expect(mine.filter((n) => n.event === "passkey.registered").map((n) => n.ackable)).toEqual([false]);
    tick(24 * HOUR + 1000);
    const ownerSession = new Browser("198.51.100.162");
    const res = await login(ownerSession, owner);
    expect(await res.json()).toEqual({ ok: true, notices: 1 });
    const seen = (await json(await ownerSession.call("/admin/api/security/notices"))).notices as { ackable: boolean }[];
    expect(seen.map((n) => n.ackable)).toEqual([true]);
    expect(await (await ownerSession.post("/admin/api/security/notices/ack")).json()).toEqual({ acknowledged: 1, refused: 0 });
    expect(((await json(await ownerSession.call("/admin/api/security/notices"))).notices as unknown[]).length).toBe(0);
    const all = (await json(await ownerSession.call("/admin/api/security/events?limit=200"))).events as { event: string; noticed_at: string | null }[];
    expect(all.find((x) => x.event === "passkey.registered" && x.noticed_at !== null)).toBeDefined();
  });

  it("the subject credential cannot ack its notice after its cooldown, the operator can", async () => {
    await settledOwner();
    const thief = new Browser("198.51.100.170");
    const { soft } = await enroll(thief, await bearerLink());
    tick(24 * HOUR + 1000);
    const again = new Browser("198.51.100.171");
    expect((await login(again, soft)).status).toBe(200);
    expect(await (await again.post("/admin/api/security/notices/ack")).json()).toEqual({ acknowledged: 0, refused: 1 });
    const op = await operator();
    expect(await (await op.post("/admin/api/security/notices/ack")).json()).toEqual({ acknowledged: 1, refused: 0 });
  });
});

describe("rate limits", () => {
  it("junk credential ids never slow a key; 5 known-credential failures slow only that key, for a fixed 15 minutes", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const stranger = new SoftAuthenticator(ORIGIN, RP_ID);
    const a = new Browser("198.51.100.180");
    // Well past the 5-failure threshold and inside the 30/min bucket; every
    // refusal also waits out the failure floor.
    for (let i = 0; i < 12; i++) {
      const opts = await loginOptions(a);
      expect((await a.post("/admin/api/passkey/login/verify", { response: stranger.assert(opts) })).status).toBe(401);
    }
    expect((await login(a, soft)).status).toBe(200);

    const bad = new Browser("198.51.100.181");
    for (let i = 0; i < 5; i++) expect((await login(bad, soft, { origin: "https://evil.example" })).status).toBe(401);
    const slowed = await login(bad, soft);
    expect(slowed.status).toBe(429);
    expect(await slowed.json()).toMatchObject({ error: "slowed" });
    expect((await login(new Browser("198.51.100.182"), soft)).status).toBe(200);
    // Attempts during the cooldown do not extend it.
    for (let i = 0; i < 4; i++) {
      tick(3 * MIN);
      expect((await login(bad, soft)).status).toBe(429);
    }
    tick(3 * MIN + 1000);
    expect((await login(bad, soft)).status).toBe(200);
  }, 120_000);

  it("a slowed client gets the same 429 for an unknown credential as for a known one", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const stranger = new SoftAuthenticator(ORIGIN, RP_ID);
    stranger.userHandle = soft.userHandle;
    const bad = new Browser("198.51.100.183");
    for (let i = 0; i < 5; i++) expect((await login(bad, soft, { origin: "https://evil.example" })).status).toBe(401);
    const known = await login(bad, soft);
    const unknown = await login(bad, stranger);
    expect(unknown.status).toBe(429);
    expect(await unknown.json()).toMatchObject({ error: "slowed" });
    expect((await known.json() as { error: string }).error).toBe("slowed");
  }, 30_000);

  it("redeem buckets are per client key and hold for a full hour; 429s write one row per window", async () => {
    const a = new Browser("198.51.100.190");
    for (let i = 0; i < 10; i++) expect((await a.post("/admin/api/passkey/enroll/redeem", { token: "A".repeat(43) })).status).toBe(400);
    expect((await a.post("/admin/api/passkey/enroll/redeem", { token: "A".repeat(43) })).status).toBe(429);
    for (let i = 0; i < 5; i++) await a.post("/admin/api/passkey/enroll/redeem", { token: "A".repeat(43) });
    tick(16 * MIN);
    expect((await a.post("/admin/api/passkey/enroll/redeem", { token: "A".repeat(43) })).status).toBe(429);
    const b = new Browser("198.51.100.191");
    await enroll(b, await bearerLink());
    expect(b.signedIn()).toBe(true);
    const rows = (await events()).filter((x) => x.event === "rate_limited");
    expect(rows).toHaveLength(2); // one per 10-minute window, not one per refusal
  });
});

describe("callers without a trusted client IP", () => {
  it("a burst of login options from one of them does not stop another from signing in", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const flood = new Browser(null);
    for (let i = 0; i < 100; i++) expect((await flood.post("/admin/api/passkey/login/options")).status).toBe(200);
    expect((await login(new Browser(null), soft)).status).toBe(200);
  });

  it("failed checks against a known credential do not slow the shared key", async () => {
    const { soft } = await enroll(new Browser(), await bearerLink());
    const bad = new Browser(null);
    for (let i = 0; i < 5; i++) expect((await login(bad, soft, { origin: "https://evil.example" })).status).toBe(401);
    expect((await login(new Browser(null), soft)).status).toBe(200);
  });
});

describe("same-origin checks on existing admin routes", () => {
  it("an http Origin is refused when the configured origin is https, on a data POST and on sign-out-everywhere", async () => {
    const http = new Browser("203.0.113.30", INTERNAL);
    expect((await http.post("/admin/login", { token: BOOT })).status).toBe(200);
    for (const p of ["/admin/api/api-keys", "/admin/api/sign-out-everywhere"]) {
      const r = await http.post(p, { name: "k" });
      expect({ p, status: r.status }).toEqual({ p, status: 403 });
    }
    expect(http.signedIn()).toBe(true);
    const https = new Browser("203.0.113.30", ORIGIN);
    https.jar = new Map(http.jar);
    expect((await https.post("/admin/api/api-keys", { name: "k" })).status).not.toBe(403);
  });
});

describe("sign-out-everywhere", () => {
  it("ends passkey sessions, drops pending grants and challenges, revokes unused setup links; cross-origin is refused", async () => {
    const { b, soft } = await settledOwner();
    const pending = new Browser("198.51.100.200");
    const unused = await bearerLink();
    const token = await bearerLink();
    expect((await pending.post("/admin/api/passkey/enroll/redeem", { token })).status).toBe(200);
    const regOpts = await registerOptions(pending);
    const loginB = new Browser("198.51.100.201");
    const lo = await loginOptions(loginB);

    const cross = new Browser("198.51.100.202", "https://evil.example");
    cross.jar = new Map(b.jar);
    expect((await cross.post("/admin/api/sign-out-everywhere")).status).toBe(403);
    expect(b.signedIn()).toBe(true);

    const res = await b.post("/admin/api/sign-out-everywhere");
    expect(res.status).toBe(200);
    expect(b.signedIn()).toBe(false);
    expect((await pending.post("/admin/api/passkey/register/verify", { response: new SoftAuthenticator(ORIGIN, RP_ID).register(regOpts) })).status).toBe(401);
    expect((await loginB.post("/admin/api/passkey/login/verify", { response: soft.assert(lo) })).status).toBe(401);
    expect((await new Browser("198.51.100.203").post("/admin/api/passkey/enroll/redeem", { token: unused })).status).toBe(400);
    expect((await events()).some((x) => x.event === "setup_link.revoked")).toBe(true);
  });

  it("a login paused after its challenge was taken cannot create a session after it", async () => {
    const { b, soft } = await settledOwner();
    const late = new Browser("198.51.100.204");
    const opts = await loginOptions(late);
    const gate = gateQuery(/UPDATE admin_passkeys SET counter/);
    try {
      const res = await signOutDuring(b, gate, late.post("/admin/api/passkey/login/verify", { response: soft.assert(opts) }));
      expect(res.status).toBe(401);
      expect(late.signedIn()).toBe(false);
      expect((await events()).some((x) => x.event === "passkey.login_failed" && x.reason === "signed_out")).toBe(true);
    } finally {
      gate.restore();
    }
  });

  it("waits for an enrolment in its insert, then ends the session it minted", async () => {
    await settledOwner();
    const op = await operator();
    const late = new Browser("198.51.100.205");
    expect((await late.post("/admin/api/passkey/enroll/redeem", { token: await bearerLink() })).status).toBe(200);
    const opts = await registerOptions(late);
    const gate = gateQuery(/SELECT count\(\*\)::int AS n FROM admin_recovery_codes WHERE used_at IS NULL/);
    try {
      const { res, waited } = await signOutWhilePaused(op, gate, late.post("/admin/api/passkey/register/verify", { response: new SoftAuthenticator(ORIGIN, RP_ID).register(opts) }));
      expect(waited).toBe(true);
      expect(res.status).toBe(200);
      expect(late.signedIn()).toBe(false);
    } finally {
      gate.restore();
    }
  });

  it("waits for a recovery-code replacement; the old session gets 401 afterwards", async () => {
    const { soft } = await settledOwner();
    const op = await operator();
    const a = await steppedUpSession(soft, "198.51.100.208");
    const gate = gateQuery(/DELETE FROM admin_recovery_codes/);
    try {
      const { res, waited } = await signOutWhilePaused(op, gate, a.post("/admin/api/recovery-codes/regenerate"));
      expect(waited).toBe(true);
      expect(res.status).toBe(200);
    } finally {
      gate.restore();
    }
    expect(a.signedIn()).toBe(false);
    expect((await a.post("/admin/api/recovery-codes/regenerate")).status).toBe(401);
  });

  it("waits for a panel setup-link mint, then revokes that link; the old session gets 401 afterwards", async () => {
    const { soft } = await settledOwner();
    const op = await operator();
    const a = await steppedUpSession(soft, "198.51.100.209");
    const gate = gateQuery(/INSERT INTO admin_setup_links/);
    try {
      const { res, waited } = await signOutWhilePaused(op, gate, a.post("/admin/api/setup-links", {}));
      expect(waited).toBe(true);
      expect(res.status).toBe(200);
    } finally {
      gate.restore();
    }
    const live = await storage.engine().query(`SELECT id FROM admin_setup_links WHERE used_at IS NULL AND revoked_at IS NULL`);
    expect(live.rows).toEqual([]);
    expect((await a.post("/admin/api/setup-links", {})).status).toBe(401);
  });

  it("waits for a passkey revoke; the old session gets 401 afterwards", async () => {
    const { soft } = await settledOwner();
    const op = await operator();
    const a = await steppedUpSession(soft, "198.51.100.212");
    const gate = gateQuery(/DELETE FROM admin_passkeys/);
    try {
      const { res, waited } = await signOutWhilePaused(op, gate, a.post("/admin/api/passkeys/revoke", { id: soft.credentialId, confirm_last: true }));
      expect(waited).toBe(true);
      expect(res.status).toBe(200);
    } finally {
      gate.restore();
    }
    expect((await a.post("/admin/api/passkeys/revoke", { id: "x" })).status).toBe(401);
  });

  it("waits for a step-up; the session it marked is gone afterwards", async () => {
    const { soft } = await settledOwner();
    const op = await operator();
    const a = new Browser("198.51.100.213");
    expect((await login(a, soft)).status).toBe(200);
    const opts = ((await (await a.post("/admin/api/passkey/reauth/options")).json()) as { optionsJSON: PublicKeyCredentialRequestOptionsJSON }).optionsJSON;
    const gate = gateQuery(/INSERT INTO admin_auth_events/);
    try {
      const { res, waited } = await signOutWhilePaused(op, gate, a.post("/admin/api/passkey/reauth/verify", { response: soft.assert(opts) }));
      expect(waited).toBe(true);
      expect(res.status).toBe(200);
    } finally {
      gate.restore();
    }
    expect(a.signedIn()).toBe(false);
  });

  it("releases recovery codes even when revoking setup links fails", async () => {
    const { b, codes } = await settledOwner();
    expect((await new Browser("198.51.100.210").post("/admin/api/passkey/recovery", { code: codes[7] })).status).toBe(200);
    const gate = gateQuery(/UPDATE admin_setup_links SET revoked_at/, true);
    try {
      expect((await b.post("/admin/api/sign-out-everywhere")).status).toBe(200);
    } finally {
      gate.restore();
    }
    expect((await new Browser("198.51.100.211").post("/admin/api/passkey/recovery", { code: codes[7] })).status).toBe(200);
  });

  it("releases recovery codes reserved before it", async () => {
    const { b, codes } = await settledOwner();
    expect((await new Browser("198.51.100.206").post("/admin/api/passkey/recovery", { code: codes[6] })).status).toBe(200);
    expect((await b.post("/admin/api/sign-out-everywhere")).status).toBe(200);
    expect((await new Browser("198.51.100.207").post("/admin/api/passkey/recovery", { code: codes[6] })).status).toBe(200);
  });

  it("voids magic links minted before it", async () => {
    const { b } = await settledOwner();
    const mint = await auth.handleAuthRoute(
      new Request(`${INTERNAL}/admin/api/issue-magic-link`, { method: "POST", headers: { authorization: `Bearer ${BOOT}` } }),
      new URL(`${INTERNAL}/admin/api/issue-magic-link`),
    );
    const link = new URL(((await mint!.json()) as { url: string }).url);
    expect((await b.post("/admin/api/sign-out-everywhere")).status).toBe(200);
    const redeemed = await auth.handleAuthRoute(new Request(`${INTERNAL}${link.pathname}`), link);
    expect(redeemed!.status).toBe(401);
    expect(redeemed!.headers.getSetCookie()).toEqual([]);
  });
});
