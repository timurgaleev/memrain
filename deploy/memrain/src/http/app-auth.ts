/**
 * Member sign-in for /app: the invite link and the passkey ceremonies.
 *
 *   POST /app/invite/open              {token}  reserve the invite for this browser
 *   POST /app/invite/passkey/options   {token}  registration options for the invited member
 *   POST /app/invite/passkey/verify    {token, response, label}
 *   POST /app/invite/session           {token}  no passkey on this device: one 7-day session
 *   POST /app/login/options                     discoverable sign-in
 *   POST /app/login/verify             {response}
 *   POST /app/logout
 *
 * The invite token travels in the URL fragment and reaches the server only in
 * a POST body; a token in the query string is refused before anything is
 * read. Every route is a same-origin JSON POST. A challenge is generated
 * here, held in this process, bound to one browser by the pre-auth cookie,
 * and taken (deleted) the moment it is presented. The relying party comes
 * from the configured public URL only (core/webauthn-config.ts).
 */
import { createHash, randomBytes } from "node:crypto";
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
import { getMember, memberAccess } from "../core/members.ts";
import { openMemberInvite, redeemInviteWithoutPasskey, type InviteFailure } from "../core/member-invites.ts";
import {
  getMemberPasskey,
  insertMemberPasskeyWithInvite,
  listMemberPasskeyIds,
  memberUserHandle,
  updateMemberCounterCas,
} from "../core/member-passkeys.ts";
import {
  APP_COOKIE,
  createMemberSession,
  memberSessionCookie,
  readAppCookie,
  revokeMemberSession,
} from "../core/member-sessions.ts";
import { isRelyingParty, resolveRelyingParty, type RelyingParty } from "../core/webauthn-config.ts";
import { RateLimiter } from "../mcp/rate_limit.ts";
import { readBodyWithCap } from "./body_limit.ts";
import { resolveClientKey } from "./client-key.ts";
import { isSameOriginPost } from "./same-origin.ts";

const MINUTE = 60_000;
const CHALLENGE_TTL_MS = 5 * MINUTE;
const PREAUTH_COOKIE = `${APP_COOKIE}_preauth`;
const PREAUTH_MAX_AGE_S = 900;
const BODY_CAP = 16 * 1024;
const MAP_CAP = 5000;
const SUPPORTED_ALGS = [-7, -257];
const PREAUTH_RE = /^[0-9a-f]{64}$/;

export interface AppAuthDeps {
  engine: () => Engine;
  publicUrl?: string;
  now?: () => number;
}

interface Challenge {
  challenge: string;
  purpose: "register" | "login";
  exp: number;
  memberId?: string;
  userHandle?: string;
}

const challenges = new Map<string, Challenge>();
/** Ceremony attempts per client: a burst, then one every two seconds. */
const limiter = new RateLimiter({ capacity: 60, refillPerSecond: 1 / 2 });

const sha256Hex = (v: string): string => createHash("sha256").update(v, "utf8").digest("hex");
const json = (body: unknown, status = 200, headers?: Headers): Response =>
  Response.json(body, { status, headers: withNoStore(headers) });

function withNoStore(headers?: Headers): Headers {
  const h = headers ?? new Headers();
  h.set("cache-control", "no-store");
  return h;
}

