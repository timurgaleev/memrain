/**
 * http/admin.ts — admin auth core (increment A1 of the admin surface).
 *
 * A cookie + magic-link auth surface for `/admin`, built on memrain's Bun.serve.
 * Trust model:
 *   - A long-term BOOTSTRAP token is the server admin secret, from
 *     `MEMRAIN_ADMIN_BOOTSTRAP` (or a generated ephemeral one printed to stderr).
 *     PROD: set `MEMRAIN_ADMIN_BOOTSTRAP` explicitly — in a container the ephemeral
 *     token's stderr line goes to the docker/aggregated logs, not just a
 *     terminal. It never appears in a URL.
 *   - Magic-link URLs use one-time NONCES, not the bootstrap token: an agent
 *     calls `POST /admin/api/issue-magic-link` with the bootstrap token in
 *     `Authorization: Bearer` to mint a 5-minute single-use nonce. The browser
 *     redeems `GET /admin/auth/:nonce`, which sets an HttpOnly+SameSite=Strict
 *     cookie session. The BOOTSTRAP token never appears in a URL; the nonce DOES
 *     travel in the URL path (so it can land in browser history / proxy logs /
 *     Referer) — what contains that exposure is single-use + the 5-minute TTL,
 *     not URL hygiene.
 *   - Cookie sessions are in-memory (Map), so a restart signs everyone out.
 *
 * This increment ships the AUTH routes (`/admin/login`, `/admin/api/issue-magic-link`,
 * `/admin/auth/:nonce`, `/admin/api/sign-out-everywhere`) + `requireAdmin`. The
 * data endpoints (A2) and the embedded SPA (B/C) build on top.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RateLimiter } from "../mcp/rate_limit.ts";
import { resolveClientKey } from "./client-key.ts";
import { isSameOriginPost } from "./same-origin.ts";
import { LEGACY_ADMIN_COOKIE, LEGACY_APPROVAL_PARAM, LEGACY_RETURN_TO_COOKIE } from "../core/brand.ts";
import type { Storage } from "../core/storage.ts";
import { revokeUnusedSetupLinks, recordAuthEvent } from "../core/admin-passkey-store.ts";
import {
  cooldownUntil,
  createPasskeyRoutes,
  type AdminSession,
  type PasskeyRoutes,
  type SessionApi,
  type SessionCred,
  type SessionKind,
} from "./admin-passkey.ts";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h for password login
const MAGIC_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d for magic-link
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const NONCE_LRU_CAP = 1000;
// Written under the current names, and read under both, current name first.
const COOKIE_NAME = "memrain_admin";
const COOKIE_NAMES = [COOKIE_NAME, LEGACY_ADMIN_COOKIE] as const;
const RETURN_COOKIE_NAME = "memrain_return_to";
const RETURN_COOKIE_NAMES = [RETURN_COOKIE_NAME, LEGACY_RETURN_TO_COOKIE] as const;
const RETURN_TTL_MS = 10 * 60 * 1000; // 10 minutes to finish signing in
const APPROVAL_PARAM = "memrain_approval";
const APPROVAL_PARAMS = [APPROVAL_PARAM, LEGACY_APPROVAL_PARAM] as const;
const APPROVAL_TTL_MS = 5 * 60 * 1000; // the click and the redirect that follows it
// An operator session counts as freshly authenticated this long after sign-in,
// for the passkey routes that demand a step-up.
const OPERATOR_FRESH_MS = 10 * 60 * 1000;

/**
 * What an approval is bound to: the parameters that decide WHO receives the
 * code and WHAT it is worth. A nonce approved for one request is worthless for
 * any other, so a second authorize cannot ride an approval the operator gave
 * to the first.
 */
