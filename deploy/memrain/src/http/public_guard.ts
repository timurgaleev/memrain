/**
 * Ingress guard — every request presents a credential; the ingress class
 * decides WHICH one, never WHETHER one is checked.
 *
 * Classification: a request from the Cloudflare edge carries a
 * `Cf-Connecting-Ip` header (the real client IP). Internal Docker
 * traffic (recipe / worker callers) hits the bridge network
 * directly and never goes through Cloudflare, so it lacks this header.
 * The class picks the credential — public bearer vs the shared
 * `MEMRAIN_INTERNAL_TOKEN` (`evaluateInternalAuth`) — and drives body
 * redaction plus rate-limit keying downstream. It does NOT decide whether
 * auth happens: a misclassified request meets a different token, not an
 * open door. The only unauthenticated surface is `isPreCredentialRoute`.
 * NON-CLOUDFLARE INGRESS: behind a proxy that does not inject the header,
 * every request classifies internal and is judged against the internal
 * token — set `MEMRAIN_ASSUME_PUBLIC=1` (or inject `Cf-Connecting-Ip` at the
 * proxy) so remote callers are redacted like the public callers they are.
 * See `assumePublicIngress` below and docs/DEPLOYMENT.md.
 *
 * Public-request rules:
 *   1. `/health` GET — open (used by uptime probes).
 *   2. Anything else — requires `Authorization: Bearer <token>`.
 *      Token comes from `MEMRAIN_PUBLIC_BEARER` env (populated by
 *      fetch-secrets.sh from the `<secrets_prefix>/memrain-public-bearer`
 *      Secrets Manager entry).
 *   3. **Mutating routes are rejected by default** even with a valid
 *      bearer (POST /index, POST /friction, MCP tools/call
 *      name=index|log_friction). Set env `MEMRAIN_PUBLIC_WRITE=1`
 *      to opt the public route into write access — pair this with
 *      daily bearer rotation (`scripts/rotate-memrain-public-bearer.sh`)
 *      so a leaked token gets invalidated within 24h.
 *
 * If the env has no bearer token AND the request is public → 503.
 * Operators MUST configure the secret before exposing the route.
 */

import { timingSafeEqual } from "node:crypto";
// Canonical definition lives in core so the MCP layer shares it without
// importing this http/ module (which would create an import cycle).
import { publicReadBodiesAllowed } from "../core/public_redaction.ts";

export interface PublicGuardOptions {
  /** Bearer token. If undefined, every public request is rejected. */
  bearerToken?: string;
  /**
   * Shared token for requests classified INTERNAL (see `evaluateInternalAuth`).
   * Undefined keeps the legacy fall-through — internal callers are waved
   * through, which is why serve.ts logs a loud warning at boot.
   */
  internalToken?: string;
}

export interface GuardDecision {
  allow: true;
  /** True iff this request came from the public Cloudflare ingress. */
  isPublic: boolean;
}

export interface GuardRejection {
  allow: false;
  status: number;
  reason: string;
}

// Defense-in-depth relic. These REST write routes were removed in A.7 —
// memrain's only HTTP surface today is `GET /health` + `POST /mcp` (see
// http/server.ts), so none of these paths route to a handler anymore and
// this set can never match a real request. It is kept (not deleted) as a
// fail-closed backstop: the north-star forbids re-adding non-`/mcp` HTTP
// routes, and if that rule is ever violated by accident, a public write to
// one of these paths is rejected with 403 rather than silently served.
// MCP write-tool protection lives in FORBIDDEN_MCP_TOOLS_FROM_PUBLIC below,
// which IS on the live path.
const FORBIDDEN_PATHS_FROM_PUBLIC = new Set([
  "/index",
  "/friction",
  "/pages/put",
  "/pages/append",
  "/pages/delete",
  "/graph/link",
  "/graph/unlink",
  "/entities/facts/add",
  "/timeline/add",
  "/jobs/submit",
  "/jobs/cancel",
]);

// Constructive knowledge-writes the public/authenticated ingress MAY perform
// when MEMRAIN_PUBLIC_WRITE=1. Remote callers can ADD knowledge (pages, facts,
// links, tags). The destructive ops (page_delete/restore/revert, unlink,
// remove_tag, purge_deleted_pages, forget_fact) are never reachable from the
// static public bearer, but ARE callable by an authenticated token whose
// granted scope covers them (write; purge_deleted_pages: admin). Delete and
// restore are `scope: write` and purge is
// `scope: admin`; the delete stays a soft-delete with a recovery window, purge
// is the admin-only hard delete. These appear in the public tools/list and are
// reachable ONLY while the flag is on; with the flag off they are forbidden
// exactly as before.
const PUBLIC_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "index",
  "page_put",
  "page_append",
  "page_edit",
  "add_fact",
  "add_timeline_event",
  "add_tag",
  "link",
]);

