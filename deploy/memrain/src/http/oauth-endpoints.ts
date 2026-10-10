/**
 * OAuth 2.1 HTTP endpoints — the standard MCP-client flow wired over Bun.serve.
 *
 * The OAuthProvider (core/oauth-provider.ts) owns all DB access + crypto; this
 * module is the transport glue that maps HTTP requests onto provider calls and
 * shapes the RFC responses. Four routes, each reachable BEFORE a client holds a
 * token, so all are exempt from the public bearer (see http/public_guard.ts).
 * Each enforces its OWN validation:
 *
 *   GET  /authorize  — authorization-code + PKCE (S256) kickoff (RFC 6749 §4.1)
 *   POST /token      — authorization_code / refresh_token / client_credentials
 *   POST /register   — Dynamic Client Registration (RFC 7591)
 *   POST /revoke     — token revocation (RFC 7009)
 *
 * PKCE note: memrain does NOT use the MCP SDK's Express auth router, so the S256
 * verification the SDK normally performs at the token endpoint is done HERE
 * (`verifyPkceS256`) BEFORE the provider consumes the code. The provider's
 * `exchangeAuthorizationCode` still binds client_id + redirect_uri + single-use
 * atomically in its DELETE…RETURNING, so a wrong client / wrong redirect_uri /
 * replayed code all fail cleanly regardless of this layer.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type {
  OAuthProvider,
  OAuthClientInfo,
} from "../core/oauth-provider.ts";
import {
  GrantConflictError,
  clientAllowsGrant,
  needsOperatorConsent,
  redirectUriRegistered,
} from "../core/oauth-provider.ts";
import { parseScopeString } from "../core/scope.ts";
import { canonicalResource } from "./oauth-metadata.ts";
import { isSameOriginPost } from "./same-origin.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** RFC 6749 §5.2 error body with a no-store header (tokens must not be cached). */
function oauthError(
  error: string,
  description: string | undefined,
  status: number,
): Response {
  const body: Record<string, string> = { error };
  if (description) body.error_description = description;
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * Parse a form-encoded or JSON request body into a URLSearchParams. Returns
 * null on a malformed body so the caller can answer `invalid_request`.
 */
async function readParams(req: Request): Promise<URLSearchParams | null> {
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const j = (await req.json()) as Record<string, unknown>;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(j)) {
        if (typeof v === "string") p.set(k, v);
      }
      return p;
    }
    return new URLSearchParams(await req.text());
  } catch {
    return null;
  }
}

/**
 * Extract client credentials from a token/revoke request. A confidential client
 * presents its secret either in the body (`client_secret_post`) or an HTTP Basic
 * header (`client_secret_basic`); a public PKCE client presents neither.
 */
function clientAuthFromRequest(
  req: Request,
  params: URLSearchParams,
): { clientId?: string; clientSecret?: string } {
  let clientId = params.get("client_id") ?? undefined;
  let clientSecret = params.get("client_secret") ?? undefined;
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!clientSecret && authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString(
        "utf8",
      );
      const idx = decoded.indexOf(":");
      if (idx > -1) {
        // RFC 6749 §2.3.1: both halves are form-urlencoded, so '+' is a space.
        clientId = clientId ?? decodeURIComponent(decoded.slice(0, idx).replace(/\+/g, " "));
        clientSecret = decodeURIComponent(decoded.slice(idx + 1).replace(/\+/g, " "));
      }
    } catch {
      // Malformed Basic header — treated as no credentials (public path).
    }
  }
  return { clientId, clientSecret };
}

/**
 * The audience a request names with `resource` (RFC 8707): undefined when it
 * names none, null when any value is not this server. Every value is judged, so
 * a foreign one cannot ride behind a valid first one. An empty value still
 * reads as absent.
 */
function requestedResource(values: string[], issuer: string): URL | undefined | null {
  let resource: URL | undefined;
  for (const value of values) {
    if (!value) continue;
    const canonical = canonicalResource(value, issuer);
    if (canonical === null) return null;
    resource = new URL(canonical);
  }
  return resource;
}

/**
 * PKCE S256 check (RFC 7636 §4.6): BASE64URL(SHA256(code_verifier)) must equal
 * the challenge stored at /authorize. Constant-time compare on the digests.
 */