function preauthCookie(id: string | null): string {
  return `${PREAUTH_COOKIE}=${id ?? ""}; Path=/app; Max-Age=${id === null ? 0 : PREAUTH_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;
}

function putChallenge(key: string, c: Challenge, now: number): void {
  if (challenges.size >= MAP_CAP) {
    for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
    if (challenges.size >= MAP_CAP) challenges.delete(challenges.keys().next().value!);
  }
  challenges.delete(key);
  challenges.set(key, c);
}

function takeChallenge(key: string, purpose: Challenge["purpose"], now: number): Challenge | null {
  const c = challenges.get(key);
  challenges.delete(key);
  return c && c.purpose === purpose && c.exp >= now ? c : null;
}

/** Test seam: forget every pending ceremony. */
export function resetAppAuthState(): void {
  challenges.clear();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function labelOf(raw: unknown): string {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001F\u007F]/g, "").trim() : "";
  return s.length > 0 ? s.slice(0, 64) : "Passkey";
}

/** Unknown, spent, revoked, expired or no longer usable: one answer, 410. */
function inviteRefusal(reason: InviteFailure | "member_mismatch" | "credential_exists"): Response {
  if (reason === "reserved") return json({ error: "invite_in_use" }, 409);
  if (reason === "credential_exists") return json({ error: "credential_exists" }, 409);
  return json({ error: "invite_invalid" }, 410);
}

interface Ctx {
  req: Request;
  url: URL;
  rp: RelyingParty;
  now: number;
  engine: Engine;
  body: Record<string, unknown>;
}

type Route = (ctx: Ctx) => Promise<Response>;

function preauthOf(req: Request): string | null {
  const v = readAppCookie(req, PREAUTH_COOKIE);
  return v !== null && PREAUTH_RE.test(v) ? v : null;
}

function tokenOf(body: Record<string, unknown>): string | null {
  return typeof body.token === "string" && body.token.length > 0 && body.token.length <= 128 ? body.token : null;
}

async function inviteOpen(ctx: Ctx): Promise<Response> {
  const token = tokenOf(ctx.body);
  if (!token) return json({ error: "invalid_body" }, 400);
  const preauth = preauthOf(ctx.req) ?? randomBytes(32).toString("hex");
  const r = await openMemberInvite(ctx.engine, token, sha256Hex(preauth), ctx.now);
  if (!r.ok) return inviteRefusal(r.reason);
  const headers = new Headers({ "Set-Cookie": preauthCookie(preauth) });
  return json(
    {
      ok: true,
      member: { id: r.memberId, display_name: r.displayName },
      expires_in: Math.max(0, Math.round((r.until - ctx.now) / 1000)),
    },
    200,
    headers,
  );
}

async function registerOptions(ctx: Ctx): Promise<Response> {
  const token = tokenOf(ctx.body);
  const preauth = preauthOf(ctx.req);
  if (!token) return json({ error: "invalid_body" }, 400);
  if (!preauth) return json({ error: "invite_not_open" }, 401);
  // Reopening is a no-op for the browser that holds the lease and refuses any other.
  const r = await openMemberInvite(ctx.engine, token, sha256Hex(preauth), ctx.now);
  if (!r.ok) return inviteRefusal(r.reason);
  const member = await getMember(ctx.engine, r.memberId);
  if (!member) return inviteRefusal("unknown");
  const handle = await memberUserHandle(ctx.engine, member.id);
  const existing = await listMemberPasskeyIds(ctx.engine, member.id);
  const optionsJSON = await generateRegistrationOptions({
    rpName: ctx.rp.rpName,
    rpID: ctx.rp.rpID,
    userName: member.id,
    userDisplayName: member.display_name ?? member.id,
    userID: isoBase64URL.toBuffer(handle),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports as never })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: SUPPORTED_ALGS,
    timeout: CHALLENGE_TTL_MS,
  });
  putChallenge(`p:${preauth}`, {
    challenge: optionsJSON.challenge, purpose: "register", exp: ctx.now + CHALLENGE_TTL_MS, memberId: member.id, userHandle: handle,
  }, ctx.now);
  return json({ optionsJSON });
}

async function registerVerify(ctx: Ctx): Promise<Response> {
  const token = tokenOf(ctx.body);
  const response = ctx.body.response;
  const preauth = preauthOf(ctx.req);
  if (!token || !isPlainObject(response) || typeof response.id !== "string") return json({ error: "invalid_body" }, 400);
  const challenge = preauth ? takeChallenge(`p:${preauth}`, "register", ctx.now) : null;
  if (!preauth || !challenge || !challenge.memberId || !challenge.userHandle) return json({ error: "passkey_failed" }, 401);
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
    if (!v.verified) return json({ error: "passkey_failed" }, 401);
    info = v.registrationInfo;
  } catch {
    return json({ error: "passkey_failed" }, 401);
  }
  const transports = (info.credential.transports ?? []).filter((t): t is NonNullable<typeof t> => typeof t === "string").slice(0, 8);
  const stored = await insertMemberPasskeyWithInvite(ctx.engine, challenge.memberId, challenge.userHandle, {
    id: info.credential.id,
    publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
    counter: info.credential.counter,
    transports,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    label: labelOf(ctx.body.label),
  }, { token, preauthHash: sha256Hex(preauth) }, ctx.now);
  if (!stored.ok) return inviteRefusal(stored.reason);
  const headers = new Headers();
  headers.append("Set-Cookie", preauthCookie(null));
  headers.append("Set-Cookie", memberSessionCookie(stored.session.id, stored.session.expiresAt - ctx.now));
  return json({ ok: true, member_id: stored.memberId }, 200, headers);
}

async function inviteSession(ctx: Ctx): Promise<Response> {
  const token = tokenOf(ctx.body);
  const preauth = preauthOf(ctx.req);
  if (!token) return json({ error: "invalid_body" }, 400);
  // Without a pre-auth cookie nothing can be reserved for this browser, but a
  // spent or expired link still says so.
  const r = await redeemInviteWithoutPasskey(ctx.engine, token, preauth ? sha256Hex(preauth) : "-", ctx.now);
  if (!r.ok) return !preauth && r.reason === "reserved" ? json({ error: "invite_not_open" }, 401) : inviteRefusal(r.reason);
  const headers = new Headers();
  headers.append("Set-Cookie", preauthCookie(null));
  headers.append("Set-Cookie", memberSessionCookie(r.session.id, r.session.expiresAt - ctx.now));
  return json({ ok: true, member_id: r.memberId, passkey: false }, 200, headers);
}

async function loginOptions(ctx: Ctx): Promise<Response> {
  const preauth = preauthOf(ctx.req) ?? randomBytes(32).toString("hex");
  const optionsJSON = await generateAuthenticationOptions({
    rpID: ctx.rp.rpID,
    userVerification: "required",
    allowCredentials: [],
    timeout: CHALLENGE_TTL_MS,
  });
  putChallenge(`p:${preauth}`, { challenge: optionsJSON.challenge, purpose: "login", exp: ctx.now + CHALLENGE_TTL_MS }, ctx.now);
  return json({ optionsJSON }, 200, new Headers({ "Set-Cookie": preauthCookie(preauth) }));
}

async function loginVerify(ctx: Ctx): Promise<Response> {
  const response = ctx.body.response;
  const preauth = preauthOf(ctx.req);
  if (!isPlainObject(response) || typeof response.id !== "string") return json({ error: "invalid_body" }, 400);
  const challenge = preauth ? takeChallenge(`p:${preauth}`, "login", ctx.now) : null;
  if (!challenge) return json({ error: "passkey_failed" }, 401);
  const row = await getMemberPasskey(ctx.engine, response.id);
  if (!row) return json({ error: "passkey_failed" }, 401);
  const userHandle = isPlainObject(response.response) ? response.response.userHandle : undefined;
  if (typeof userHandle !== "string" || userHandle !== row.userHandle) return json({ error: "passkey_failed" }, 401);
  let next: number;
  try {
    const v = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: ctx.rp.origin,
      expectedRPID: ctx.rp.rpID,
      credential: { id: row.id, publicKey: isoBase64URL.toBuffer(row.publicKey), counter: row.counter, transports: row.transports as never },
      requireUserVerification: true,
    });
    if (!v.verified) return json({ error: "passkey_failed" }, 401);
    next = v.authenticationInfo.newCounter;
  } catch {
    return json({ error: "passkey_failed" }, 401);
  }
  if (!(await updateMemberCounterCas(ctx.engine, row.id, row.counter, next, ctx.now))) return json({ error: "passkey_failed" }, 401);
  // A passkey outlives a disabled or removed member; the member's state decides.
  const access = await memberAccess(ctx.engine, [row.memberId]);
  if (access === null || access.refused) return json({ error: "passkey_failed" }, 401);
  const session = await createMemberSession(ctx.engine, row.memberId, "passkey", ctx.now);
  const headers = new Headers();
  headers.append("Set-Cookie", preauthCookie(null));
  headers.append("Set-Cookie", memberSessionCookie(session.id, session.expiresAt - ctx.now));
  return json({ ok: true, member_id: row.memberId }, 200, headers);
}

async function logout(ctx: Ctx): Promise<Response> {
  const id = readAppCookie(ctx.req);
  if (id !== null) await revokeMemberSession(ctx.engine, id, ctx.now);
  return json({ ok: true }, 200, new Headers({ "Set-Cookie": memberSessionCookie(null) }));
}

const ROUTES: ReadonlyMap<string, Route> = new Map([
  ["/app/invite/open", inviteOpen],
  ["/app/invite/passkey/options", registerOptions],
  ["/app/invite/passkey/verify", registerVerify],
  ["/app/invite/session", inviteSession],
  ["/app/login/options", loginOptions],
  ["/app/login/verify", loginVerify],
  ["/app/logout", logout],
]);

/** Null when `url` is not a sign-in route. */
export async function handleAppAuth(req: Request, url: URL, deps: AppAuthDeps): Promise<Response | null> {
  const route = ROUTES.get(url.pathname);
  if (!route) return null;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  // The token belongs in the fragment and the body; a URL carrying it has
  // already been written to some log, so it is not accepted from there.
  if (url.search.length > 0) return json({ error: "query_not_accepted" }, 400);
  if (!isSameOriginPost(req, url, deps.publicUrl)) return json({ error: "cross_origin" }, 403);
  if (!limiter.allow(resolveClientKey(req))) return json({ error: "rate_limited" }, 429);
  const rp = resolveRelyingParty(deps.publicUrl);
  if (!isRelyingParty(rp)) return json({ error: "passkeys_unavailable" }, 503);
  let body: Record<string, unknown> = {};
  const read = await readBodyWithCap(req, BODY_CAP);
  if (!read.ok) return read.response;
  if (read.buf.length > 0) {
    const essence = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (essence !== "application/json") return json({ error: "unsupported_media_type" }, 415);
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(read.buf));
      if (!isPlainObject(parsed)) return json({ error: "invalid_body" }, 400);
      body = parsed;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
  }
  return route({ req, url, rp, now: deps.now?.() ?? Date.now(), engine: deps.engine(), body });
}