function authorizeFingerprint(params: URLSearchParams): string {
  // `resource` (RFC 8707) shapes the audience of the token the code becomes, so
  // it is bound like the rest. `response_type` and `code_challenge_method` are
  // validated to a single accepted value upstream and carry nothing to pin.
  // JSON, not a joined string: a value containing the separator would otherwise
  // let two different parameter sets share a fingerprint.
  const canonical = JSON.stringify(
    ["client_id", "redirect_uri", "code_challenge", "scope", "state", "resource"]
      .map((k) => params.get(k)),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Reject a browser-driven cross-origin POST. `SameSite=Strict` stops another
 * SITE, but a sibling subdomain is same-site, and a form POST from one would
 * ride the session cookie. Fetch metadata (or a plain `Origin`) is what
 * separates them. A caller that sends neither header is not a browser.
 *
 * `Origin` is compared against the host of the request as this server sees it,
 * which assumes the ingress preserves `Host` (Caddy and cloudflared do). A
 * Host-rewriting proxy would refuse every approval.
 */
/** Constant-time compare of two hex digests of equal length. */
function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Every value carried under this cookie name. A browser sends one entry per
 *  Path scope the name exists at, most specific first (RFC 6265 §5.4), so a
 *  cookie left over from an older Path can shadow the live one. */
function readCookies(req: Request, name: string): string[] {
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

/** The first value carried under any of `names`, tried in order. */
function readCookie(req: Request, names: readonly string[]): string | null {
  for (const name of names) {
    const value = readCookies(req, name)[0];
    if (value !== undefined) return value;
  }
  return null;
}

/** True when the request arrived over https (behind a TLS-terminating proxy
 *  this rides the forwarded scheme). */
function isHttps(req: Request): boolean {
  return new URL(req.url).protocol === "https:"
    || req.headers.get("x-forwarded-proto") === "https";
}

/** Build a Set-Cookie header value. Path=/ rather than /admin: `/authorize`
 *  asks requireAdmin whether an operator is signed in (server.ts), and a cookie
 *  scoped to /admin is never sent there (RFC 6265 §5.1.4) — with /admin the
 *  operator-gated OAuth flow can never complete, whatever the login does. */
function buildSetCookie(req: Request, value: string, maxAgeMs: number): string {
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isHttps(req)) attrs.push("Secure");
  return attrs.join("; ");
}

/** Expire the session cookie under its pre-rename name, at `Path=/` and at
 *  the `Path=/admin` of pre-v1.123 releases. A browser sends the more specific
 *  path first, so a dead value there would shadow the live one and lock the
 *  operator out of the dashboard. */
function buildLegacyCookieClears(req: Request): string[] {
  return ["/", "/admin"].map((path) => {
    const attrs = [`${LEGACY_ADMIN_COOKIE}=`, `Path=${path}`, "HttpOnly", "SameSite=Strict", "Max-Age=0"];
    if (isHttps(req)) attrs.push("Secure");
    return attrs.join("; ");
  });
}

/**
 * The authorization flow a sign-in has to resume afterwards. `/authorize`
 * bounces an unauthenticated browser here (oauth-endpoints.ts) carrying its own
 * URL as `?return_to`; that target has to survive BOTH sign-in paths — the
 * magic link redeemed at `/admin/auth/:nonce` leaves the login URL entirely —
 * so it is parked in this short-lived cookie rather than in SPA state.
 *
 * Only `pathname + search` is ever kept and only for `/authorize`, so the
 * redirect is relative and cannot leave this origin.
 */
function safeReturnTo(raw: string | null): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw, "http://memrain.invalid");
  } catch {
    return null;
  }
  if (u.pathname !== "/authorize") return null;
  return u.pathname + u.search;
}

