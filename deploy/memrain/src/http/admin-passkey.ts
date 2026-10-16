/**
 * http/admin-passkey.ts — passkey sign-in for the admin panel.
 *
 * Routes under /admin/api/passkey/*, /admin/api/passkeys*, /admin/api/recovery-codes/*,
 * /admin/api/setup-links and /admin/api/security/*. The bootstrap token and the
 * magic link (http/admin.ts) are untouched and stay the operator's way in.
 *
 * What holds it together:
 *   - The relying party comes from MEMRAIN_PUBLIC_URL only (core/webauthn-config.ts).
 *     Unset → every route but `status` answers 503.
 *   - Every POST checks the request `Origin` against that configured origin
 *     exactly, reads its body under a 16 KiB cap and takes JSON only.
 *   - Challenges are generated here, held here, bound to one browser (a
 *     pre-auth cookie) or one session, used once (taken out before verifying)
 *     and expire after 5 minutes. A challenge echoed by the client is never
 *     trusted.
 *   - A setup link or recovery code is a credential to ENROLL, not to sign in.
 *     Redeeming one reserves it for this browser for 15 minutes and yields an
 *     enroll-only grant; the link or code is consumed only when the passkey is
 *     stored. A grant is not a session.
 *   - Rate limits protect CPU and the database, not the secrets (those are 120
 *     and 256 bits). They are per client key only, so nobody can drain a shared
 *     bucket to lock the owner out, and the login slowdown counts only failed
 *     checks against a known credential, with a fixed cooldown. Callers with no
 *     trustworthy client IP share one key, which the owner is part of, so it
 *     gets a much larger bucket and no slowdown.
 *   - A passkey created through a setup link or a recovery code spends its
 *     first 24 hours in a cooldown: its sessions can use the panel but cannot
 *     acknowledge notices, revoke passkeys, replace recovery codes, mint links,
 *     add passkeys, sign out everywhere, approve OAuth requests or change any
 *     agent's access (http/admin-api.ts refuses every data POST but one). Someone who stole a link cannot
 *     erase the warning or lock the owner out in that window.
 *
 * Uses @simplewebauthn/server for every WebAuthn decode and verification.
 */
import { randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Engine } from "../core/engine/interface.ts";
import {
  ackNotices,
  countPasskeys,
  credentialHash,
  deletePasskeyChecked,
  getPasskey,
  insertPasskeyForSession,
  insertPasskeyWithGrant,
  listAuthEvents,
  listPasskeys,
  mintSetupLink,
  ownerHandle,
  PasskeyStoreError,
  pendingNotices,
  pruneFailureEvents,
  recordAuthEvent,
  renamePasskey,
  replaceRecoveryCodes,
  reserveRecoveryCode,
  reserveSetupLink,
  sha256Hex,
  unusedRecoveryCount,
  updateCounterCas,
  type AuthEventInput,
  type AuthEventRecord,
  type EnrollGrantRef,
  type NewPasskey,
  type PasskeyCreatedVia,
  type PasskeyRecord,
} from "../core/admin-passkey-store.ts";
import { isRelyingParty, resolveRelyingParty, type RelyingParty } from "../core/webauthn-config.ts";
import { RateLimiter } from "../mcp/rate_limit.ts";
import { readBodyWithCap } from "./body_limit.ts";
import { resolveClientKey } from "./client-key.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const PASSKEY_SESSION_TTL_MS = 12 * HOUR;
export const REAUTH_WINDOW_MS = 5 * MINUTE;
export const ENROLL_COOLDOWN_MS = 24 * HOUR;
const CHALLENGE_TTL_MS = 5 * MINUTE;
const GRANT_TTL_MS = 15 * MINUTE;
const PREAUTH_MAX_AGE_S = 900;
const BODY_CAP = 16 * 1024;
const RESPONSE_CAP = 12 * 1024;
const MAP_CAP = 1000;
const SETUP_LINK_DEFAULT_HOURS = 24;
const SETUP_LINK_MAX_HOURS = 72;
const SLOWDOWN_FAILS = 5;
const SLOWDOWN_WINDOW_MS = 15 * MINUTE;
const SLOWDOWN_COOLDOWN_MS = 15 * MINUTE;
const RATE_AUDIT_WINDOW_MS = 10 * MINUTE;
const VOLUME_CEILING_PER_HOUR = 6000;
const PRUNE_EVERY = 100;
const SUPPORTED_ALGS = [-7, -257];
const COOKIE_PREAUTH_HTTPS = "__Host-memrain_preauth";
const COOKIE_PREAUTH_HTTP = "memrain_preauth";
/** What resolveClientKey returns for a caller without a trustworthy IP. */
const SHARED_KEY = "internal";

export type SessionKind = "bootstrap" | "magic" | "passkey";

export interface SessionCred {
  id: string;
  createdVia: PasskeyCreatedVia;
  /** The owner's first passkey from a setup link; exempt from the cooldown. */
  initial?: boolean;
  createdAt: number;
}

export interface AdminSession {
  exp: number;
  kind: SessionKind;
  reauthUntil: number;
  cred?: SessionCred;
}

export interface SessionApi {
  /** Mint a session, append its Set-Cookie headers, return its id. */
  create(req: Request, headers: Headers, kind: SessionKind, ttlMs: number, cred?: SessionCred): string;
  /** The session the request carries, resolved exactly as requireAdmin does. */
  sessionOf(req: Request): { id: string; session: AdminSession } | null;
  markReauth(sessionId: string, untilMs: number): void;
  /** Delete every session signed in with this credential; returns their ids. */
  deleteForCredential(credentialId: string): string[];
}

