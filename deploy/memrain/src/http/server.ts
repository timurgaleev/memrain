/**
 * Bun HTTP server — routes requests, owns the Storage instance lifetime.
 *
 * The surface is deliberately TWO routes (MCP cleanup, Phase A.7):
 *   GET  /health       — liveness + db stats (open on either ingress)
 *   POST /mcp          — MCP JSON-RPC 2.0; all read/write capability lives
 *                        here via `tools/call`. Public callers can't
 *                        discover or invoke the write tools; the internal
 *                        ingress requires `MEMRAIN_INTERNAL_TOKEN`.
 *
 * The legacy REST routes (`/index`, `/search`, `/backlinks`, `/friction`,
 * `/pages/*`, `/graph/*`, `/entities/*`, `/timeline/*`, `/jobs/*`) were
 * removed in A.7 — every one of them is reachable through `/mcp`.
 *
 * Public requests are detected via the `Cf-Connecting-Ip` header set by
 * cloudflared. Every request needs a credential — the public bearer (or an
 * OAuth token, resolved on the 401 fall-through below) from that ingress, the
 * shared internal token from the docker bridge — except for the handful of
 * pre-credential routes. See `http/public_guard.ts`.
 */
import type { Storage } from "../core/storage.ts";
import { handleHealth } from "./health.ts";
import {
  handleOAuthMetadataRoute,
  handleProtectedResourceRoute,
  canonicalResource,
  resolveIssuer,
  wwwAuthenticateChallenge,
  OAUTH_METADATA_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
  OAUTH_PROTECTED_RESOURCE_MCP_PATH,
} from "./oauth-metadata.ts";
import {
  CORS_PATHS,
  parseCorsAllowlist,
  corsPreflightResponse,
  applyCorsHeaders,
} from "./cors.ts";
import { handleIngestRoute } from "./ingest.ts";
import {
  evaluatePublicGuard,
  evaluateInternalAuth,
  isPublicMcpToolForbidden,
} from "./public_guard.ts";
import {
  type OAuthProvider,
  InvalidTokenError,
  oauthRequireLoginFromEnv,
} from "../core/oauth-provider.ts";
import {
  handleTokenRoute,
  handleAuthorizeRoute,
  handleRegisterRoute,
  handleRevokeRoute,
} from "./oauth-endpoints.ts";
import { makeMcpHandler } from "../mcp/http_transport.ts";
import { RateLimiter, type RateLimiterOptions } from "../mcp/rate_limit.ts";
import { resolveClientIp } from "./client-key.ts";
import { createAdminAuth, type AdminAuth } from "./admin.ts";
import { handleAdminApi } from "./admin-api.ts";
import { serveAdminStatic } from "./admin-static.ts";
import { handleAdminEventsRoute } from "./admin-events.ts";
import type { AuthInfo } from "../core/auth-info.ts";

/** RFC 6749 §5.2-style throttle response for the rate-limited OAuth endpoints. */
function rateLimited(): Response {
  return Response.json(
    { error: "slow_down", error_description: "rate limit exceeded" },
    { status: 429, headers: { "Retry-After": "60" } },
  );
}

/**
 * RFC 8707 audience check. A token minted for a named resource is honored only
 * here, at this server; a token with no resource (issued before binding, a
 * PAT, a client_credentials token) never named one and stays valid.
 */
function assertAudience(resource: URL | undefined, issuer: string): void {
  if (resource && canonicalResource(resource.toString(), issuer) === null) {
    throw new InvalidTokenError("Token is bound to a different resource");
  }
}

/** Failed pre-auth attempts per minute for a caller we can name. */
export const ATTRIBUTED_AUTH_ATTEMPT_LIMITS: RateLimiterOptions = {
  capacity: 20,
  refillPerSecond: 20 / 60,
};
/**
 * Same, for the one bucket shared by callers with no resolvable address.
 * Wider — a sprayer in here would otherwise lock out every other such caller —
 * but finite: unmetered is what this fixes.
 */