function verifyPkceS256(codeVerifier: string, storedChallenge: string): boolean {
  const computed = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(storedChallenge, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Resolve + authenticate the client for a token/revoke request. Confidential
 * clients are verified against the stored secret hash; public clients (no
 * secret) must be registered with `token_endpoint_auth_method='none'`. Throws
 * an opaque "Invalid client" on any failure so the caller collapses to 401 and
 * never reveals whether the client_id exists.
 */
async function resolveClient(
  provider: OAuthProvider,
  clientId: string | undefined,
  clientSecret: string | undefined,
): Promise<OAuthClientInfo> {
  if (!clientId) throw new Error("Invalid client");
  if (clientSecret) {
    return provider.verifyConfidentialClientSecret(clientId, clientSecret);
  }
  const client = await provider.getClient(clientId);
  if (!client) throw new Error("Invalid client");
  // A confidential client (non-null stored secret) MUST present its secret; a
  // registered public client has a NULL secret hash (getClient → undefined).
  if (client.client_secret !== undefined) throw new Error("Invalid client");
  return client;
}

// ---------------------------------------------------------------------------
// POST /token — authorization_code / refresh_token / client_credentials
// ---------------------------------------------------------------------------

/**
 * The OAuth 2.1 token endpoint. `client_credentials` (machine-to-machine) mints
 * an access token from a client secret; `authorization_code` completes the PKCE
 * flow; `refresh_token` rotates. Any client/secret failure on the two latter
 * grants collapses to `invalid_client` 401; grant/code/verifier problems are
 * `invalid_grant` 400. client_credentials keeps its historical single 401.
 */
export async function handleTokenRoute(
  req: Request,
  provider: OAuthProvider,
  /**
   * /authorize auto-approves (see handleAuthorizeRoute). A public client-mode
   * client is then refused here too: its codes and refresh tokens were minted
   * on nothing but its client_id, and refresh would keep that access alive
   * past the /authorize refusal for good. Defaults to true, failing closed.
   */
  autoApproves = true,
  /** The issuer a `resource` parameter is judged against (RFC 8707). */
  issuer = publicOrigin(new URL(req.url)),
): Promise<Response> {
  const params = await readParams(req);
  if (!params) return oauthError("invalid_request", "malformed body", 400);
  const grantType = params.get("grant_type");
  // The one fact that separates "memrain refused the exchange" from "the client
  // never asked": silence here means the redirect never reached the client.
  // A grant type is not a secret; no code, token or verifier is logged.
  console.info(`[oauth] POST /token grant_type=${grantType ?? "<absent>"}`);

  if (grantType === "client_credentials") {
    const { clientId, clientSecret } = clientAuthFromRequest(req, params);
    if (!clientId || !clientSecret) {
      return oauthError(
        "invalid_client",
        "client_id and client_secret are required",
        401,
      );
    }
    // RFC 8707 applies to every grant. The token stays unbound either way, so
    // a caller that names no resource is unchanged.
    if (requestedResource(params.getAll("resource"), issuer) === null) {
      return oauthError("invalid_target", "resource is not served by this server", 400);
    }
    try {
      const tokens = await provider.exchangeClientCredentials(
        clientId,
        clientSecret,
        params.get("scope") ?? undefined,
      );
      return Response.json(tokens, { status: 200, headers: NO_STORE });
    } catch {
      // Never distinguish unknown-client / bad-secret / wrong-grant.
      return oauthError("invalid_client", undefined, 401);
    }
  }

  if (grantType === "authorization_code" || grantType === "refresh_token") {
    const { clientId, clientSecret } = clientAuthFromRequest(req, params);
    let client: OAuthClientInfo;
    try {
      client = await resolveClient(provider, clientId, clientSecret);
    } catch {
      return oauthError("invalid_client", "client authentication failed", 401);
    }
    if (autoApproves && needsOperatorConsent(client)) {
      console.warn(
        `[oauth] ${grantType} refused for public client ${client.client_name}: ` +
          "no secret and no operator approval behind it",
      );
      return oauthError(
        "unauthorized_client",
        "a public client needs operator approval; this server auto-approves /authorize",
        400,
      );
    }

    // RFC 8707: a resource this server does not serve is refused before any
    // code or refresh token is looked at, let alone consumed.
    const requested = requestedResource(params.getAll("resource"), issuer);
    if (requested === null) {
      return oauthError("invalid_target", "resource is not served by this server", 400);
    }
    const resource = requested;
    /** A stored resource that is not the one this request names. */
    const conflicts = (stored: string | null): boolean =>
      resource !== undefined &&
      stored !== null &&
      canonicalResource(stored, issuer) !== resource.toString();
    /**
     * A stored resource this server does not serve. The row would only mint
     * tokens /mcp refuses, so it is refused here, before it is consumed.
     */
    const foreign = (stored: string | null): boolean =>
      stored !== null && canonicalResource(stored, issuer) === null;

    try {
      if (grantType === "authorization_code") {
        const code = params.get("code");
        const redirectUri = params.get("redirect_uri");
        const codeVerifier = params.get("code_verifier");
        // redirect_uri is required so the provider's binding check runs; the
        // verifier is required because every code is minted PKCE-bound.
        if (!code || !redirectUri || !codeVerifier) {
          return oauthError(
            "invalid_request",
            "code, redirect_uri, and code_verifier are required",
            400,
          );
        }
        // PKCE S256 verification (this replaces the SDK router's check). On a
        // mismatch we DO NOT consume the code — the legitimate client, which
        // holds the real verifier, can still redeem it.
        const challenge = await provider.challengeForAuthorizationCode(
          client,
          code,
        );
        if (!verifyPkceS256(codeVerifier, challenge)) {
          return oauthError("invalid_grant", "PKCE verification failed", 400);
        }
        const codeResource = await provider.resourceForAuthorizationCode(client, code);
        if (conflicts(codeResource)) {
          return oauthError("invalid_target", "resource does not match the authorization", 400);
        }
        if (foreign(codeResource)) {
          return oauthError("invalid_grant", "the authorization is bound to a resource this server does not serve", 400);
        }
        const tokens = await provider.exchangeAuthorizationCode(
          client,
          code,
          codeVerifier,
          redirectUri,
          resource,
        );
        return Response.json(tokens, { status: 200, headers: NO_STORE });
      }

      // refresh_token
      const refreshToken = params.get("refresh_token");
      if (!refreshToken) {
        return oauthError("invalid_request", "refresh_token is required", 400);
      }
      if (!clientAllowsGrant(client.grant_types, "refresh_token")) {
        return oauthError(
          "unauthorized_client",
          "this client is not registered for the refresh_token grant",
          400,
        );
      }
      const refreshResource = await provider.resourceForRefreshToken(client, refreshToken);
      if (conflicts(refreshResource)) {
        return oauthError("invalid_target", "resource does not match the refresh token", 400);
      }
      if (foreign(refreshResource)) {
        return oauthError("invalid_grant", "the refresh token is bound to a resource this server does not serve", 400);
      }
      const scopeParam = params.get("scope");
      const scopes = scopeParam ? parseScopeString(scopeParam) : undefined;
      if (scopes !== undefined && scopes.length === 0) {
        return oauthError("invalid_scope", "scope names no scope", 400);
      }
      const tokens = await provider.exchangeRefreshToken(
        client,
        refreshToken,
        scopes,
        resource,
      );
      return Response.json(tokens, { status: 200, headers: NO_STORE });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "invalid grant";
      console.warn(`[oauth] ${grantType} exchange refused for ${client.client_name}: ${msg}`);
      return oauthError("invalid_grant", msg, 400);
    }
  }

  return oauthError("unsupported_grant_type", undefined, 400);
}

// ---------------------------------------------------------------------------
// GET /authorize — authorization-code + PKCE (S256)
// ---------------------------------------------------------------------------

/** `url` with the RFC 9207 `iss` parameter set, so a client talking to more
 *  than one authorization server can tell which one answered (mix-up defence).
 *  Every /authorize redirect carries it, success and error alike. */
function withIssuer(url: string, issuer: string): string {
  const u = new URL(url);
  u.searchParams.set("iss", issuer);
  return u.toString();
}

/** Redirect back to the client with an OAuth error (RFC 6749 §4.1.2.1). Only
 *  used once the redirect_uri is confirmed registered — never before. */
function errorRedirect(
  redirectUri: string,
  issuer: string,
  error: string,
  state: string | undefined,
  description?: string,
): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { Location: withIssuer(u.toString(), issuer) } });
}