export interface PasskeyRouteDeps {
  engine: () => Engine;
  publicUrl: string | undefined;
  sessionApi: SessionApi;
  bootstrapBearerOk: (req: Request) => boolean;
  allowBootstrapAttempt: (req: Request) => boolean;
}

export interface PasskeyRoutes {
  handle(req: Request, url: URL): Promise<Response | null>;
  /** Forget every pending challenge and grant (sign-out-everywhere). */
  clearEphemeral(): void;
}

/** When a session's cooldown ends, or null when it has none. */
export function cooldownUntil(s: AdminSession, now: number = Date.now()): number | null {
  if (s.kind !== "passkey" || !s.cred || s.cred.createdVia === "session" || s.cred.initial === true) return null;
  const until = s.cred.createdAt + ENROLL_COOLDOWN_MS;
  return now < until ? until : null;
}

interface Challenge {
  challenge: string;
  purpose: "register" | "login" | "reauth";
  exp: number;
}

interface Grant {
  source: "setup_link" | "recovery";
  ref: string;
  preauthHash: string;
  exp: number;
}

type BearerState = "none" | "ok" | "bad" | "throttled";

interface Ctx {
  req: Request;
  url: URL;
  rp: RelyingParty;
  clientKey: string;
  bearer: () => BearerState;
}

const PATHS = new Set([
  "/admin/api/passkey/status",
  "/admin/api/passkey/enroll/redeem",
  "/admin/api/passkey/recovery",
  "/admin/api/passkey/register/options",
  "/admin/api/passkey/register/verify",
  "/admin/api/passkey/login/options",
  "/admin/api/passkey/login/verify",
  "/admin/api/passkey/reauth/options",
  "/admin/api/passkey/reauth/verify",
  "/admin/api/passkeys",
  "/admin/api/passkeys/rename",
  "/admin/api/passkeys/revoke",
  "/admin/api/recovery-codes/regenerate",
  "/admin/api/setup-links",
  "/admin/api/security/events",
  "/admin/api/security/notices",
  "/admin/api/security/notices/ack",
]);

const err = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: Headers): Response =>
  Response.json({ error, ...extra }, { status, ...(headers ? { headers } : {}) });

const isoOrNull = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function readCookieValues(req: Request, name: string): string[] {
  const raw = req.headers.get("cookie");
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Map a SimpleWebAuthn verification error to an audit reason code. */
function reasonOf(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/counter value/i.test(m)) return "counter_regression";
  if (/challenge/i.test(m)) return "bad_challenge";
  if (/RP ID|rpID/i.test(m)) return "bad_rpid";
  if (/origin/i.test(m)) return "bad_origin";
  if (/user verification|could not be verified/i.test(m)) return "no_uv";
  return "invalid";
}

/**
 * At most `limit` attempts per key in any trailing hour. Unlike a token bucket
 * (mcp/rate_limit.ts), idling part of the hour earns nothing back, and an idle
 * key is not evicted early.
 */
class HourWindow {
  private hits = new Map<string, number[]>();

  constructor(private readonly limit: number) {}

  allow(key: string, t: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < HOUR);
    this.hits.delete(key);
    const ok = recent.length < this.limit;
    if (ok) recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > MAP_CAP * 10) this.hits.delete(this.hits.keys().next().value as string);
    return ok;
  }
}