export const UNATTRIBUTED_AUTH_ATTEMPT_LIMITS: RateLimiterOptions = {
  capacity: 200,
  refillPerSecond: 200 / 60,
};

/** Key of the shared bucket for callers with no resolvable address. */
export const UNATTRIBUTED_RATE_KEY = "unknown";

/**
 * Rate-limit identity for a request, most specific first: the trusted client
 * IP (`Cf-Connecting-Ip`, or the proxy headers when they are trusted), then
 * the socket address — which still separates docker-bridge peers from each
 * other — then one shared bucket. `unattributed` marks that last case so a
 * caller can meter it against its own, wider budget instead of collapsing
 * everyone into a per-IP-sized one.
 */
export function resolveRateLimitBucket(
  clientIp: string | null,
  socketAddress: string | null | undefined,
): { key: string; unattributed: boolean } {
  if (clientIp) return { key: clientIp, unattributed: false };
  if (socketAddress) return { key: socketAddress, unattributed: false };
  return { key: UNATTRIBUTED_RATE_KEY, unattributed: true };
}

/**
 * The limiter a pre-auth attempt is charged against: the shared bucket gets
 * the wider one, everyone else the per-caller one. Split so a sprayer nobody
 * can name burns its own budget instead of the budget of every named caller.
 */
export function attemptLimiterFor(
  bucket: { unattributed: boolean },
  attributed: RateLimiter,
  unattributed: RateLimiter,
): RateLimiter {
  return bucket.unattributed ? unattributed : attributed;
}

export interface ServerOptions {
  host: string;
  port: number;
  storage: Storage;
  /** Mount POST /mcp. Default true. */
  mcpEnabled?: boolean;
  /** Per-IP request limit. Default 60/min (capacity 30, refill 1/s). */
  mcpRateLimitPerMinute?: number;
  /** Per-OAuth-token-id request limit (post-auth), so an authed client can't
   *  rotate IPs to defeat the per-IP cap. Unset → no per-token limiting. */
  mcpRateLimitPerTokenPerMinute?: number;
  /**
   * Bucket for FAILED bearer verifications, keyed by trusted client IP or —
   * failing that — the socket address. Injectable for tests; defaults to 20
   * failed attempts per minute per client.
   */
  authAttemptRateLimiter?: RateLimiter;
  /**
   * Bucket for FAILED bearer verifications from callers with NO resolvable
   * address at all (the shared `unknown` key). Separate and wider so those
   * callers cannot starve each other, but still capped. Injectable for tests.
   */
  unattributedAuthAttemptRateLimiter?: RateLimiter;
  /**
   * Bearer token required on the public Cloudflare ingress. Wire from
   * the `MEMRAIN_PUBLIC_BEARER` env / `<secrets_prefix>/memrain-public-bearer`
   * secret. When unset, internal requests still flow but every public
   * request returns 503 — fail-closed.
   */
  publicBearerToken?: string;
  /**
   * Shared secret required to call MCP write tools (`index`,
   * `log_friction`, `page_*`, `link`/`unlink`, `add_*`, `jobs_*`) on the
   * internal `/mcp` path. Defends the docker-bridge surface from a
   * compromised sibling container. Wire from `MEMRAIN_INTERNAL_TOKEN` env /
   * `<secrets_prefix>/memrain-internal-token`. When unset, internal write
   * tools stay open (legacy single-node behaviour) — a single startup
   * warning is logged; operators should configure the secret.
   */
  internalToken?: string;
  /**
   * memrain's own OAuth 2.1 provider (client_credentials), wired from
   * `config.auth.selfIssued.enabled`. When set, the server mounts POST `/token`
   * and verifies self-issued `memrain_at_…` bearer tokens on the `/mcp` ingress,
   * scoping each request to its registered `oauth_clients` row. This is the
   * auth path that replaces the external-IdP JWT overlay.
   */
  oauthProvider?: OAuthProvider;
  /**
   * Admin surface bootstrap token (increment A1). When set, the `/admin` auth
   * routes are mounted: the operator/agent uses this token to log in or mint a
   * magic link. Omitted → no admin surface.
   */
  adminBootstrapToken?: string;
  /** Public base URL for minted admin magic-links (falls back to the request host). */
  publicUrl?: string;
  /** Maintenance mode is on: `/health` says so (see core/quiescence.ts). */
  maintenance?: boolean;
}