/**
 * The authorization endpoint. Validates client_id + an exact-match redirect_uri
 * (any port for an http loopback one, RFC 8252 §7.3) against the client's
 * registered allowlist BEFORE trusting either — an unknown
 * client or unregistered redirect_uri gets a direct 400 (never a redirect to an
 * attacker-controlled URI). Once the redirect_uri is trusted, response_type /
 * PKCE parameter errors are reported as an error redirect carrying `state`. On
 * success a one-time, PKCE-bound code is issued and the browser is 302'd back.
 */
/**
 * The origin this server is reached at from outside: the declared
 * `MEMRAIN_PUBLIC_URL` when set, else whatever the request carried.
 */
function publicOrigin(url: URL): string {
  // Trailing slashes trimmed by index, not by `/\/+$/`: that pattern is
  // quadratic on a run of slashes followed by a non-match (the linter's
  // regexp/no-super-linear-move), and this repo keeps that rule at error.
  // One backward scan, one slice.
  const raw = (process.env.MEMRAIN_PUBLIC_URL ?? "").trim();
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 0x2f) end--;
  const declared = raw.slice(0, end);
  return declared.length > 0 ? declared : url.origin;
}

export async function handleAuthorizeRoute(
  req: Request,
  provider: OAuthProvider,
  /**
   * Resource-owner authentication gate. By DEFAULT this auto-approves (returns
   * true), so a standard MCP client (Claude.ai etc.) completes the
   * authorization-code flow with no extra step.
   * An operator who wants the stricter posture sets `MEMRAIN_OAUTH_REQUIRE_LOGIN=1`
   * (wired in server.ts), which passes `adminAuth.requireAdmin` here: then a code
   * is only ever minted for a logged-in operator and an unauthenticated browser
   * is bounced to `/admin/login`. DCR clients are read/write-only regardless, so
   * auto-approve cannot yield an elevated token.
   */
  isResourceOwnerAuthenticated: (req: Request) => boolean = () => true,
  /**
   * Whether the gate above lets every request through. A public client-mode
   * client is refused while it does: PKCE alone redeems its codes, so its
   * client_id would be a bearer credential for its tenant. Defaults to true
   * so a caller that forgets to say fails closed.
   */
  autoApproves = true,
  /** The issuer a `resource` parameter is judged against (RFC 8707). */
  issuer = publicOrigin(new URL(req.url)),
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const clientId = q.get("client_id");
  const redirectUri = q.get("redirect_uri");

  if (!clientId) {
    return oauthError("invalid_request", "client_id is required", 400);
  }
  const client = await provider.getClient(clientId);
  if (!client) return oauthError("invalid_client", "unknown client", 400);
  if (!redirectUri || !redirectUriRegistered(client.redirect_uris, redirectUri)) {
    return oauthError(
      "invalid_request",
      "redirect_uri is not registered for this client",
      400,
    );
  }

  // redirect_uri is now trusted — parameter errors go back to it.
  const state = q.get("state") ?? undefined;
  if (!clientAllowsGrant(client.grant_types, "authorization_code")) {
    return errorRedirect(
      redirectUri,
      issuer,
      "unauthorized_client",
      state,
      "this client is not registered for the authorization_code grant",
    );
  }
  if (q.get("response_type") !== "code") {
    return errorRedirect(redirectUri, issuer, "unsupported_response_type", state);
  }
  const codeChallenge = q.get("code_challenge");
  const method = q.get("code_challenge_method");
  if (!codeChallenge) {
    return errorRedirect(
      redirectUri,
      issuer,
      "invalid_request",
      state,
      "code_challenge is required (PKCE)",
    );
  }
  // S256 only — plain is refused (a method omitted defaults to S256 here).
  if (method && method !== "S256") {
    return errorRedirect(
      redirectUri,
      issuer,
      "invalid_request",
      state,
      "only the S256 code_challenge_method is supported",
    );
  }

  const scopeParam = q.get("scope");
  // RFC 8707 §2: a resource this server does not serve is `invalid_target`.
  // Either spelling of this server is stored as the one canonical audience.
  const resource = requestedResource(q.getAll("resource"), issuer);
  if (resource === null) {
    return errorRedirect(
      redirectUri,
      issuer,
      "invalid_target",
      state,
      "resource is not served by this server",
    );
  }

  const authorizeParams = {
    codeChallenge,
    redirectUri,
    ...(scopeParam ? { scopes: parseScopeString(scopeParam) } : {}),
    ...(state ? { state } : {}),
    ...(resource ? { resource } : {}),
  };

  // Enrollment-mode client: the person in front of this page presents a
  // one-time code the operator issued for her source. The code IS the
  // resource-owner authentication, so the operator-login gate below is not
  // consulted — it could only send her to a login she cannot pass.
  if (client.tenant_mode === "enrollment") {
    if (req.method !== "POST") {
      return enrollmentForm(req, null, client.client_name, redirectUri);
    }
    // A cross-origin auto-submitting form is a "simple request" — no preflight
    // — so without this an attacker page could POST HIS code from HER browser
    // and bind her connector to his tenant, quietly collecting everything she
    // writes. The client's `state` is not a defence here: it is optional, and
    // it is the client that checks it, not us. `/authorize` is rate-limited in
    // server.ts for GET and POST alike, so there is no separate limiter here.
    if (!isSameOriginPost(req, new URL(req.url))) {
      // A refusal here is indistinguishable, from the outside, from a browser
      // quirk — and the first one cost two deploys to diagnose. Log what the
      // request actually carried: neither header is a secret.
      console.warn(
        `[oauth] enrollment POST refused as cross-origin: origin=${req.headers.get("origin") ?? "<absent>"} ` +
          `sec-fetch-site=${req.headers.get("sec-fetch-site") ?? "<absent>"} ` +
          `x-forwarded-proto=${req.headers.get("x-forwarded-proto") ?? "<absent>"}`,
      );
      return new Response("Cross-origin request refused.", {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE },
      });
    }
    const submitted = await readEnrollmentCode(req);
    const grant = submitted ? await provider.claimEnrollment(submitted, client.client_id) : undefined;
    if (!grant) {
      // One message for wrong / used / expired / revoked / other-client: the
      // form must not tell an attacker which of those it was.
      return enrollmentForm(req, "That code was not accepted.", client.client_name, redirectUri);
    }
    try {
      const { redirectUrl } = await provider.authorize(client, authorizeParams, grant);
      const minted = new URL(redirectUrl).searchParams.get("code");
      if (minted && submitted) {
        await provider
          .linkEnrollmentToCode(submitted, createHash("sha256").update(minted, "utf8").digest("hex"))
          .catch((e: unknown) => {
            console.warn(
              "[memrain] enrollment audit link failed: " +
                (e instanceof Error ? e.message : String(e)),
            );
          });
      }
      // A claimed code with no `/token` exchange behind it means the handoff to
      // the client failed, not memrain — and the two look identical from the
      // outside, because the person just ends up back on this form.
      console.info(
        `[oauth] enrollment claimed: client=${client.client_name} source=${grant.sourceId} ` +
          `redirect=${new URL(redirectUrl).host} code_minted=${minted ? "yes" : "no"}`,
      );
      // 303, not 302: the browser arrives here by POST, and 303 is the status
      // that guarantees it follows with a GET rather than re-posting the form
      // to the client's callback.
      return new Response(null, {
        status: 303,
        headers: { Location: withIssuer(redirectUrl, issuer), ...NO_STORE },
      });
    } catch {
      // The claim already marked the code used. Minting failed, so nothing was
      // issued for it — hand it back rather than burning a single-use code on
      // a transient error and leaving the person with no way in and the
      // operator with a row `revoke-enrollment` will not touch.
      if (submitted) await provider.releaseEnrollment(submitted).catch(() => {});
      return errorRedirect(redirectUri, issuer, "server_error", state);
    }
  }

  if (req.method !== "GET") {
    return oauthError("invalid_request", "method not allowed", 405);
  }

  if (autoApproves && needsOperatorConsent(client)) {
    console.warn(
      `[oauth] /authorize refused for public client ${client.client_name}: ` +
        "no secret and no operator approval behind it",
    );
    return errorRedirect(
      redirectUri,
      issuer,
      "unauthorized_client",
      state,
      "a public client needs operator approval; this server auto-approves /authorize",
    );
  }

  // Resource-owner gate: never issue a code without a logged-in operator. Bounce
  // an unauthenticated browser to the admin login, carrying the full authorize
  // URL so it can resume after sign-in. Placed AFTER param validation so a
  // malformed request still fails fast, but BEFORE any code is minted.
  if (!isResourceOwnerAuthenticated(req)) {
    // Resume against the DECLARED public origin, not `req.url`. Behind a TLS
    // terminator the request this process sees is plain http on an internal
    // host, so echoing it back sends the operator to an http:// address after
    // sign-in — a downgrade at best and a broken resume at worst.
    const returnTo = encodeURIComponent(
      publicOrigin(new URL(req.url)) + new URL(req.url).pathname + new URL(req.url).search,
    );
    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/login?return_to=${returnTo}` },
    });
  }

  try {
    const { redirectUrl } = await provider.authorize(client, authorizeParams);
    return new Response(null, {
      status: 302,
      headers: { Location: withIssuer(redirectUrl, issuer) },
    });
  } catch (e) {
    if (e instanceof GrantConflictError) {
      return errorRedirect(
        redirectUri,
        issuer,
        "access_denied",
        state,
        "the client's grant changed during authorization; start again",
      );
    }
    return errorRedirect(redirectUri, issuer, "server_error", state);
  }
}

/** The `enrollment_code` field of a form-encoded POST body, or null. */
async function readEnrollmentCode(req: Request): Promise<string | null> {
  try {
    const body = await req.text();
    const v = new URLSearchParams(body).get("enrollment_code");
    return v ? v.trim() : null;
  } catch {
    return null;
  }
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The one page a teammate ever sees from memrain: a single field for the code
 * the operator gave her. Self-contained (no external assets, strict CSP), and
 * it says nothing about the brain — not the source, not the label, nothing an
 * onlooker could use. The form posts back to this same URL so every OAuth
 * parameter the client sent (state, PKCE challenge, redirect) rides along
 * untouched.
 */
function enrollmentForm(
  req: Request,
  error: string | null,
  clientName?: string,
  redirectUri?: string,
): Response {
  const url = new URL(req.url);
  const action = escapeHtml(url.pathname + url.search);
  // `form-action` is enforced across the submission's REDIRECTS, not just
  // its first hop. With `'self'` alone the browser silently blocked the 303
  // back to the client's callback: memrain had claimed the code and minted an
  // authorization code, the person never left this page, and the client never
  // called /token — indistinguishable, from her seat, from a rejected code.
  // The redirect target is already checked against the client's registered
  // URIs before this renders, so naming its origin here widens nothing.
  let formAction = "'self'";
  let returnHost = "";
  if (redirectUri) {
    try {
      // The exact callback path, not just its origin: naming the origin alone
      // would let this page's form post anywhere on the client's domain.
      // CSP matches the path and ignores the query, so the `?code=…` redirect
      // still passes.
      const u = new URL(redirectUri);
      formAction += " " + u.origin + u.pathname;
      returnHost = u.host;
    } catch {
      /* an unparseable URI never passed registration; keep 'self' */
    }
  }
  // Name the connector: a person who cannot tell WHAT she is enrolling into
  // has no way to notice a crafted /authorize link. The name is operator-set
  // and carries nothing secret.
  const who = clientName ? `<p>Connecting <strong>${escapeHtml(clientName)}</strong>.</p>` : "";
  // Where the code goes once accepted. A registered callback on a host she
  // does not recognise is her last chance to stop before handing it over.
  const dest = returnHost ? `<p>You will be sent back to <strong>${escapeHtml(returnHost)}</strong>.</p>` : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to memrain</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;background:#f6f6f4;color:#1a1a1a;margin:0;display:grid;place-items:center;min-height:100vh}
  main{background:#fff;border:1px solid #ddd;border-radius:10px;padding:2rem;max-width:22rem;width:calc(100% - 2rem)}
  h1{font-size:1.15rem;margin:0 0 .5rem}
  p{margin:0 0 1rem;color:#444}
  input{width:100%;box-sizing:border-box;font:inherit;padding:.6rem .7rem;border:1px solid #bbb;border-radius:6px}
  button{margin-top:.9rem;width:100%;font:inherit;padding:.65rem;border:0;border-radius:6px;background:#1a1a1a;color:#fff;cursor:pointer}
  .err{color:#a40000;margin:0 0 .8rem}
</style></head><body><main>
<h1>Connect to memrain</h1>
${who}${dest}<p>Enter the one-time code you were given.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${action}" autocomplete="off">
<input name="enrollment_code" type="password" autocomplete="one-time-code" autofocus required>
<button type="submit">Connect</button>
</form>
</main></body></html>`;
  return new Response(html, {
    status: error ? 400 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      // Not `no-referrer`: that makes the browser send `Origin: null` on this
      // page's own form POST (Fetch, "append a request Origin header"), and the
      // same-origin guard has to refuse an opaque origin — so the policy meant
      // to protect the page made its only button unusable. `same-origin` keeps
      // the referrer off every cross-origin hop, including the redirect back to
      // the client, and leaves the submit with a real origin.
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      ...NO_STORE,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /register — Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------

/**
 * Dynamic Client Registration. Accepts client metadata as JSON, delegates the
 * security-relevant validation (HTTPS redirect_uris, allowed scopes, allowed
 * auth method) to the provider, and returns the RFC 7591 §3.2.1 response with
 * the freshly minted client_id (+ secret for confidential clients). Rejections
 * map to `invalid_redirect_uri` / `invalid_client_metadata` (§3.2.2).
 */
export async function handleRegisterRoute(
  req: Request,
  provider: OAuthProvider,
  /** /authorize auto-approves: a public client could never be authorized. */
  refusePublicClients = false,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return oauthError(
      "invalid_client_metadata",
      "request body must be JSON",
      400,
    );
  }

  const redirectUris = body.redirect_uris;
  if (redirectUris !== undefined && !Array.isArray(redirectUris)) {
    return oauthError(
      "invalid_redirect_uri",
      "redirect_uris must be an array",
      400,
    );
  }
  const grantTypes = body.grant_types;
  if (grantTypes !== undefined && !Array.isArray(grantTypes)) {
    return oauthError(
      "invalid_client_metadata",
      "grant_types must be an array",
      400,
    );
  }

  // A self-registered client is always client-mode, so a public one is exactly
  // what an auto-approving /authorize refuses. Say so here rather than hand out
  // a client_id that can never complete the flow.
  if (refusePublicClients && body.token_endpoint_auth_method === "none") {
    return oauthError(
      "invalid_client_metadata",
      "public clients (token_endpoint_auth_method 'none') need operator approval at /authorize, which this server does not require; register a confidential client",
      400,
    );
  }

  try {
    const client = await provider.registerClient({
      ...(typeof body.client_name === "string"
        ? { client_name: body.client_name }
        : {}),
      ...(redirectUris
        ? { redirect_uris: (redirectUris as unknown[]).map(String) }
        : {}),
      ...(grantTypes
        ? { grant_types: (grantTypes as unknown[]).map(String) }
        : {}),
      ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
      ...(typeof body.token_endpoint_auth_method === "string"
        ? { token_endpoint_auth_method: body.token_endpoint_auth_method }
        : {}),
    });
    return Response.json(client, { status: 201, headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "invalid client metadata";
    const error = /redirect_uri/i.test(msg)
      ? "invalid_redirect_uri"
      : "invalid_client_metadata";
    return oauthError(error, msg, 400);
  }
}

// ---------------------------------------------------------------------------
// POST /revoke — token revocation (RFC 7009)
// ---------------------------------------------------------------------------

/**
 * Token revocation. Authenticates the client (so a client can only revoke its
 * own tokens, RFC 7009 §2.1) and soft-revokes the token. Per §2.2 the endpoint
 * answers 200 even for an unknown / already-invalid token — it never confirms
 * whether the token existed.
 */
export async function handleRevokeRoute(
  req: Request,
  provider: OAuthProvider,
): Promise<Response> {
  const params = await readParams(req);
  if (!params) return oauthError("invalid_request", "malformed body", 400);
  const token = params.get("token");
  if (!token) return oauthError("invalid_request", "token is required", 400);

  const { clientId, clientSecret } = clientAuthFromRequest(req, params);
  let client: OAuthClientInfo;
  try {
    client = await resolveClient(provider, clientId, clientSecret);
  } catch {
    return oauthError("invalid_client", "client authentication failed", 401);
  }

  const hint = params.get("token_type_hint");
  await provider.revokeToken(client, {
    token,
    ...(hint ? { token_type_hint: hint } : {}),
  });
  return new Response(null, { status: 200, headers: NO_STORE });
}