/** Read the parked resume target, re-validating it on the way out. */
function readReturnTo(req: Request): string | null {
  const raw = readCookie(req, RETURN_COOKIE_NAMES);
  if (!raw) return null;
  try {
    return safeReturnTo(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

/** Set (or, with a null value, clear) the resume cookie. SameSite=Lax rather
 *  than the session cookie's Strict: a magic link is typically opened from a
 *  terminal or another app, and Strict would not ride along with that
 *  navigation. It carries no credential — only this server's own authorize URL. */
function buildReturnToCookie(req: Request, value: string | null, name: string = RETURN_COOKIE_NAME): string {
  const attrs = [
    `${name}=${value ? encodeURIComponent(value) : ""}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${value ? Math.floor(RETURN_TTL_MS / 1000) : 0}`,
  ];
  if (isHttps(req)) attrs.push("Secure");
  return attrs.join("; ");
}

/** Clear the resume cookie under every name the request carries it by. */
function appendReturnToClears(req: Request, headers: Headers): void {
  for (const name of RETURN_COOKIE_NAMES) {
    if (readCookies(req, name).length > 0) headers.append("Set-Cookie", buildReturnToCookie(req, null, name));
  }
}

const EXPIRED_LINK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>memrain</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{max-width:400px;padding:32px;text-align:left}.logo{font-size:28px;font-weight:600;margin-bottom:24px}
.msg{color:#888;font-size:14px;line-height:1.6;margin-bottom:20px}
.hint{background:rgba(136,170,255,0.08);border:1px solid rgba(136,170,255,0.2);border-radius:8px;padding:14px 16px;font-size:13px;line-height:1.5;color:#888}
.hint b{color:#e0e0e0}.prompt{background:rgba(0,0,0,0.3);border-radius:6px;padding:8px 12px;margin-top:8px;font-family:monospace;font-size:12px;color:#88aaff}
</style></head><body><div class="box">
<div class="logo">memrain</div>
<div class="msg">⚠️ This admin link has expired, was already used, or the server has restarted.</div>
<div class="hint"><b>Get a fresh link from your AI agent:</b>
<div class="prompt">&ldquo;Give me the memrain admin login link&rdquo;</div>
</div></div></body></html>`;

export interface AdminAuthOptions {
  /** The bootstrap admin token (its sha256 is the stored secret). */
  bootstrapToken: string;
  /** Public base URL for the minted magic-link (falls back to the request host). */
  publicUrl?: string;
  /**
   * Names the client behind a parked `/authorize` so the operator confirms a
   * connection to something they recognize. Unset → the panel shows the
   * client_id and redirect_uri alone.
   */
  describeClient?: (clientId: string) => Promise<{ client_name?: string; scope?: string } | null>;
  /** Mounts passkey sign-in (http/admin-passkey.ts). Unset → bootstrap and magic link only. */
  storage?: Storage;
}

export interface AdminAuth {
  /** True when the request carries a live admin session cookie. */
  requireAdmin(req: Request): boolean;
  /**
   * Single-use consent for THIS `/authorize` request. A live admin session is
   * not approval on its own — anything that can navigate the operator's browser
   * same-site would otherwise mint a code silently — so `/authorize` also
   * demands the approval nonce (`memrain_approval` or `memex_approval`) the
   * operator's click issued, bound to this exact request's parameters.
   */
  consumeAuthorizeApproval(req: Request): boolean;
  /** Handle an `/admin` AUTH route. Returns a Response, or null when the path is
   *  not an auth route (so a later data/SPA dispatcher can take over). */
  handleAuthRoute(req: Request, url: URL): Promise<Response | null>;
  /**
   * When the request's session is a passkey session still in its post-enroll
   * cooldown, the time it ends (ms); otherwise null. Routes that mint lasting
   * credentials refuse while it runs.
   */
  sessionCooldown(req: Request): number | null;
}

const cooldownRefusal = (until: number): Response =>
  Response.json({ error: "cooldown", until: new Date(until).toISOString() }, { status: 403 });

export function createAdminAuth(opts: AdminAuthOptions): AdminAuth {
  const bootstrapHash = createHash("sha256").update(opts.bootstrapToken).digest("hex");
  const sessions = new Map<string, AdminSession>();
  const nonces = new Map<string, number>(); // nonce → expiresAt
  const consumed = new Set<string>();
  // approval nonce → { fingerprint of the approved request, expiry }
  const approvals = new Map<string, { fp: string; exp: number }>();
  // 10 attempts / minute / client (capacity 10, refill 10/60s ≈ 0.1667/s).
  // The client key comes from http/client-key.ts — the SAME resolver every
  // other ingress bucket uses. The old local rule trusted X-Forwarded-For
  // unconditionally, so a caller could rotate that header and hand itself a
  // fresh 10-attempt bucket per login try; XFF now only counts under
  // MEMRAIN_HTTP_TRUST_PROXY, and unattributable callers share one bucket.
  const authLimiter = new RateLimiter({ capacity: 10, refillPerSecond: 10 / 60 });

  function pruneNonces(): void {
    const now = Date.now();
    for (const [n, exp] of nonces) if (exp < now) nonces.delete(n);
    if (nonces.size > NONCE_LRU_CAP) {
      const it = nonces.keys();
      for (let i = nonces.size - NONCE_LRU_CAP; i > 0; i--) nonces.delete(it.next().value as string);
    }
    if (consumed.size > NONCE_LRU_CAP) {
      const it = consumed.values();
      for (let i = consumed.size - NONCE_LRU_CAP; i > 0; i--) consumed.delete(it.next().value as string);
    }
  }

  function newSession(ttl: number, kind: SessionKind, cred?: SessionCred): string {
    const id = randomBytes(32).toString("hex");
    const now = Date.now();
    sessions.set(id, {
      exp: now + ttl,
      kind,
      reauthUntil: kind === "passkey" ? 0 : now + OPERATOR_FRESH_MS,
      ...(cred ? { cred } : {}),
    });
    return id;
  }

  /** Single-use, request-bound consent. Consumes the nonce it accepts. */
  function consumeAuthorizeApproval(req: Request): boolean {
    const params = new URL(req.url).searchParams;
    const nonce = APPROVAL_PARAMS.map((p) => params.get(p)).find((v) => v !== null);
    if (!nonce) return false;
    const rec = approvals.get(nonce);
    approvals.delete(nonce); // single use, valid or not
    if (!rec || rec.exp < Date.now()) return false;
    return rec.fp === authorizeFingerprint(params);
  }

  function liveSession(req: Request): { id: string; session: AdminSession } | null {
    // Any live one authorizes: a stale cookie from the old Path=/admin scope
    // is sent ahead of the live one and must not shadow it.
    for (const id of COOKIE_NAMES.flatMap((name) => readCookies(req, name))) {
      const session = sessions.get(id);
      if (session === undefined) continue;
      if (Date.now() > session.exp) {
        sessions.delete(id);
        continue;
      }
      return { id, session };
    }
    return null;
  }

  function requireAdmin(req: Request): boolean {
    return liveSession(req) !== null;
  }

  function sessionCooldown(req: Request): number | null {
    const s = liveSession(req);
    return s ? cooldownUntil(s.session) : null;
  }

  function bearerOk(req: Request): boolean {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
    if (!m) return false;
    const hash = createHash("sha256").update(m[1]!).digest("hex");
    return safeHexEqual(hash, bootstrapHash);
  }

  const sessionApi: SessionApi = {
    create(req, headers, kind, ttlMs, cred) {
      const id = newSession(ttlMs, kind, cred);
      headers.append("Set-Cookie", buildSetCookie(req, id, ttlMs));
      for (const clear of buildLegacyCookieClears(req)) headers.append("Set-Cookie", clear);
      return id;
    },
    sessionOf: liveSession,
    markReauth(id, untilMs) {
      const s = sessions.get(id);
      if (s) s.reauthUntil = untilMs;
    },
    deleteForCredential(credentialId) {
      const killed: string[] = [];
      for (const [id, s] of sessions) {
        if (s.cred?.id === credentialId) {
          sessions.delete(id);
          killed.push(id);
        }
      }
      return killed;
    },
  };

  const storage = opts.storage;
  const passkey: PasskeyRoutes | null = storage
    ? createPasskeyRoutes({
        engine: () => storage.engine(),
        publicUrl: opts.publicUrl,
        sessionApi,
        bootstrapBearerOk: bearerOk,
        allowBootstrapAttempt: (req) => authLimiter.allow(resolveClientKey(req)),
      })
    : null;

  async function handleAuthRoute(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname;

    if (passkey) {
      const r = await passkey.handle(req, url);
      if (r) return r;
    }

    // GET /admin/login?return_to=/authorize?… — park the flow to resume after
    // sign-in, then serve the SPA from /admin/. Without a valid target this is
    // not an auth route at all: fall through to the static SPA as before.
    if (p === "/admin/login" && req.method === "GET") {
      const resume = safeReturnTo(url.searchParams.get("return_to"));
      if (!resume) return null;
      return new Response(null, {
        status: 302,
        headers: { Location: "/admin/", "Set-Cookie": buildReturnToCookie(req, resume) },
      });
    }

    // POST /admin/login — JSON { token } → session cookie. Rate-limited per IP
    // so a weak operator-set bootstrap token can't be brute-forced online.
    if (p === "/admin/login" && req.method === "POST") {
      if (!authLimiter.allow(resolveClientKey(req))) {
        return Response.json({ error: "Too many attempts" }, { status: 429 });
      }
      let token: unknown;
      try {
        token = (await req.json() as { token?: unknown })?.token;
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      if (typeof token !== "string" || token.length === 0) {
        return Response.json({ error: "Token required" }, { status: 400 });
      }
      const hash = createHash("sha256").update(token).digest("hex");
      if (!safeHexEqual(hash, bootstrapHash)) {
        return Response.json({ error: "Invalid token. Check your terminal output." }, { status: 401 });
      }
      const id = newSession(SESSION_TTL_MS, "bootstrap");
      const headers = new Headers();
      headers.append("Set-Cookie", buildSetCookie(req, id, SESSION_TTL_MS));
      for (const clear of buildLegacyCookieClears(req)) headers.append("Set-Cookie", clear);
      // A parked /authorize target is deliberately NOT consumed here: the SPA
      // shows it as a confirmation the operator has to accept.
      return Response.json({ status: "authenticated" }, { headers });
    }

    // POST /admin/api/issue-magic-link — Bearer bootstrap → one-time nonce URL.
    if (p === "/admin/api/issue-magic-link" && req.method === "POST") {
      if (!bearerOk(req)) {
        return Response.json({ error: "Authorization: Bearer <bootstrap-token> required" }, { status: 401 });
      }
      pruneNonces();
      const nonce = randomBytes(32).toString("hex");
      nonces.set(nonce, Date.now() + NONCE_TTL_MS);
      const base = opts.publicUrl || `${url.protocol}//${url.host}`;
      return Response.json({ url: `${base}/admin/auth/${nonce}`, expires_in: NONCE_TTL_MS / 1000 });
    }

    // GET /admin/auth/:nonce — single-use redemption → session cookie + redirect.
    if (p.startsWith("/admin/auth/") && req.method === "GET") {
      if (!authLimiter.allow(resolveClientKey(req))) {
        return new Response("Too Many Requests", { status: 429 });
      }
      let nonce: string;
      try {
        nonce = decodeURIComponent(p.slice("/admin/auth/".length));
      } catch {
        // Malformed percent-encoding — treat as an invalid (expired) link, not a 500.
        return new Response(EXPIRED_LINK_HTML, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      pruneNonces();
      const exp = nonces.get(nonce);
      const valid = !!nonce && exp !== undefined && exp > Date.now() && !consumed.has(nonce);
      if (!valid) {
        return new Response(EXPIRED_LINK_HTML, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      nonces.delete(nonce);
      consumed.add(nonce);
      const id = newSession(MAGIC_SESSION_TTL_MS, "magic");
      const headers = new Headers({ Location: "/admin/" });
      headers.append("Set-Cookie", buildSetCookie(req, id, MAGIC_SESSION_TTL_MS));
      for (const clear of buildLegacyCookieClears(req)) headers.append("Set-Cookie", clear);
      return new Response(null, { status: 302, headers });
    }

    // GET /admin/api/pending-resume — describes the /authorize request parked
    // by the bounce, so the SPA can ask the operator to confirm it. The target
    // is never followed automatically: the cookie carrying it is SameSite=Lax
    // and a cross-site page can plant one, so an unattended resume would let a
    // planted client collect a code at the operator's next sign-in. A click on
    // a named client is the consent that the login by itself is not.
    if (p === "/admin/api/pending-resume" && req.method === "GET") {
      if (!requireAdmin(req)) return Response.json({ error: "Admin authentication required" }, { status: 401 });
      const resume = readReturnTo(req);
      if (!resume) return Response.json({ redirect_to: null });
      const q = new URL(resume, "http://memrain.invalid").searchParams;
      const clientId = q.get("client_id");
      const handle = authorizeFingerprint(q);
      // A lookup failure degrades to the client_id — the panel is what stands
      // between a planted request and a code; it must render regardless.
      let described: { client_name?: string; scope?: string } | null = null;
      if (clientId && opts.describeClient) {
        described = await opts.describeClient(clientId).catch(() => null);
      }
      return Response.json({
        // What the operator is looking at. Approval quotes it back, so a
        // request swapped into the cookie after the panel rendered cannot be
        // approved by that click.
        handle,
        redirect_to: resume,
        client_id: clientId,
        resource: q.get("resource"),
        client_name: described?.client_name ?? null,
        redirect_uri: q.get("redirect_uri"),
        // An omitted scope is not "no permissions": the provider grants the
        // client's whole registered scope. Show what would actually be handed
        // over, not what the query happens to say.
        scope: q.get("scope") ?? described?.scope ?? null,
      });
    }

    // POST /admin/api/approve-resume — the operator's click. Mints the one-time
    // approval `/authorize` demands, bound to the parked request, and retires
    // the parked cookie so the panel does not come back.
    if (p === "/admin/api/approve-resume" && req.method === "POST") {
      if (!isSameOriginPost(req, url, opts.publicUrl)) return Response.json({ error: "Cross-origin request refused" }, { status: 403 });
      if (!requireAdmin(req)) return Response.json({ error: "Admin authentication required" }, { status: 401 });
      // An approval hands an OAuth client a code it trades for lasting tokens.
      const cooldown = sessionCooldown(req);
      if (cooldown !== null) return cooldownRefusal(cooldown);
      const claimed = await req.json().catch(() => null) as { handle?: unknown } | null;
      const resume = readReturnTo(req);
      const clear = new Headers();
      appendReturnToClears(req, clear);
      // Nothing parked (or a value that failed re-validation): drop the remnant.
      if (!resume) return Response.json({ error: "Nothing to approve" }, { status: 404, headers: clear });
      const target = new URL(resume, "http://memrain.invalid");
      const fp = authorizeFingerprint(target.searchParams);
      if (typeof claimed?.handle !== "string" || claimed.handle !== fp) {
        // The parked request is KEPT here: the operator is being asked to look
        // at the one that is actually pending, so it has to still be there.
        return Response.json(
          { error: "The pending request changed — review it again" },
          { status: 409 },
        );
      }
      const nonce = randomBytes(32).toString("hex");
      const now = Date.now();
      for (const [n, rec] of approvals) if (rec.exp < now) approvals.delete(n);
      approvals.set(nonce, { fp, exp: now + APPROVAL_TTL_MS });
      target.searchParams.set(APPROVAL_PARAM, nonce);
      return Response.json({ redirect_to: target.pathname + target.search }, { headers: clear });
    }

    // POST /admin/api/dismiss-resume — "Not now": drop the parked request so it
    // stops being offered.
    if (p === "/admin/api/dismiss-resume" && req.method === "POST") {
      if (!isSameOriginPost(req, url, opts.publicUrl)) return Response.json({ error: "Cross-origin request refused" }, { status: 403 });
      if (!requireAdmin(req)) return Response.json({ error: "Admin authentication required" }, { status: 401 });
      const headers = new Headers();
      appendReturnToClears(req, headers);
      return Response.json({ dismissed: true }, { headers });
    }

    // POST /admin/api/sign-out-everywhere — clear all sessions (requires a
    // session), every pending passkey ceremony and every unused setup link.
    if (p === "/admin/api/sign-out-everywhere" && req.method === "POST") {
      if (!isSameOriginPost(req, url, opts.publicUrl)) return Response.json({ error: "Cross-origin request refused" }, { status: 403 });
      if (!requireAdmin(req)) return Response.json({ error: "Admin authentication required" }, { status: 401 });
      // Run in a loop, it would keep the owner from staying signed in long
      // enough to remove the passkey that runs it.
      const cooldown = sessionCooldown(req);
      if (cooldown !== null) return cooldownRefusal(cooldown);
      const count = sessions.size;
      sessions.clear();
      approvals.clear();
      if (passkey && storage) {
        passkey.clearEphemeral();
        try {
          const revoked = await revokeUnusedSetupLinks(storage.engine());
          if (revoked > 0) {
            await recordAuthEvent(storage.engine(), {
              event: "setup_link.revoked",
              outcome: "ok",
              reason: `count=${revoked}`,
              clientKey: resolveClientKey(req),
              userAgent: req.headers.get("user-agent"),
            });
          }
        } catch (e) {
          // The sessions are already gone; a storage failure here must not
          // read as a failed sign-out.
          console.error("[admin] revoking unused setup links failed:", e instanceof Error ? e.message : e);
        }
      }
      return Response.json({ revoked_sessions: count });
    }

    return null; // not an auth route — let a later dispatcher handle it
  }

  return { requireAdmin, consumeAuthorizeApproval, handleAuthRoute, sessionCooldown };
}