export interface ServerHandle {
  stop: () => Promise<void>;
  port: number;
}

export function startServer(opts: ServerOptions): ServerHandle {
  const mcpEnabled = opts.mcpEnabled !== false;
  const mcpHandler = mcpEnabled
    ? makeMcpHandler({
        storage: opts.storage,
        rateLimiter: opts.mcpRateLimitPerMinute
          ? new RateLimiter({
              refillPerSecond: opts.mcpRateLimitPerMinute / 60,
              capacity: Math.max(10, Math.floor(opts.mcpRateLimitPerMinute / 2)),
            })
          : undefined,
        perTokenRateLimiter: opts.mcpRateLimitPerTokenPerMinute
          ? new RateLimiter({
              refillPerSecond: opts.mcpRateLimitPerTokenPerMinute / 60,
              capacity: Math.max(10, Math.floor(opts.mcpRateLimitPerTokenPerMinute / 2)),
            })
          : undefined,
        forbidPublicTool: isPublicMcpToolForbidden,
      })
    : null;

  // One options object for both ingress classes: the guard picks the public
  // bearer or the internal token per request, but a credential is demanded
  // either way.
  const guardOpts: { bearerToken?: string; internalToken?: string } = {};
  if (opts.publicBearerToken) guardOpts.bearerToken = opts.publicBearerToken;
  if (opts.internalToken) guardOpts.internalToken = opts.internalToken;

  // Per-IP throttle for the unauthenticated OAuth endpoints (/token,
  // /authorize, /revoke) — blunts client_secret brute-force and the DB-load DoS
  // they would otherwise allow (10/min, capacity 10). A separate, stricter
  // limiter guards /register (Dynamic Client Registration), which each request
  // INSERTs a durable oauth_clients row, so it warrants a tighter cap (5/min).
  // Both are only created when the self-issued provider is on.
  const tokenRateLimiter = opts.oauthProvider
    ? new RateLimiter({ capacity: 10, refillPerSecond: 10 / 60 })
    : null;
  const registerRateLimiter = opts.oauthProvider
    ? new RateLimiter({ capacity: 5, refillPerSecond: 5 / 60 })
    : null;
  // POST /ingest webhook capture — 100 events / 10 s per IP.
  const ingestRateLimiter = new RateLimiter({ capacity: 100, refillPerSecond: 10 });
  // Pre-auth brute-force throttle for the token-verification path below.
  // `verifyAccessToken` costs two DB SELECTs and runs only AFTER the public
  // guard REJECTED the request — `guard.allow` is false there, so the /mcp
  // handler (and its rate limiter) never runs and nothing else sheds this
  // load. Only FAILED verifications are charged, so a legitimate client keeps
  // its full budget.
  //
  // EVERY request class is metered. Exempting the callers we cannot attribute
  // (as this did while `attemptKey` could be null) left an unmetered
  // brute-force channel costing two DB round-trips per attempt — the sprayers
  // most worth metering are exactly the ones that present no address. They now
  // fall back to the socket address, and then to one shared `unknown` bucket
  // whose wider capacity keeps a single sprayer from starving the others while
  // still ending in a ceiling.
  const authAttemptLimiter =
    opts.authAttemptRateLimiter ??
    new RateLimiter(ATTRIBUTED_AUTH_ATTEMPT_LIMITS);
  const unattributedAuthAttemptLimiter =
    opts.unattributedAuthAttemptRateLimiter ??
    new RateLimiter(UNATTRIBUTED_AUTH_ATTEMPT_LIMITS);
  // Default-deny CORS allowlist for the OAuth + MCP surface (read once at boot).
  const corsAllowlist = parseCorsAllowlist();

  let adminAuth: AdminAuth | null = null;
  if (opts.adminBootstrapToken && opts.adminBootstrapToken.length > 0) {
    adminAuth = createAdminAuth({
      bootstrapToken: opts.adminBootstrapToken,
      ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
      storage: opts.storage,
      // Names the client behind a parked /authorize so the operator confirms a
      // connection to something they recognize, not to an opaque client_id.
      ...(opts.oauthProvider
        ? {
            describeClient: async (clientId: string) => {
              const c = await opts.oauthProvider!.getClient(clientId);
              // The registered scope is what an authorize request omitting
              // `scope` actually grants — the panel must show that, not "".
              return c ? { client_name: c.client_name, scope: c.scope } : null;
            },
          }
        : {}),
    });
  }

  // Opt-in strict OAuth: require a logged-in operator on /authorize. Default OFF
  // (auto-approve) — see the /authorize handler below.
  const oauthRequireLogin = oauthRequireLoginFromEnv();
  // Dynamic Client Registration is OFF by default. With it off, /register is
  // unavailable and the
  // discovery doc omits registration_endpoint, so the ONLY way a client exists is
  // an operator creating it via `memrain auth register-client` — nobody can
  // self-register a client over the network. Enable with MEMRAIN_ENABLE_DCR=1.
  // MEMRAIN_ENABLE_DCR_INSECURE additionally lets a self-registered client request
  // the client_credentials grant, which mints a token WITHOUT the /authorize
  // consent step. It implies DCR (there is nothing to loosen otherwise).
  const dcrInsecure =
    ((process.env.MEMRAIN_ENABLE_DCR_INSECURE ?? "").trim().toLowerCase() === "1" ||
      (process.env.MEMRAIN_ENABLE_DCR_INSECURE ?? "").trim().toLowerCase() === "true");
  const dcrEnabled =
    dcrInsecure ||
    (process.env.MEMRAIN_ENABLE_DCR ?? "").trim().toLowerCase() === "1" ||
    (process.env.MEMRAIN_ENABLE_DCR ?? "").trim().toLowerCase() === "true";

  // A self-registered (DCR) client that completes the authorization_code flow
  // still receives a real, default-tenant token. That grant only carries
  // operator consent when /authorize is gated on a logged-in operator — i.e.
  // MEMRAIN_OAUTH_REQUIRE_LOGIN=1 AND an admin mechanism is configured. When
  // /authorize auto-approves, an unauthenticated caller can register + run PKCE
  // + walk away with read/write on the default tenant, no operator in the loop.
  // Fail closed: refuse to boot with DCR on and consent off unless the operator
  // has explicitly acknowledged the machine-to-machine posture.
  const authorizeAutoApproves = !(oauthRequireLogin && adminAuth);
  if (dcrEnabled && authorizeAutoApproves && !dcrInsecure) {
    throw new Error(
      "MEMRAIN_ENABLE_DCR is set but /authorize auto-approves, so a self-" +
        "registered client would obtain a token with no operator consent. " +
        "Set MEMRAIN_OAUTH_REQUIRE_LOGIN=1 (with MEMRAIN_ADMIN_BOOTSTRAP) to gate " +
        "/authorize on a logged-in operator, or set MEMRAIN_ENABLE_DCR_INSECURE=1 " +
        "to accept unauthenticated self-registration.",
    );
  }
  // A public client-mode client registered before /authorize started refusing
  // them (or rescoped into that shape) cannot connect any more. Name them so
  // the operator is not left guessing why; never block boot on it.
  const bootProvider = opts.oauthProvider;
  if (authorizeAutoApproves && bootProvider) {
    Promise.resolve()
      .then(() => bootProvider.listClientsNeedingConsent())
      .then((clients) => {
        if (clients.length === 0) return;
        console.error(
          "[memrain] WARNING: /authorize auto-approves, so it refuses these public " +
            "client-mode clients (no secret, PKCE alone): " +
            clients.map((c) => `${c.client_id} (${c.client_name})`).join(", ") +
            ". Re-register them as confidential clients, move them to " +
            "--tenant-mode enrollment, or set MEMRAIN_OAUTH_REQUIRE_LOGIN=1.",
        );
      })
      .catch((e: unknown) => {
        console.warn(
          "[memrain] public-client check skipped: " +
            (e instanceof Error ? e.message : String(e)),
        );
      });
  }
  if (oauthRequireLogin && !adminAuth) {
    console.error(
      "[memrain] WARNING: MEMRAIN_OAUTH_REQUIRE_LOGIN=1 but no admin surface is " +
        "configured (MEMRAIN_ADMIN_BOOTSTRAP is unset), so no operator can ever " +
        "approve an authorization. /authorize refuses every request until a " +
        "bootstrap token is set.",
    );
  }
  if (dcrEnabled) {
    console.error(
      "[memrain] WARNING: Dynamic Client Registration is ON — any network " +
        "caller can self-register an OAuth client via POST /register. " +
        "Self-registered clients get the authorization_code grant; that grant " +
        "carries operator consent only while MEMRAIN_OAUTH_REQUIRE_LOGIN=1 gates " +
        "/authorize on a logged-in operator.",
    );
  }
  if (dcrInsecure) {
    console.error(
      "[memrain] WARNING: MEMRAIN_ENABLE_DCR_INSECURE is ON — self-registered " +
        "clients may request the client_credentials grant, and /authorize " +
        "consent is not required, so an unauthenticated caller can obtain a " +
        "default-tenant token with no operator in the loop.",
    );
  }
  const internalAuthOpts: { internalToken?: string } = {};
  if (opts.internalToken) {
    internalAuthOpts.internalToken = opts.internalToken;
  } else {
    console.warn(
      "[memrain] WARNING: MEMRAIN_INTERNAL_TOKEN not configured — MCP write " +
        "tools (index, log_friction, page_*, link, add_*, jobs_*) are open " +
        "to any peer on the docker bridge. Configure the token via " +
        "<secrets_prefix>/memrain-internal-token (legacy: memex-internal-token) + fetch-secrets.sh.",
    );
  }

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch: async (req, server) => {
      const url = new URL(req.url);

      // CORS preflight — answered BEFORE auth: preflights carry no
      // credentials by design, so the bearer guard would 401 every browser
      // client. 204 either way; grant headers only for allowlisted origins.
      if (req.method === "OPTIONS" && CORS_PATHS.has(url.pathname)) {
        return corsPreflightResponse(req, corsAllowlist);
      }

      const handle = async (): Promise<Response> => {

      let guard = evaluatePublicGuard(req, url, guardOpts);
      let oauthAuth: AuthInfo | undefined;
      if (!guard.allow) {
        // Self-issued provider (preferred path). A `memrain_at_…` token is opaque
        // (not a JWS), so it must be verified here, not by the JWT verifier. On
        // success the request is a TRUSTED registered client scoped to its own
        // `oauth_clients` row — unredacted read within that source scope
        // (isPublic:false); writes stay gated by the internal-token path.
        // Every bearer is offered to the verifier (/mcp sits behind
        // requireBearerAuth with no prefix filter) — the provider's
        // fallback resolves legacy access_tokens PATs (`memrain_…`, `memex_…`),
        // whose tenant scope comes from `permissions.source_id`. A non-token string just
        // misses both hash lookups and falls through to the 401 below.
        if (opts.oauthProvider && guard.status === 401) {
          const m = /^Bearer (.+)$/.exec(
            req.headers.get("Authorization") ?? "",
          );
          if (m && m[1]) {
            // Throttle BEFORE the lookup. `retryAfterSeconds` is a
            // non-consuming peek: it reads > 1 only while the bucket is empty.
            // A request carrying no bearer at all never reaches this line, so
            // ordinary unauthenticated 401s stay free.
            const attempt = resolveRateLimitBucket(
              resolveClientIp(req),
              server.requestIP(req)?.address,
            );
            const attemptLimiter = attemptLimiterFor(
              attempt,
              authAttemptLimiter,
              unattributedAuthAttemptLimiter,
            );
            const retryAfter = attemptLimiter.retryAfterSeconds(attempt.key);
            if (retryAfter > 1) {
              return Response.json(
                { ok: false, error: "too many authentication attempts" },
                { status: 429, headers: { "Retry-After": String(retryAfter) } },
              );
            }
            try {
              const info = await opts.oauthProvider.verifyAccessToken(m[1]);
              assertAudience(info.resource, resolveIssuer(url, opts.publicUrl));
              guard = { allow: true, isPublic: false };
              oauthAuth = {
                token: info.token,
                clientId: info.clientId,
                scopes: info.scopes,
                ...(info.sourceId != null ? { sourceId: info.sourceId } : {}),
                ...(info.allowedSources != null
                  ? { allowedSources: info.allowedSources }
                  : {}),
                ...(info.takesHolders != null
                  ? { takesHolders: info.takesHolders }
                  : {}),
                ...(info.boundSlugPrefixes != null
                  ? { boundSlugPrefixes: info.boundSlugPrefixes }
                  : {}),
                budgetUsdPerDay: info.budgetUsdPerDay,
                ...(info.spendId ? { spendId: info.spendId } : {}),
                isPublic: false,
              };
            } catch (e) {
              // Charge the failure. A verifier that is failing for its OWN
              // reasons (DB outage) is exactly when shedding load matters, so
              // both error classes count against the bucket.
              attemptLimiter.allow(attempt.key);
              // InvalidTokenError = a bad/expired token: fall through to the
              // public path silently. ANY OTHER error (DB outage, provider bug)
              // is still fail-closed to public, but MUST be logged — otherwise an
              // incident is indistinguishable from a routine bad token.
              if (!(e instanceof InvalidTokenError)) {
                console.error(
                  "[memrain] self-issued token verification error:",
                  e,
                );
              }
            }
          }
        }
      }
      if (!guard.allow) {
        // RFC 9728 §5.1: a 401 on the MCP resource carries a WWW-Authenticate
        // challenge pointing at the protected-resource metadata, so a
        // standards-aware OAuth client can bootstrap the flow unattended.
        const headers: Record<string, string> = {};
        if (url.pathname === "/mcp" && guard.status === 401) {
          headers["WWW-Authenticate"] = wwwAuthenticateChallenge(
            resolveIssuer(url, opts.publicUrl),
            req.headers.has("Authorization"),
          );
        }
        return Response.json(
          { ok: false, error: guard.reason },
          { status: guard.status, headers },
        );
      }

      if (url.pathname === "/health" && req.method === "GET") {
        return handleHealth(opts.storage, opts.maintenance === true);
      }
      // OAuth 2.1 discovery (RFC 8414) — public, lets a standard MCP OAuth
      // client auto-configure from memrain's own public base URL. The guard
      // above already exempts this path from the bearer requirement.
      if (url.pathname === OAUTH_METADATA_PATH && req.method === "GET") {
        return handleOAuthMetadataRoute(url, opts.publicUrl, dcrEnabled);
      }
      // RFC 9728 protected-resource metadata — public for the same reason.
      if (
        (url.pathname === OAUTH_PROTECTED_RESOURCE_PATH ||
          url.pathname === OAUTH_PROTECTED_RESOURCE_MCP_PATH) &&
        req.method === "GET"
      ) {
        return handleProtectedResourceRoute(url, opts.publicUrl);
      }
      // Any other discovery probe (openid-configuration, a path-inserted AS
      // document, …) is a document memrain does not publish — say so, rather
      // than a 401 that tells a client to go and authenticate for it.
      if (url.pathname.startsWith("/.well-known/") && req.method === "GET") {
        return Response.json(
          { error: "not_found" },
          { status: 404, headers: { "Cache-Control": "no-store" } },
        );
      }
      // OAuth 2.1 authorization endpoints. Public (exempted in the guard) —
      // authenticated by client_id/secret + PKCE downstream, NOT the public
      // bearer. Only mounted when the self-issued provider is enabled; each is
      // per-IP rate-limited (brute-force / DCR-abuse / DoS defense).
      if (opts.oauthProvider) {
        const oauthProvider = opts.oauthProvider;
        // Per-CLIENT, not per-socket: behind cloudflared or Caddy every request
        // shares one proxy socket address, which collapsed the whole internet
        // into a single 10/min bucket on /token — both a trivial lockout of
        // legitimate clients and the opposite of the per-IP cap documented
        // above. Fall back to the socket for callers with no trusted client IP
        // (docker-bridge peers), which still distinguishes them from each other.
        const ip = resolveRateLimitBucket(
          resolveClientIp(req),
          server.requestIP(req)?.address,
        ).key;
        if (url.pathname === "/token" && req.method === "POST") {
          if (tokenRateLimiter && !tokenRateLimiter.allow(ip)) {
            // Throttling here is silent otherwise, and the silence is the same
            // silence as "the client never called" — which sent a connector
            // diagnosis down the wrong path. The bucket key is an IP, and an IP
            // reaching a public endpoint is already in every proxy's log.
            console.warn(`[oauth] POST /token rate-limited for bucket ${ip}`);
            return rateLimited();
          }
          return handleTokenRoute(
            req,
            oauthProvider,
            !oauthRequireLogin,
            resolveIssuer(url, opts.publicUrl),
          );
        }
        // POST is the enrollment-code submission for an enrollment-mode
        // client; the handler rejects it for every other client.
        if (url.pathname === "/authorize" && (req.method === "GET" || req.method === "POST")) {
          if (tokenRateLimiter && !tokenRateLimiter.allow(ip)) {
            console.warn(`[oauth] ${req.method} /authorize rate-limited for bucket ${ip}`);
            return rateLimited();
          }
          // Auto-approve by default, so a standard MCP client
          // completes the flow unattended. Opt into the stricter operator-login
          // gate with MEMRAIN_OAUTH_REQUIRE_LOGIN=1 — then a code is only minted
          // for a logged-in admin who ALSO approved this exact request from the
          // dashboard. The session alone is not consent: anything able to
          // navigate the operator's browser same-site (a sibling subdomain, a
          // stale tab) would otherwise mint a code in silence. Without the
          // approval the request bounces to the dashboard, which shows who is
          // asking and where the code would go.
          const ad = adminAuth;
          const requireLogin = !oauthRequireLogin
            ? () => true
            : ad
              ? (r: Request) => ad.requireAdmin(r) && ad.consumeAuthorizeApproval(r)
              // Asked to gate on an operator with no admin surface to gate on:
              // refuse every request rather than silently auto-approving the
              // posture the flag exists to prevent.
              : () => false;
          return handleAuthorizeRoute(
            req,
            oauthProvider,
            requireLogin,
            !oauthRequireLogin,
            resolveIssuer(url, opts.publicUrl),
          );
        }
        if (url.pathname === "/register" && req.method === "POST") {
          // DCR off (default) → no self-registration surface at all.
          if (!dcrEnabled) {
            return Response.json(
              {
                error: "not_found",
                error_description:
                  "dynamic client registration is disabled; an operator registers clients via the CLI",
              },
              { status: 404, headers: { "Cache-Control": "no-store" } },
            );
          }
          if (registerRateLimiter && !registerRateLimiter.allow(ip)) {
            return rateLimited();
          }
          return handleRegisterRoute(req, oauthProvider, authorizeAutoApproves);
        }
        if (url.pathname === "/revoke" && req.method === "POST") {
          if (tokenRateLimiter && !tokenRateLimiter.allow(ip)) {
            return rateLimited();
          }
          return handleRevokeRoute(req, oauthProvider);
        }
      }
      // POST /ingest — webhook capture (OAuth write scope). The guard above
      // resolved OAuth bearers on the public path; internal callers (no
      // Cf-Connecting-Ip) present theirs here, so both ingress classes reach
      // the handler with a resolved identity. Everything else — scope check,
      // byte cap, content-type allowlist, idempotent job — lives in ingest.ts.
      if (url.pathname === "/ingest" && req.method === "POST") {
        let ingestAuth = oauthAuth;
        if (!ingestAuth && opts.oauthProvider) {
          const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
          if (m && m[1]) {
            try {
              const info = await opts.oauthProvider.verifyAccessToken(m[1]);
              assertAudience(info.resource, resolveIssuer(url, opts.publicUrl));
              ingestAuth = {
                token: info.token,
                clientId: info.clientId,
                scopes: info.scopes,
                ...(info.sourceId != null ? { sourceId: info.sourceId } : {}),
                ...(info.allowedSources != null
                  ? { allowedSources: info.allowedSources }
                  : {}),
                ...(info.takesHolders != null
                  ? { takesHolders: info.takesHolders }
                  : {}),
                ...(info.boundSlugPrefixes != null
                  ? { boundSlugPrefixes: info.boundSlugPrefixes }
                  : {}),
                budgetUsdPerDay: info.budgetUsdPerDay,
                ...(info.spendId ? { spendId: info.spendId } : {}),
                isPublic: guard.isPublic,
              };
            } catch (e) {
              if (!(e instanceof InvalidTokenError)) {
                console.error("[memrain] /ingest token verification error:", e);
              }
            }
          }
        }
        const ip = resolveRateLimitBucket(
          resolveClientIp(req),
          server.requestIP(req)?.address,
        ).key;
        return handleIngestRoute(req, {
          storage: opts.storage,
          ...(ingestAuth !== undefined ? { authInfo: ingestAuth } : {}),
          allowRequest: () => ingestRateLimiter.allow(ip),
          clientIp: ip,
        });
      }
      if (url.pathname === "/mcp" && mcpHandler) {
        // Evaluate the internal-token gate once per request; the handler
        // enforces it only for write tools on the internal path (read
        // tools and public traffic ignore it). `allow` is true when the
        // token is unconfigured (legacy fallthrough) or correctly sent.
        // The guard above already turned away a bare internal caller, so what
        // reaches here without the token is a principal the OAuth path
        // resolved — the handler judges those on scope, not on this bit.
        const ia = evaluateInternalAuth(req, internalAuthOpts);
        return mcpHandler(req, {
          isPublic: guard.isPublic,
          internalAuthOk: ia.allow,
          ...(oauthAuth !== undefined ? { authInfo: oauthAuth } : {}),
          issuer: resolveIssuer(url, opts.publicUrl),
        });
      }
      if (adminAuth && (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))) {
        // A1 auth routes, then A2 data/provisioning routes (each gates on
        // requireAdmin itself). The embedded SPA (B/C) dispatches here later.
        const r = await adminAuth.handleAuthRoute(req, url);
        if (r) return r;
        const r2 = await handleAdminApi(req, url, {
          storage: opts.storage,
          requireAdmin: adminAuth.requireAdmin,
          sessionCooldown: adminAuth.sessionCooldown,
          ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
        });
        if (r2) return r2;
        // SSE live-activity feed (deferred #2) — requireAdmin-gated.
        const rsse = handleAdminEventsRoute(req, adminAuth.requireAdmin);
        if (rsse) return rsse;
        // C: the built SPA (static dist + index.html fallback). Auth + the data
        // API above win; everything else under /admin is the front-end. GET only.
        if (req.method === "GET") {
          const r3 = await serveAdminStatic(url);
          if (r3) return r3;
        }
      }
      return new Response("Not Found", { status: 404 });

      };
      const res = await handle();
      // Stamp the allow-origin grant on actual responses for the OAuth/MCP
      // surface (allowlisted origins only — default deny).
      return CORS_PATHS.has(url.pathname)
        ? applyCorsHeaders(res, req, corsAllowlist)
        : res;
    },
    error(err) {
      console.error("[memrain] server error:", err);
      return new Response("Internal Server Error", { status: 500 });
    },
  });
  const flags = [
    mcpEnabled ? "MCP" : "",
    opts.publicBearerToken ? "public-bearer" : "",
  ]
    .filter(Boolean)
    .join(", ");
  console.log(
    `[memrain] listening on http://${opts.host}:${opts.port}${flags ? ` (${flags})` : ""}`,
  );
  return {
    port: server.port ?? opts.port,
    stop: async () => {
      await server.stop(true);
    },
  };
}