const FORBIDDEN_MCP_TOOLS_FROM_PUBLIC: ReadonlySet<string> = new Set([
  // Destructive writes — never reachable from public, even with the write flag.
  "log_friction",
  "page_delete",
  "page_restore",
  "page_revert",
  "unlink",
  "remove_tag",
  // get_chunks returns raw chunk CONTENT — the public ingress redacts content
  // everywhere else, so it must be internal-only (a read, but a content read).
  "get_chunks",
  // get_tags returns author-authored tag labels (can encode private terms, e.g.
  // a client name) — a new free-text class on the public path; internal-only,
  // consistent with the privacy-max redaction posture.
  "get_tags",
  // resolve_slugs + relational_recall surface PAGE slugs (people/<name>,
  // companies/<name>) — exactly the author-written identifiers the public search
  // path deliberately suppresses (page:// hits are filtered on public ingress).
  // Internal-only so they can't re-expose / enumerate the private slug + typed
  // relationship graph through the public bearer.
  "resolve_slugs",
  "relational_recall",
  // Wave-1 reads that surface page slugs/titles or fact free-text — the same
  // author-written identifiers/content the public path suppresses everywhere
  // else. get_links exposes the slug graph; find_* + get_recent_salience list
  // page slugs/titles; recall returns fact text + an entity slug. Internal-only,
  // consistent with resolve_slugs / relational_recall / get_chunks.
  "get_links",
  "find_orphans",
  "find_experts",
  "find_contradictions",
  "find_trajectory",
  "get_recent_salience",
  "find_anomalies",
  "recall",
  // forget_fact + purge_deleted_pages are WRITES; query returns full SearchHit
  // bodies (the content public search redacts). All internal-only.
  "forget_fact",
  "purge_deleted_pages",
  "query",
  // code_callers/code_callees/code_def/code_refs/code_blast/code_flow surface
  // indexed source paths + symbol names — private repo structure; internal-only,
  // consistent with the slug/content set.
  "code_callers",
  "code_callees",
  "code_def",
  "code_refs",
  "code_blast",
  "code_flow",
  // volunteer_context surfaces page slugs/titles + synopses (the same
  // author-written identifiers/content the public path suppresses); internal-only.
  "volunteer_context",
  // context_pack returns entity titles, fact text and timeline events for the
  // caller's grant — note-derived content the public path never serves.
  "context_pack",
  // advisor surfaces operational state (pending migrations, job queue, embed
  // coverage, internal-auth config) — private infra, internal-only.
  "advisor",
  // Synthesized content is LLM-derived FROM the user's private notes — list it
  // only internally, same posture as the note surfaces it summarizes.
  "list_concepts",
  "list_takes",
  // takes_search returns the SAME synth_takes.claim_text as list_takes (LLM-derived
  // private opinions about real people/companies) — it slipped the list while its
  // siblings were forbidden, re-opening the leak. set_take_status is a tenancy-
  // unscoped WRITE ("Internal-only" by its own description) that could flip any
  // take's review status brain-wide from the public bearer. Both internal-only.
  "takes_search",
  "set_take_status",
  "get_calibration_profile",
  // Take aggregates + on-demand fact extraction expose the same private-note-
  // derived signal as the reads above; extract_facts can even re-derive a
  // page's fact text (and spends Bedrock), so it must never be public.
  "takes_scorecard",
  "takes_calibration",
  "extract_facts",
  // Returns author-written slugs + titles of ingested transcripts — same
  // slug-listing privacy posture as find_orphans / get_recent_salience.
  "get_recent_transcripts",
  "jobs_submit",
  "jobs_cancel",
  // Tenant agent jobs run under an OAuth client's grant; the static public
  // bearer has no grant to run them under.
  "submit_agent",
  "get_agent_job",
  // Stage-2 surface: think synthesizes over private notes (and spends Bedrock);
  // fact_supersessions is fact free-text; raw_data carries importer payloads;
  // job lifecycle + sources/status/doctor snapshots expose operational state.
  // All internal-only, consistent with the sets above.
  "think",
  "fact_supersessions",
  "put_raw_data",
  "get_raw_data",
  "retry_job",
  "get_job_progress",
  // Job-queue reads + whole-brain counts expose operational state (get_stats /
  // get_job / list_jobs / job_logs are admin-tier). They previously
  // relied on OPERATOR_ONLY_TOOLS, which only gates OAuth-tenant callers
  // (authInfo present) — the static public bearer is authInfo===undefined, so
  // only this denylist covers it: forbid from public.
  "jobs_list",
  "jobs_get",
  "jobs_logs",
  "stats",
  "sources_list",
  "sources_status",
  "get_status_snapshot",
  "run_doctor",
  // get_ingest_log returns source_ref (author-written file paths / URLs / slugs)
  // + summary free-text across sources — the same private identifiers the public
  // path suppresses; on the unscoped public bearer it would read the whole-brain
  // ingest log. log_ingest is a WRITE (appends audit rows). Both internal-only.
  "get_ingest_log",
  "log_ingest",
  // Life Chronicle surface — timeline reads + per-entity dimensional ontology.
  // The whole surface is internal-only: it projects diary/event interiority and
  // author-written entity slugs the public path suppresses everywhere else, and
  // diary interiority must never be publicly reachable even in a redacted form.
  // ontology_propose / chronicle_backfill are WRITES; the rest are reads over
  // private-note-derived signal.
  "chronicle_day",
  "chronicle_since",
  "chronicle_on_this_day",
  "chronicle_last_seen",
  "ontology_get",
  "ontology_propose",
  "ontology_dimensions",
  "ontology_conflicts",
  "volunteer_chronicle",
  "chronicle_backfill",
]);