export function createPasskeyRoutes(deps: PasskeyRouteDeps): PasskeyRoutes {
  const challenges = new Map<string, Challenge>();
  const grants = new Map<string, Grant>();
  const passkeyLimiter = new RateLimiter({ capacity: 30, refillPerSecond: 30 / 60 });
  // The "internal" key is every caller of an install without a trustworthy
  // client IP, owner included, so its bucket is far larger (OD-4).
  const sharedPasskeyLimiter = new RateLimiter({ capacity: 600, refillPerSecond: 10 });
  const secretLimiter = new HourWindow(10);
  // Every caller without a trustworthy client IP shares the "internal" key. A
  // 10/hour cap there would be an install-wide lockout, so that key gets more.
  const sharedSecretLimiter = new HourWindow(200);
  const slowdown = new Map<string, { fails: number[]; until: number }>();
  const rateAudit = new Map<string, number>();
  const volume = { windowStart: 0, count: 0, warned: false };
  let failuresSincePrune = 0;

  const now = (): number => Date.now();
  const preauthName = (rp: RelyingParty): string =>
    rp.origin.startsWith("https:") ? COOKIE_PREAUTH_HTTPS : COOKIE_PREAUTH_HTTP;

  function readPreauth(req: Request, rp: RelyingParty): string | null {
    // On https only the __Host- name is read: an unprefixed cookie can be
    // planted by a sibling host, the prefixed one cannot.
    const v = readCookieValues(req, preauthName(rp))[0];
    return v !== undefined && /^[0-9a-f]{64}$/.test(v) ? v : null;
  }

  function preauthCookie(rp: RelyingParty, value: string | null): string {
    const https = rp.origin.startsWith("https:");
    const attrs = [
      `${preauthName(rp)}=${value ?? ""}`,
      https ? "Path=/" : "Path=/admin",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${value ? PREAUTH_MAX_AGE_S : 0}`,
    ];
    if (https) attrs.push("Secure");
    return attrs.join("; ");
  }

  function prune(): void {
    const t = now();
    for (const [k, c] of challenges) if (c.exp < t) challenges.delete(k);
    for (const [k, g] of grants) if (g.exp < t) grants.delete(k);
    for (const map of [challenges, grants] as Map<string, unknown>[]) {
      if (map.size <= MAP_CAP) continue;
      const it = map.keys();
      for (let i = map.size - MAP_CAP; i > 0; i--) map.delete(it.next().value as string);
    }
  }

  function putChallenge(key: string, c: Challenge): void {
    prune();
    challenges.delete(key);
    challenges.set(key, c);
  }

  /** Take-and-delete: a challenge is gone the moment anyone presents it. */
  function takeChallenge(key: string, purpose: Challenge["purpose"]): Challenge | null {
    const c = challenges.get(key);
    challenges.delete(key);
    if (!c || c.exp < now() || c.purpose !== purpose) return null;
    return c;
  }

  function liveGrant(preauth: string | null): Grant | null {
    if (!preauth) return null;
    const g = grants.get(preauth);
    if (!g) return null;
    if (g.exp < now()) {
      grants.delete(preauth);
      return null;
    }
    return g;
  }

  async function audit(ctx: Ctx | null, ev: AuthEventInput): Promise<void> {
    try {
      await recordAuthEvent(deps.engine(), {
        ...ev,
        clientKey: ev.clientKey ?? ctx?.clientKey ?? null,
        userAgent: ev.userAgent ?? ctx?.req.headers.get("user-agent") ?? null,
        at: ev.at ?? now(),
      });
      if (ev.outcome === "fail" && ++failuresSincePrune >= PRUNE_EVERY) {
        failuresSincePrune = 0;
        await pruneFailureEvents(deps.engine());
      }
    } catch (e) {
      console.error("[admin-passkey] audit write failed:", e instanceof Error ? e.message : e);
    }
  }

  /** One aggregate row per (route, client key) per window, not one per 429. */
  async function limited(ctx: Ctx, route: string, retryAfter?: number): Promise<Response> {
    const key = `${route}|${ctx.clientKey}`;
    const t = now();
    const last = rateAudit.get(key);
    if (last === undefined || t - last >= RATE_AUDIT_WINDOW_MS) {
      rateAudit.set(key, t);
      if (rateAudit.size > MAP_CAP * 10) rateAudit.delete(rateAudit.keys().next().value as string);
      await audit(ctx, { event: "rate_limited", outcome: "fail", reason: route });
    }
    const headers = new Headers();
    if (retryAfter !== undefined) headers.set("Retry-After", String(retryAfter));
    return err(429, "rate_limited", retryAfter !== undefined ? { retry_after: retryAfter } : {}, headers);
  }

  /** Log-only volumetric ceiling across all passkey routes. Never refuses. */
  async function countVolume(ctx: Ctx): Promise<void> {
    const t = now();
    if (t - volume.windowStart >= HOUR) {
      volume.windowStart = t;
      volume.count = 0;
      volume.warned = false;
    }
    volume.count++;
    if (volume.count > VOLUME_CEILING_PER_HOUR && !volume.warned) {
      volume.warned = true;
      console.warn(`[admin-passkey] more than ${VOLUME_CEILING_PER_HOUR} passkey requests in the last hour`);
      await audit(ctx, { event: "rate_limited", outcome: "fail", reason: "volume" });
    }
  }

  function allowPasskey(ctx: Ctx): boolean {
    return (ctx.clientKey === SHARED_KEY ? sharedPasskeyLimiter : passkeyLimiter).allow(ctx.clientKey);
  }

  function slowedUntil(key: string): number {
    const s = slowdown.get(key);
    return s && s.until > now() ? s.until : 0;
  }

  /** Count a failed check against a KNOWN credential. Attempts made during a
   *  cooldown are refused before they get here, so they cannot extend it. */
  function countKnownFailure(key: string): void {
    // The shared key is the owner too; slowing it would let anyone holding a
    // credential id slow every passkey sign-in of the install.
    if (key === SHARED_KEY) return;
    const t = now();
    const s = slowdown.get(key) ?? { fails: [], until: 0 };
    s.fails = s.fails.filter((f) => t - f < SLOWDOWN_WINDOW_MS);
    s.fails.push(t);
    if (s.fails.length >= SLOWDOWN_FAILS) {
      s.until = t + SLOWDOWN_COOLDOWN_MS;
      s.fails = [];
    }
    slowdown.delete(key);
    slowdown.set(key, s);
    if (slowdown.size > MAP_CAP * 10) slowdown.delete(slowdown.keys().next().value as string);
  }

  function originAllowed(ctx: Ctx): boolean | "throttled" {
    const origin = ctx.req.headers.get("origin");
    if (origin !== null) return origin === ctx.rp.origin;
    const site = ctx.req.headers.get("sec-fetch-site");
    if (site !== null) return site === "same-origin";
    // Neither header: not a browser (every browser POST carries Origin). Only
    // a bootstrap-bearer caller may come this way; the route checks the token.
    const b = ctx.bearer();
    return b === "throttled" ? "throttled" : b !== "none";
  }

  /** Origin → body cap → JSON content type → parse. */
  async function readPost(ctx: Ctx): Promise<Record<string, unknown> | Response> {
    const allowed = originAllowed(ctx);
    if (allowed === "throttled") return limited(ctx, "bootstrap");
    if (!allowed) return err(403, "cross_origin");
    const read = await readBodyWithCap(ctx.req, BODY_CAP);
    if (!read.ok) return read.response;
    const ct = (ctx.req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (ct !== "application/json") {
      // Automation with the bootstrap bearer may POST with no body at all;
      // the route itself decides whether the token is good.
      if (read.buf.length === 0 && ctx.bearer() !== "none") return {};
      return err(415, "json_required");
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(read.buf));
    } catch {
      return err(400, "invalid_body");
    }
    if (!isPlainObject(body)) return err(400, "invalid_body");
    return body;
  }

  function sessionFresh(s: AdminSession): Promise<boolean> | boolean {
    if (s.reauthUntil > now()) return true;
    if (s.kind === "passkey") return false;
    // An operator session before any passkey exists has nothing to step up with.
    return countPasskeys(deps.engine()).then((n) => n === 0);
  }

  function cooldownResponse(until: number): Response {
    return err(403, "cooldown", { until: new Date(until).toISOString() });
  }

  function responseField(body: Record<string, unknown>): Record<string, unknown> | null {
    const r = body.response;
    if (!isPlainObject(r)) return null;
    if (JSON.stringify(r).length > RESPONSE_CAP) return null;
    if (typeof r.id !== "string" || r.id.length === 0 || r.id.length > 1024) return null;
    return r;
  }

  function labelField(v: unknown, fallback: string | null): string | null {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length >= 1 && t.length <= 64 ? t : null;
  }

  // ---- routes -------------------------------------------------------------

  async function status(): Promise<Response> {
    const rp = resolveRelyingParty(deps.publicUrl);
    return Response.json(isRelyingParty(rp) ? { available: true } : { available: false, reason: rp.error });
  }

  async function redeemOrRecover(ctx: Ctx, kind: "setup_link" | "recovery"): Promise<Response> {
    const body = await readPost(ctx);
    if (body instanceof Response) return body;
    const field = kind === "setup_link" ? body.token : body.code;
    const max = kind === "setup_link" ? 64 : 40;
    const generic = kind === "setup_link" ? "invalid_token" : "invalid_code";
    if (typeof field !== "string" || field.length === 0 || field.length > max) return err(400, generic);
    const limiter = ctx.clientKey === SHARED_KEY ? sharedSecretLimiter : secretLimiter;
    if (!limiter.allow(ctx.clientKey, now())) return limited(ctx, kind === "setup_link" ? "redeem" : "recovery");

    const preauth = readPreauth(ctx.req, ctx.rp) ?? randomBytes(32).toString("hex");
    const preauthHash = sha256Hex(preauth);
    const until = now() + GRANT_TTL_MS;
    const e = deps.engine();
    const r = kind === "setup_link"
      ? await reserveSetupLink(e, field, preauthHash, until, now())
      : await reserveRecoveryCode(e, field, preauthHash, until, now());
    if (!r.ok) {
      await audit(ctx, {
        event: kind === "setup_link" ? "setup_link.redeem_failed" : "recovery.failed",
        outcome: "fail",
        reason: r.reason,
      });
      return err(400, generic);
    }
    grants.set(preauth, { source: kind, ref: r.ref, preauthHash, exp: until });
    prune();
    await audit(ctx, {
      event: kind === "setup_link" ? "setup_link.redeemed" : "recovery.used",
      outcome: "ok",
      via: kind,
    });
    const headers = new Headers({ "Set-Cookie": preauthCookie(ctx.rp, preauth) });
    return Response.json({ ok: true, expires_in: GRANT_TTL_MS / 1000 }, { headers });
  }

  async function registerOptions(ctx: Ctx): Promise<Response> {
    const body = await readPost(ctx);
    if (body instanceof Response) return body;
    if (!allowPasskey(ctx)) return limited(ctx, "register");
    const preauth = readPreauth(ctx.req, ctx.rp);
    const grant = liveGrant(preauth);
    let key: string;
    if (grant) {
      key = `p:${preauth}`;
    } else {
      const s = deps.sessionApi.sessionOf(ctx.req);
      if (!s) return err(401, "Admin authentication required");
      const cd = cooldownUntil(s.session);
      if (cd !== null) return cooldownResponse(cd);
      if (!(await sessionFresh(s.session))) return err(403, "reauth_required");
      key = `s:${s.id}`;
    }
    const e = deps.engine();
    const handle = await ownerHandle(e);
    const existing = await listPasskeys(e);
    const optionsJSON = await generateRegistrationOptions({
      rpName: ctx.rp.rpName,
      rpID: ctx.rp.rpID,
      userName: `admin@${ctx.rp.rpID}`,
      userDisplayName: "memrain admin",
      userID: isoBase64URL.toBuffer(handle),
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: SUPPORTED_ALGS,
      timeout: CHALLENGE_TTL_MS,
    });
    putChallenge(key, { challenge: optionsJSON.challenge, purpose: "register", exp: now() + CHALLENGE_TTL_MS });
    return Response.json({ optionsJSON });
  }

  async function registerVerify(ctx: Ctx): Promise<Response> {
    const body = await readPost(ctx);
    if (body instanceof Response) return body;
    const response = responseField(body);
    const label = labelField(body.label, "Passkey");
    if (!response || label === null) return err(400, "invalid_body");
    if (!allowPasskey(ctx)) return limited(ctx, "register");

    const preauth = readPreauth(ctx.req, ctx.rp);
    const grant = liveGrant(preauth);
    let challenge: Challenge | null;
    let via: PasskeyCreatedVia;
    let session: { id: string; session: AdminSession } | null = null;
    if (grant) {
      challenge = takeChallenge(`p:${preauth}`, "register");
      via = grant.source;
    } else {
      session = deps.sessionApi.sessionOf(ctx.req);
      if (!session) return err(401, "Admin authentication required");
      // Keyed by session id, and sessionOf sees only live sessions: a
      // challenge outlives neither its session nor a sign-out-everywhere.
      challenge = takeChallenge(`s:${session.id}`, "register");
      const cd = cooldownUntil(session.session);
      if (challenge && cd !== null) return cooldownResponse(cd);
      // The challenge outlives the step-up; options asked just before it
      // lapsed must not stretch it by another five minutes.
      if (challenge && !(await sessionFresh(session.session))) return err(403, "reauth_required");
      via = "session";
    }
    if (!challenge) {
      await audit(ctx, { event: "passkey.register_failed", outcome: "fail", reason: "bad_challenge", via });
      return err(401, "passkey_failed");
    }

    let info;
    try {
      const v = await verifyRegistrationResponse({
        response: response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: ctx.rp.origin,
        expectedRPID: ctx.rp.rpID,
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: SUPPORTED_ALGS,
      });
      if (!v.verified) throw new Error("not verified");
      info = v.registrationInfo;
    } catch (e) {
      await audit(ctx, { event: "passkey.register_failed", outcome: "fail", reason: reasonOf(e), via });
      return err(401, "passkey_failed");
    }

    const transports = info.credential.transports
      ?? (Array.isArray((response.response as Record<string, unknown> | undefined)?.transports)
        ? ((response.response as Record<string, unknown>).transports as unknown[]).filter((t): t is string => typeof t === "string")
        : []);
    const row: NewPasskey = {
      id: info.credential.id,
      publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
      counter: info.credential.counter,
      transports: transports.slice(0, 8),
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      aaguid: info.aaguid,
      label,
      createdVia: via,
    };
    const e = deps.engine();
    const createdAt = now();
    let result;
    try {
      result = grant
        ? await insertPasskeyWithGrant(e, row, { source: grant.source, ref: grant.ref, preauthHash: grant.preauthHash } as EnrollGrantRef, createdAt)
        : await insertPasskeyForSession(e, row, createdAt);
    } catch (e2) {
      if (e2 instanceof PasskeyStoreError && (e2.code === "credential_exists" || e2.code === "grant_lost")) {
        await audit(ctx, { event: "passkey.register_failed", outcome: "fail", reason: e2.code, via });
        if (e2.code === "grant_lost" && preauth) grants.delete(preauth);
        return err(e2.code === "credential_exists" ? 409 : 410, e2.code);
      }
      throw e2;
    }
    // No owner existed to warn about the very first passkey, and a passkey the
    // signed-in owner added is not news to them.
    const notice = via !== "session" && !(via === "setup_link" && result.first);
    await audit(ctx, {
      event: "passkey.registered",
      outcome: "ok",
      via,
      credential: credentialHash(row.id),
      notice,
      at: createdAt,
    });
    const headers = new Headers();
    if (grant && preauth) {
      grants.delete(preauth);
      challenges.delete(`p:${preauth}`);
      headers.append("Set-Cookie", preauthCookie(ctx.rp, null));
      deps.sessionApi.create(ctx.req, headers, "passkey", PASSKEY_SESSION_TTL_MS, {
        id: row.id,
        createdVia: via,
        initial: result.initial,
        createdAt,
      });
    }
    return Response.json(
      {
        ok: true,
        passkey: { id: row.id, label: row.label },
        ...(result.recoveryCodes ? { recovery_codes: result.recoveryCodes } : {}),
      },
      { headers },
    );
  }

  async function loginOptions(ctx: Ctx): Promise<Response> {
    const body = await readPost(ctx);
    if (body instanceof Response) return body;
    if (!allowPasskey(ctx)) return limited(ctx, "login");
    const preauth = readPreauth(ctx.req, ctx.rp) ?? randomBytes(32).toString("hex");
    const optionsJSON = await generateAuthenticationOptions({
      rpID: ctx.rp.rpID,
      userVerification: "required",
      allowCredentials: [],
      timeout: CHALLENGE_TTL_MS,
    });
    putChallenge(`p:${preauth}`, { challenge: optionsJSON.challenge, purpose: "login", exp: now() + CHALLENGE_TTL_MS });
    return Response.json({ optionsJSON }, { headers: { "Set-Cookie": preauthCookie(ctx.rp, preauth) } });
  }

  /**
   * Verify an assertion against a stored credential, then advance its counter.
   * Returns the credential, or an audit reason.
   */
  async function verifyAssertion(
    ctx: Ctx,
    response: Record<string, unknown>,
    challenge: Challenge,
    row: PasskeyRecord,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const e = deps.engine();
    const handle = await ownerHandle(e);
    const userHandle = (response.response as Record<string, unknown> | undefined)?.userHandle;
    if (typeof userHandle === "string" && userHandle !== handle) return { ok: false, reason: "user_handle_mismatch" };
    let newCounter: number;
    try {
      const v = await verifyAuthenticationResponse({
        response: response as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: ctx.rp.origin,
        expectedRPID: ctx.rp.rpID,
        credential: { id: row.id, publicKey: isoBase64URL.toBuffer(row.publicKey), counter: row.counter, transports: row.transports as never },
        requireUserVerification: true,
      });
      if (!v.verified) return { ok: false, reason: "invalid" };
      newCounter = v.authenticationInfo.newCounter;
    } catch (e2) {
      return { ok: false, reason: reasonOf(e2) };
    }
    // A counter that did not move forward already threw above (synced
    // passkeys report 0 forever and pass). The compare-and-set refuses a
    // sign-in that raced another one past the same stored value.
    if (!(await updateCounterCas(e, row.id, row.counter, newCounter, now()))) {
      return { ok: false, reason: "counter_race" };
    }
    return { ok: true };
  }

  async function loginVerify(ctx: Ctx): Promise<Response> {
    const body = await readPost(ctx);
    if (body instanceof Response) return body;
    const response = responseField(body);
    if (!response) return err(400, "invalid_body");
    if (!allowPasskey(ctx)) return limited(ctx, "login");
    const preauth = readPreauth(ctx.req, ctx.rp);
    const challenge = preauth ? takeChallenge(`p:${preauth}`, "login") : null;
    if (!challenge) {
      await audit(ctx, { event: "passkey.login_failed", outcome: "fail", reason: "bad_challenge" });
      return err(401, "passkey_failed");
    }
    const e = deps.engine();
    const row = await getPasskey(e, response.id as string);
    if (!row) {
      // Not counted toward the slowdown: junk ids must not lock out a real key.
      await audit(ctx, { event: "passkey.login_failed", outcome: "fail", reason: "unknown_credential" });
      return err(401, "passkey_failed");
    }
    const until = slowedUntil(ctx.clientKey);
    if (until > 0) {
      const retry = Math.max(1, Math.ceil((until - now()) / 1000));
      await audit(ctx, { event: "passkey.login_failed", outcome: "fail", reason: "slowed" });
      return Response.json({ error: "slowed", retry_after: retry }, { status: 429, headers: { "Retry-After": String(retry) } });
    }
    const cred = credentialHash(row.id);
    const r = await verifyAssertion(ctx, response, challenge, row);
    if (!r.ok) {
      countKnownFailure(ctx.clientKey);
      const regression = r.reason === "counter_regression";
      await audit(ctx, {
        event: regression ? "passkey.counter_regression" : "passkey.login_failed",
        outcome: "fail",
        reason: r.reason,
        credential: cred,
        notice: regression,
      });
      return err(401, "passkey_failed");
    }
    const headers = new Headers();
    if (preauth) {
      grants.delete(preauth);
      challenges.delete(`p:${preauth}`);
    }
    headers.append("Set-Cookie", preauthCookie(ctx.rp, null));
    deps.sessionApi.create(ctx.req, headers, "passkey", PASSKEY_SESSION_TTL_MS, {
      id: row.id,
      createdVia: row.createdVia,
      initial: row.initial,
      createdAt: row.createdAt,
    });
    await audit(ctx, { event: "passkey.login", outcome: "ok", credential: cred });
    const notices = (await pendingNotices(e)).length;
    return Response.json({ ok: true, notices }, { headers });
  }

  async function reauthOptions(ctx: Ctx): Promise<Response> {
    const body = await readPost(ctx);
    if (body instanceof Response) return body;
    const s = deps.sessionApi.sessionOf(ctx.req);
    if (!s) return err(401, "Admin authentication required");
    if (!allowPasskey(ctx)) return limited(ctx, "reauth");
    const creds = await listPasskeys(deps.engine());
    if (creds.length === 0) return err(409, "no_passkeys");
    const optionsJSON = await generateAuthenticationOptions({
      rpID: ctx.rp.rpID,
      userVerification: "required",
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
      timeout: CHALLENGE_TTL_MS,
    });
    putChallenge(`s:${s.id}`, { challenge: optionsJSON.challenge, purpose: "reauth", exp: now() + CHALLENGE_TTL_MS });
    return Response.json({ optionsJSON });
  }

  async function reauthVerify(ctx: Ctx): Promise<Response> {
    const body = await readPost(ctx);
    if (body instanceof Response) return body;
    const response = responseField(body);
    if (!response) return err(400, "invalid_body");
    const s = deps.sessionApi.sessionOf(ctx.req);
    if (!s) return err(401, "Admin authentication required");
    if (!allowPasskey(ctx)) return limited(ctx, "reauth");
    const challenge = takeChallenge(`s:${s.id}`, "reauth");
    if (!challenge) {
      await audit(ctx, { event: "passkey.reauth_failed", outcome: "fail", reason: "bad_challenge" });
      return err(401, "passkey_failed");
    }
    const row = await getPasskey(deps.engine(), response.id as string);
    if (!row) {
      await audit(ctx, { event: "passkey.reauth_failed", outcome: "fail", reason: "unknown_credential" });
      return err(401, "passkey_failed");
    }
    const r = await verifyAssertion(ctx, response, challenge, row);
    if (!r.ok) {
      await audit(ctx, {
        event: r.reason === "counter_regression" ? "passkey.counter_regression" : "passkey.reauth_failed",
        outcome: "fail",
        reason: r.reason,
        credential: credentialHash(row.id),
        notice: r.reason === "counter_regression",
      });
      return err(401, "passkey_failed");
    }
    deps.sessionApi.markReauth(s.id, now() + REAUTH_WINDOW_MS);
    await audit(ctx, { event: "passkey.reauth", outcome: "ok", credential: credentialHash(row.id) });
    return Response.json({ ok: true, reauth_until: new Date(now() + REAUTH_WINDOW_MS).toISOString() });
  }

  async function listRoute(ctx: Ctx): Promise<Response> {
    const s = deps.sessionApi.sessionOf(ctx.req);
    if (!s) return err(401, "Admin authentication required");
    const e = deps.engine();
    const rows = await listPasskeys(e);
    const t = now();
    const cd = cooldownUntil(s.session, t);
    const only = rows.length === 1 ? rows[0]! : null;
    return Response.json({
      passkeys: rows.map((r) => ({
        id_hint: r.id.slice(0, 8),
        id: r.id,
        label: r.label,
        device_type: r.deviceType,
        backed_up: r.backedUp,
        created_at: new Date(r.createdAt).toISOString(),
        last_used_at: isoOrNull(r.lastUsedAt),
        created_via: r.createdVia,
        in_cooldown: r.createdVia !== "session" && !r.initial && t < r.createdAt + ENROLL_COOLDOWN_MS,
      })),
      recovery_codes_left: await unusedRecoveryCount(e),
      single_device_only_warning: only !== null && only.deviceType === "singleDevice" && !only.backedUp,
      session_in_cooldown: cd !== null,
      cooldown_until: isoOrNull(cd),
    });
  }

  async function renameRoute(ctx: Ctx): Promise<Response> {
    const body = await readPost(ctx);
    if (body instanceof Response) return body;
    const s = deps.sessionApi.sessionOf(ctx.req);
    if (!s) return err(401, "Admin authentication required");
    const label = labelField(body.label, null);
    if (typeof body.id !== "string" || body.id.length === 0 || body.id.length > 1024 || label === null) {
      return err(400, "invalid_body");
    }
    if (!(await renamePasskey(deps.engine(), body.id, label))) return err(404, "not_found");
    await audit(ctx, { event: "passkey.renamed", outcome: "ok", credential: credentialHash(body.id) });
    return Response.json({ ok: true });
  }

  /** Session + no cooldown + fresh step-up, in that order. */
  async function guardSensitive(ctx: Ctx): Promise<{ id: string; session: AdminSession } | Response> {
    const s = deps.sessionApi.sessionOf(ctx.req);
    if (!s) return err(401, "Admin authentication required");
    const cd = cooldownUntil(s.session);
    if (cd !== null) return cooldownResponse(cd);
    if (!(await sessionFresh(s.session))) return err(403, "reauth_required");
    return s;
  }

  async function revokeRoute(ctx: Ctx): Promise<Response> {
    const body = await readPost(ctx);
    if (body instanceof Response) return body;
    const s = await guardSensitive(ctx);
    if (s instanceof Response) return s;
    if (typeof body.id !== "string" || body.id.length === 0 || body.id.length > 1024) return err(400, "invalid_body");
    try {
      await deletePasskeyChecked(deps.engine(), body.id, body.confirm_last === true);
    } catch (e) {
      if (e instanceof PasskeyStoreError && e.code === "not_found") return err(404, "not_found");
      if (e instanceof PasskeyStoreError && e.code === "last_passkey") return err(409, "last_passkey");
      throw e;
    }
    // A revoked passkey takes its sessions and their pending ceremonies along.
    for (const sid of deps.sessionApi.deleteForCredential(body.id)) challenges.delete(`s:${sid}`);
    await audit(ctx, { event: "passkey.revoked", outcome: "ok", credential: credentialHash(body.id), notice: true });
    return Response.json({ ok: true });
  }

  async function regenerateRoute(ctx: Ctx): Promise<Response> {
    const body = await readPost(ctx);
    if (body instanceof Response) return body;
    const s = await guardSensitive(ctx);
    if (s instanceof Response) return s;
    const codes = await replaceRecoveryCodes(deps.engine(), now());
    await audit(ctx, {
      event: "recovery.regenerated",
      outcome: "ok",
      notice: true,
      credential: s.session.cred ? credentialHash(s.session.cred.id) : null,
    });
    return Response.json({ recovery_codes: codes });
  }

  async function setupLinkRoute(ctx: Ctx): Promise<Response> {
    const body = await readPost(ctx);
    if (body instanceof Response) return body;
    let via: "api" | "panel";
    const b = ctx.bearer();
    if (b === "throttled") return limited(ctx, "bootstrap");
    if (b === "ok") {
      via = "api";
    } else if (b === "bad") {
      return err(401, "Authorization: Bearer <bootstrap-token> required");
    } else {
      const s = await guardSensitive(ctx);
      if (s instanceof Response) return s;
      via = "panel";
    }
    let hours = SETUP_LINK_DEFAULT_HOURS;
    if (body.ttl_hours !== undefined) {
      const h = body.ttl_hours;
      if (typeof h !== "number" || !Number.isInteger(h) || h < 1 || h > SETUP_LINK_MAX_HOURS) {
        return err(400, "invalid_ttl");
      }
      hours = h;
    }
    const link = await mintSetupLink(deps.engine(), {
      ttlMs: hours * HOUR,
      via,
      nowMs: now(),
      clientKey: ctx.clientKey,
      userAgent: ctx.req.headers.get("user-agent"),
    });
    return Response.json({
      url: `${ctx.rp.origin}/admin/#enroll/${link.token}`,
      expires_at: new Date(link.expiresAt).toISOString(),
    });
  }

  function eventJson(ev: AuthEventRecord, ackable?: boolean): Record<string, unknown> {
    return {
      id: ev.id,
      at: new Date(ev.at).toISOString(),
      event: ev.event,
      outcome: ev.outcome,
      reason: ev.reason,
      via: ev.via,
      credential: ev.credential,
      client_key: ev.clientKey,
      user_agent: ev.userAgent,
      notice: ev.notice,
      noticed_at: isoOrNull(ev.noticedAt),
      noticed_by: ev.noticedBy,
      ...(ackable !== undefined ? { ackable } : {}),
    };
  }

  /** Only another, older credential or the operator may dismiss a notice. */
  function canAck(s: AdminSession, ev: AuthEventRecord): boolean {
    if (s.kind !== "passkey") return true;
    if (!s.cred) return false;
    if (ev.credential !== null && ev.credential === credentialHash(s.cred.id)) return false;
    return s.cred.createdAt < ev.at;
  }

  async function eventsRoute(ctx: Ctx): Promise<Response> {
    const s = deps.sessionApi.sessionOf(ctx.req);
    if (!s) return err(401, "Admin authentication required");
    const raw = ctx.url.searchParams.get("limit");
    const n = raw === null ? 50 : Number.parseInt(raw, 10);
    const limit = Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 50;
    const rows = await listAuthEvents(deps.engine(), limit);
    return Response.json({ events: rows.map((r) => eventJson(r)) });
  }

  async function noticesRoute(ctx: Ctx): Promise<Response> {
    const s = deps.sessionApi.sessionOf(ctx.req);
    if (!s) return err(401, "Admin authentication required");
    const rows = await pendingNotices(deps.engine());
    return Response.json({ notices: rows.map((r) => eventJson(r, canAck(s.session, r))) });
  }

  async function ackRoute(ctx: Ctx): Promise<Response> {
    const body = await readPost(ctx);
    if (body instanceof Response) return body;
    const s = deps.sessionApi.sessionOf(ctx.req);
    if (!s) return err(401, "Admin authentication required");
    const cd = cooldownUntil(s.session);
    if (cd !== null) return cooldownResponse(cd);
    const e = deps.engine();
    const rows = await pendingNotices(e);
    const ackable = rows.filter((r) => canAck(s.session, r)).map((r) => r.id);
    const by = s.session.cred ? credentialHash(s.session.cred.id) : s.session.kind;
    const n = await ackNotices(e, ackable, by, now());
    if (n > 0) await audit(ctx, { event: "notice.acked", outcome: "ok", reason: `count=${n}`, credential: s.session.cred ? by : null });
    return Response.json({ acknowledged: n, refused: rows.length - ackable.length });
  }

  type Handler = (ctx: Ctx) => Promise<Response>;
  const routes = new Map<string, Handler>([
    ["POST /admin/api/passkey/enroll/redeem", (c) => redeemOrRecover(c, "setup_link")],
    ["POST /admin/api/passkey/recovery", (c) => redeemOrRecover(c, "recovery")],
    ["POST /admin/api/passkey/register/options", registerOptions],
    ["POST /admin/api/passkey/register/verify", registerVerify],
    ["POST /admin/api/passkey/login/options", loginOptions],
    ["POST /admin/api/passkey/login/verify", loginVerify],
    ["POST /admin/api/passkey/reauth/options", reauthOptions],
    ["POST /admin/api/passkey/reauth/verify", reauthVerify],
    ["GET /admin/api/passkeys", listRoute],
    ["POST /admin/api/passkeys/rename", renameRoute],
    ["POST /admin/api/passkeys/revoke", revokeRoute],
    ["POST /admin/api/recovery-codes/regenerate", regenerateRoute],
    ["POST /admin/api/setup-links", setupLinkRoute],
    ["GET /admin/api/security/events", eventsRoute],
    ["GET /admin/api/security/notices", noticesRoute],
    ["POST /admin/api/security/notices/ack", ackRoute],
  ]);

  async function handle(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname;
    if (!PATHS.has(p)) return null;
    if (p === "/admin/api/passkey/status") return req.method === "GET" ? status() : null;
    const handler = routes.get(`${req.method} ${p}`);
    if (!handler) return null;
    const rp = resolveRelyingParty(deps.publicUrl);
    if (!isRelyingParty(rp)) return err(503, "passkey_unconfigured", { reason: rp.error });
    let bearer: BearerState | null = null;
    const ctx: Ctx = {
      req,
      url,
      rp,
      clientKey: resolveClientKey(req),
      bearer: () => {
        if (bearer !== null) return bearer;
        if (!/^Bearer\s+\S+$/i.test(req.headers.get("authorization") ?? "")) bearer = "none";
        else if (!deps.allowBootstrapAttempt(req)) bearer = "throttled";
        else bearer = deps.bootstrapBearerOk(req) ? "ok" : "bad";
        return bearer;
      },
    };
    await countVolume(ctx);
    return handler(ctx);
  }

  function clearEphemeral(): void {
    challenges.clear();
    grants.clear();
  }

  return { handle, clearEphemeral };
}