/**
 * When `MEMRAIN_PUBLIC_WRITE=1` is set in the runtime env, the
 * public route accepts write traffic too. Read-once at module init
 * — flip the env + restart the container to change.
 */
function publicWriteAllowed(): boolean {
  const v = (process.env["MEMRAIN_PUBLIC_WRITE"] ?? "").trim();
  return v === "1" || v.toLowerCase() === "true";
}


/**
 * MEMRAIN_ASSUME_PUBLIC=1 — classify EVERY HTTP request as public, regardless
 * of the `Cf-Connecting-Ip` header.
 *
 * The header heuristic below is correct only when the ingress is a
 * Cloudflare Tunnel (the edge always injects the header, and internal
 * docker-bridge peers never carry it). Behind any OTHER reverse proxy
 * (Caddy, nginx, an ALB) that does not inject the header, every request
 * looks internal: it is still judged against `MEMRAIN_INTERNAL_TOKEN`, but
 * a remote caller holding that token would read UNREDACTED bodies and the
 * internal-only tool set — a privacy degradation, not an auth bypass.
 *
 * Set this flag on any non-Cloudflare deployment (or inject the header at
 * the proxy — belt and braces do both). Caveat: with the flag on, sibling
 * containers on the docker bridge are ALSO treated as public, so the
 * internal REST routes (/index, /friction) stop being reachable without
 * the public-write opt-in — single-container deployments are unaffected.
 */
function assumePublicIngress(): boolean {
  const v = (process.env["MEMRAIN_ASSUME_PUBLIC"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function isPublicRequest(req: Request): boolean {
  if (assumePublicIngress()) return true;
  // Public ingress is detected by Cloudflare's `Cf-Connecting-Ip`
  // header. An empty value is treated as still-public (a defence
  // against an attacker setting the header to "" hoping we treat them
  // as internal); only a missing header counts as internal.
  return req.headers.get("Cf-Connecting-Ip") !== null;
}

/**
 * Internal-route auth — requests classified "internal" must carry a
 * matching shared token. Without this check, any peer on the docker
 * bridge (compromised sibling container or future host bind on :18790)
 * reaches the whole read surface — and every write tool — with no auth
 * at all. The shared secret is loaded from `MEMRAIN_INTERNAL_TOKEN` env
 * (populated by fetch-secrets.sh from
 * `<secrets_prefix>/memrain-internal-token`).
 *
 * Fail-closed: when the token is configured but a request lacks the
 * matching `Authorization: Bearer <internal-token>` header, the
 * request is rejected with 401. When the env var is unset the gate
 * is open (legacy single-node installs); operators are urged to
 * configure the secret.
 */
export interface InternalAuthOptions {
  internalToken?: string;
}

export function evaluateInternalAuth(
  req: Request,
  opts: InternalAuthOptions,
): GuardDecision | GuardRejection {
  if (!opts.internalToken || opts.internalToken.length === 0) {
    // Legacy fall-through. Loud warning logged once at startup; do
    // not also log per request (would spam at MCP traffic rates).
    return { allow: true, isPublic: false };
  }
  const auth = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${opts.internalToken}`;
  if (!timingSafeEqualStrings(auth, expected)) {
    return {
      allow: false,
      status: 401,
      reason: "internal endpoint requires the shared internal token",
    };
  }
  return { allow: true, isPublic: false };
}

/**
 * The routes a caller must reach BEFORE it holds any credential. They are the
 * ONLY unauthenticated surface, and they are exempt on BOTH ingress classes —
 * the docker healthcheck probes /health with no token, and an internal caller
 * mints its first token at /token.
 *
 * Every one of them authenticates itself downstream or exposes nothing:
 *   - GET /health — liveness + counts, used by uptime probes.
 *   - OAuth discovery (RFC 8414 / RFC 9728) — static metadata documents, at
 *     both protected-resource paths; any other /.well-known/ GET is a 404.
 *   - /authorize, /token, /register, /revoke — client authentication, PKCE
 *     S256 and the exact-match redirect_uri allowlist live in the handlers.
 *     POST /authorize is the enrollment-code submission: the person arrives
 *     from the connector with no bearer of her own — the code IS her
 *     credential — and the handler checks same-origin before it claims one.
 *   - /admin* — own cookie + magic-link session (http/admin.ts), enforced by
 *     the admin handler on every route.
 */
function isPreCredentialRoute(req: Request, url: URL): boolean {
  if (url.pathname === "/health" && req.method === "GET") return true;
  // Every GET under /.well-known/ is discovery: the two OAuth documents are
  // served, anything else answers 404 — a probe must not be told to
  // authenticate for a document that does not exist.
  if (url.pathname.startsWith("/.well-known/") && req.method === "GET") {
    return true;
  }
  if (
    (url.pathname === "/authorize" && (req.method === "GET" || req.method === "POST")) ||
    (url.pathname === "/token" && req.method === "POST") ||
    (url.pathname === "/register" && req.method === "POST") ||
    (url.pathname === "/revoke" && req.method === "POST")
  ) {
    return true;
  }
  return url.pathname === "/admin" || url.pathname.startsWith("/admin/");
}

export function evaluatePublicGuard(
  req: Request,
  url: URL,
  opts: PublicGuardOptions,
): GuardDecision | GuardRejection {
  const isPublic = isPublicRequest(req);

  // Checked before the split: these routes precede any credential on either
  // ingress. `isPublic` still rides along so redaction stays correct.
  if (isPreCredentialRoute(req, url)) {
    return { allow: true, isPublic };
  }

  // Internal — the shared internal token IS the credential here. Auth must not
  // hinge on the ingress guess: without this, a request that merely lacked
  // `Cf-Connecting-Ip` (any docker-bridge peer, any non-Cloudflare proxy) got
  // the whole read surface with no credential at all. Fails open only when the
  // token is unconfigured, which serve.ts announces loudly at boot.
  if (!isPublic) {
    return evaluateInternalAuth(req, { internalToken: opts.internalToken });
  }

  // Public — apply guard.
  if (
    FORBIDDEN_PATHS_FROM_PUBLIC.has(url.pathname) &&
    !publicWriteAllowed()
  ) {
    return {
      allow: false,
      status: 403,
      reason: `route ${url.pathname} is internal-only (set MEMRAIN_PUBLIC_WRITE=1 to opt in)`,
    };
  }

  if (!opts.bearerToken || opts.bearerToken.length === 0) {
    return {
      allow: false,
      status: 503,
      reason: "public bearer token not configured",
    };
  }

  const auth = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${opts.bearerToken}`;
  if (!timingSafeEqualStrings(auth, expected)) {
    return {
      allow: false,
      status: 401,
      reason: "missing or invalid bearer token",
    };
  }

  return { allow: true, isPublic: true };
}

/**
 * Constant-time string comparison. A simple `a !== b` short-circuits on
 * the first differing byte, leaking the prefix-match length to a
 * timing-sensitive attacker — relevant because the public bearer is
 * fronted by Cloudflare. We compare two equal-length Buffers via
 * Node's timingSafeEqual; if the lengths differ we still do a dummy
 * compare so the timing remains uniform.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  // Bearer tokens are ASCII (URL-safe random alphanumerics), so UTF-8
  // byte length == char count. Buffer.from is constant-time-ish per
  // input byte; the dummy compare below masks the secret's length.
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Burn cycles against a buffer matching the SECRET's length, not
    // the attacker's. Attacker can vary their own input length but the
    // mismatch path's compute is always proportional to |b|.
    const dummy = Buffer.alloc(bBuf.length);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * MCP tools/call extra check — even with a valid bearer, mutating tools are
 * rejected from public requests by default. `MEMRAIN_PUBLIC_WRITE=1` opens ONLY
 * the constructive PUBLIC_WRITE_TOOLS (index / page_put / page_append / page_edit /
 * add_fact / add_timeline_event / add_tag / link). The always-internal set
 * (destructive writes + privacy-sensitive content/identifier reads) stays
 * forbidden regardless of the flag.
 */
export function isPublicMcpToolForbidden(toolName: string): boolean {
  if (FORBIDDEN_MCP_TOOLS_FROM_PUBLIC.has(toolName)) return true;
  if (PUBLIC_WRITE_TOOLS.has(toolName)) return !publicWriteAllowed();
  return false;
}

export const PUBLIC_GUARD_INTERNALS = {
  isPublicRequest,
  FORBIDDEN_PATHS_FROM_PUBLIC,
  FORBIDDEN_MCP_TOOLS_FROM_PUBLIC,
  PUBLIC_WRITE_TOOLS,
  publicReadBodiesAllowed,
};
