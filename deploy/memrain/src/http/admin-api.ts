/**
 * http/admin-api.ts — admin data endpoints (increment A2).
 *
 * The `/admin/api/*` data routes the admin SPA reads, on Bun.serve: the brain
 * stats plus credential management (Agents page), which wraps the same OAuth
 * provider + PAT store the `auth` CLI uses — a unified `agents` view over
 * oauth_clients + access_tokens with per-credential usage, PAT
 * mint/list/revoke, OAuth client register/revoke, and the per-client
 * token_ttl write side.
 *
 * EVERY route gates on `requireAdmin` itself — the public bearer guard exempts
 * `/admin*`, so there is no ambient protection here.
 */
import { spendReport } from "../core/spend-report.ts";
import { patNameSpendConflict } from "../core/budget.ts";
import { createHash, randomBytes } from "node:crypto";
import type { Storage } from "../core/storage.ts";
import type { Engine } from "../core/engine/interface.ts";
import { getSource } from "../core/sources.ts";
import { brainHealthMetrics } from "../core/source-health.ts";
import { getCalibrationProfile } from "../core/synthesis/reads.ts";
import {
  GrantConflictError,
  GrantNotFoundError,
  GrantValidationError,
  isAllowedRedirectUri,
  OAuthProvider,
  resolvePatGrant,
  validateTokenEndpointAuthMethod,
} from "../core/oauth-provider.ts";
import type { TenantMode } from "../core/oauth-provider.ts";
import { normalizeScopesInput } from "../core/scope.ts";
import { isSameOriginPost } from "./same-origin.ts";

export interface AdminApiDeps {
  storage: Storage;
  /** Session check from the AdminAuth instance (http/admin.ts). */
  requireAdmin: (req: Request) => boolean;
}

const unauthorized = () => Response.json({ error: "Admin authentication required" }, { status: 401 });
const badRequest = (msg: string) => Response.json({ error: msg }, { status: 400 });
/** Log the real cause server-side; return a generic message — don't leak
 *  internal / SQL error text to the client (even an admin one). */
function serverError(route: string, e: unknown): Response {
  console.error(`[admin-api] ${route} failed:`, e instanceof Error ? e.message : e);
  return Response.json({ error: "internal error" }, { status: 500 });
}

/** Per-credential MCP usage rollup shown on the Agents page. */
export interface GrantUsage {
  /** Requests since the start of today (server local `now()` day boundary). */
  requests_today: number;
  /** All-time request count logged for this credential. */
  total_requests: number;
  /** ISO timestamp of the most recent request, or null when never seen. */
  last_used_at: string | null;
}

const EMPTY_USAGE: GrantUsage = { requests_today: 0, total_requests: 0, last_used_at: null };

/**
 * Aggregate `mcp_request_log` into a usage map keyed by CREDENTIAL identity
 * (`token_name`). The request logger stamps the OAuth client id (or the
 * legacy PAT name) into `token_name`, so this map joins the credentials
 * table on the Agents page. One grouped scan.
 */
async function usageByTokenName(engine: Engine): Promise<Map<string, GrantUsage>> {
  const { rows } = await engine.query<{
    token_name: string;
    requests_today: number | string;
    total_requests: number | string;
    last_used_at: string | null;
  }>(
    `SELECT token_name,
            count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS requests_today,
            count(*)::int AS total_requests,
            max(created_at)::text AS last_used_at
       FROM mcp_request_log
      WHERE token_name IS NOT NULL
      GROUP BY token_name`,
  );
  const map = new Map<string, GrantUsage>();
  for (const r of rows) {
    map.set(r.token_name, {
      requests_today: Number(r.requests_today) || 0,
      total_requests: Number(r.total_requests) || 0,
      last_used_at: r.last_used_at,
    });
  }
  return map;
}

/** SHA-256 hex digest — same shape the OAuth provider and `auth create` store. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Return the subset of the given source ids that are not registered. */
async function missingSourceIds(engine: Engine, sourceId: string, federatedRead: string[]): Promise<string[]> {
  const toCheck = Array.from(new Set([sourceId, ...federatedRead]));
  const missing: string[] = [];
  for (const id of toCheck) {
    if (!(await getSource(engine, id))) missing.push(id);
  }
  return missing;
}

/**
 * Coerce a `token_ttl` body value to seconds or null (= server default).
 * `null`/`0` clear the override; anything else must be a positive integer.
 * Throws on malformed input so the route can 400 instead of storing junk.
 */
function parseTokenTtl(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === 0) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("token_ttl must be a positive integer (seconds), or null/0 to clear");
  }
  return n;
}

/**
 * Dispatch an `/admin/api/*` data route. Returns a Response, or null when the
 * path is not a data route (so the caller can fall through to 404).
 */
export async function handleAdminApi(req: Request, url: URL, deps: AdminApiDeps): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/admin/api/")) return null;

  // Single auth gate for the whole data surface — BEFORE touching the engine,
  // so an unauthenticated caller triggers no work at all.
  if (!deps.requireAdmin(req)) return unauthorized();
  // The session cookie is SameSite=Strict, but a sibling subdomain is same-SITE,
  // so every mutating route also needs the request to come from our own origin.
  if (req.method !== "GET" && req.method !== "HEAD" && !isSameOriginPost(req, url)) {
    return Response.json({ error: "Cross-origin request refused" }, { status: 403 });
  }
  const engine = deps.storage.engine();

  // GET /admin/api/full-stats — brain health + corpus counts (Dashboard).
  if (p === "/admin/api/full-stats" && req.method === "GET") {
    try {
      const health = await brainHealthMetrics(engine);
      const counts = await engine.query<{ documents: number; pages: number; chunks: number }>(
        `SELECT
           (SELECT count(*) FROM documents WHERE deleted_at IS NULL)::int AS documents,
           (SELECT count(*) FROM pages WHERE deleted_at IS NULL)::int AS pages,
           (SELECT count(*) FROM chunks)::int AS chunks`,
      );
      return Response.json({ health, counts: counts.rows[0] ?? null });
    } catch (e) {
      return serverError("full-stats", e);
    }
  }

  // GET /admin/api/agents — unified credentials view (Agents page): OAuth
  // clients + legacy API keys (access_tokens) in one list, each with status
  // and per-credential usage. Usage joins on `token_name` (the credential id
  // the request logger stamps); a legacy key with no logged calls falls back
  // to its own `last_used_at` column (bumped by the legacy verify path).
  if (p === "/admin/api/agents" && req.method === "GET") {
    try {
      const usage = await usageByTokenName(engine);
      const clients = await engine.query<{
        id: string;
        name: string;
        grant_types: string[] | null;
        scope: string | null;
        token_ttl: number | null;
        source_id: string | null;
        federated_read: string[] | null;
        redirect_uris: string[] | null;
        tenant_mode: string | null;
        grant_revision: number;
        status: string;
        created_at: string;
      }>(
        `SELECT client_id AS id, client_name AS name, grant_types, scope,
                token_ttl, source_id, federated_read, redirect_uris, tenant_mode,
                grant_revision::int AS grant_revision,
                CASE WHEN deleted_at IS NOT NULL THEN 'revoked' ELSE 'active' END AS status,
                created_at::text AS created_at
           FROM oauth_clients
          ORDER BY created_at DESC`,
      );
      const keys = await engine.query<{
        id: number | string;
        name: string;
        status: string;
        created_at: string;
        last_used_at: string | null;
      }>(
        `SELECT id, name,
                CASE WHEN revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END AS status,
                created_at::text AS created_at, last_used_at::text AS last_used_at
           FROM access_tokens
          ORDER BY created_at DESC`,
      );
      const agents = [
        ...clients.rows.map((c) => ({ auth_type: "oauth" as const, ...c, usage: usage.get(c.id) ?? EMPTY_USAGE })),
        ...keys.rows.map((k) => {
          const u = usage.get(k.name) ?? EMPTY_USAGE;
          return {
            auth_type: "api_key" as const,
            id: String(k.id),
            name: k.name,
            grant_types: null,
            scope: null,
            token_ttl: null,
            source_id: null,
            federated_read: null,
            redirect_uris: null,
            tenant_mode: null,
            grant_revision: null,
            status: k.status,
            created_at: k.created_at,
            usage: { ...u, last_used_at: u.last_used_at ?? k.last_used_at },
          };
        }),
      ];
      return Response.json({ count: agents.length, agents });
    } catch (e) {
      return serverError("agents", e);
    }
  }

  // GET /admin/api/api-keys — legacy personal access tokens (no hashes).
  if (p === "/admin/api/api-keys" && req.method === "GET") {
    try {
      const { rows } = await engine.query<Record<string, unknown>>(
        `SELECT id, name,
                CASE WHEN revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END AS status,
                created_at::text AS created_at, last_used_at::text AS last_used_at
           FROM access_tokens
          ORDER BY created_at DESC`,
      );
      return Response.json({ count: rows.length, keys: rows });
    } catch (e) {
      return serverError("api-keys-list", e);
    }
  }

  // POST /admin/api/api-keys — mint a personal access token (= `auth create`).
  // The plaintext token is returned ONCE; only the SHA-256 hash persists. The
  // default permissions block matches the CLI: takes_holders ['world'] keeps
  // private takes hidden until the operator widens the allow-list. Optional
  // `source` (write source), `read` (extra read sources) and `scopes` (read
  // and/or write) are validated exactly as `auth create` validates them.
  if (p === "/admin/api/api-keys" && req.method === "POST") {
    let body: { name?: unknown; source?: unknown; read?: unknown; scopes?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return badRequest("name required");
    const nameConflict = patNameSpendConflict(name);
    if (nameConflict !== null) return badRequest(nameConflict);
    const isIdList = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
    if (body.source !== undefined && (typeof body.source !== "string" || body.source.length === 0)) {
      return badRequest("source must be a source id");
    }
    if (body.read !== undefined && !isIdList(body.read)) return badRequest("read must be an array of source ids");
    if (body.scopes !== undefined && !isIdList(body.scopes)) return badRequest("scopes must be an array of scopes");
    let grant: Awaited<ReturnType<typeof resolvePatGrant>>;
    try {
      grant = await resolvePatGrant(engine, {
        ...(typeof body.source === "string" ? { sourceId: body.source } : {}),
        ...(isIdList(body.read) ? { federatedRead: body.read } : {}),
        ...(isIdList(body.scopes) ? { scopes: body.scopes } : {}),
      });
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : "invalid token grant");
    }
    try {
      const dup = await engine.query<{ id: number }>(
        "SELECT id FROM access_tokens WHERE name = $1 AND revoked_at IS NULL",
        [name],
      );
      if (dup.rows.length > 0) {
        return badRequest(`an active token named "${name}" already exists — revoke it first`);
      }
      const token = "memrain_" + randomBytes(32).toString("hex");
      // JSONB params are JS objects, never pre-stringified (double-encode bug class).
      const inserted = await engine.query<{ id: number | string }>(
        // A re-minted name keeps its predecessor's daily cap (spend is booked
        // under the name).
        `INSERT INTO access_tokens (name, token_hash, scopes, permissions, budget_usd_per_day)
         VALUES ($1, $2, $3::text[], $4::jsonb,
                 (SELECT p.budget_usd_per_day FROM access_tokens p
                 WHERE p.name = $1 ORDER BY p.id DESC LIMIT 1)) RETURNING id`,
        [
          name,
          sha256Hex(token),
          grant.scopes,
          {
            takes_holders: ["world"],
            ...(grant.sourceGrant !== undefined ? { source_id: grant.sourceGrant } : {}),
          },
        ],
      );
      return Response.json({
        ok: true,
        id: String(inserted.rows[0]?.id ?? ""),
        name,
        token,
        scopes: grant.scopes,
        ...(grant.sourceGrant !== undefined ? { source_id: grant.sourceGrant } : {}),
        note: "Store the token now — only its hash persists.",
      });
    } catch (e) {
      return serverError("api-keys-mint", e);
    }
  }

  // POST /admin/api/api-keys/revoke — soft-revoke a PAT by name (= `auth revoke`).
  if (p === "/admin/api/api-keys/revoke" && req.method === "POST") {
    let body: { name?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.name !== "string" || body.name.length === 0) return badRequest("name required");
    try {
      const r = await engine.query<{ id: number }>(
        `UPDATE access_tokens SET revoked_at = now()
          WHERE name = $1 AND revoked_at IS NULL RETURNING id`,
        [body.name],
      );
      if (r.rows.length === 0) {
        return Response.json({ error: `no active token named "${body.name}"` }, { status: 404 });
      }
      return Response.json({ ok: true, revoked: true, name: body.name });
    } catch (e) {
      return serverError("api-keys-revoke", e);
    }
  }

  // POST /admin/api/register-client — operator-trusted OAuth client
  // registration (= `auth register-client`). Same defaults as the CLI: a
  // client with redirect_uris is an authorization-code (browser) client;
  // without, client_credentials. The secret is returned ONCE. An optional
  // `token_ttl` closes the write side of the per-client TTL the token
  // exchange already honors.
  if (p === "/admin/api/register-client" && req.method === "POST") {
    let body: {
      name?: unknown;
      scopes?: unknown;
      scope?: unknown;
      grant_types?: unknown;
      redirect_uris?: unknown;
      token_endpoint_auth_method?: unknown;
      token_ttl?: unknown;
      source?: unknown;
      read?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return badRequest("name required");

    // Accept both `scopes` (SPA convention) and `scope` (OAuth wire
    // convention) — string or string[]; malformed shapes 400, never coerced.
    let scopeString: string;
    try {
      scopeString = normalizeScopesInput(body.scopes ?? body.scope);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : "invalid scopes");
    }
    let authMethod: string;
    try {
      authMethod = validateTokenEndpointAuthMethod(body.token_endpoint_auth_method);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : "invalid token_endpoint_auth_method");
    }
    let tokenTtl: number | null;
    try {
      tokenTtl = parseTokenTtl(body.token_ttl);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : "invalid token_ttl");
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string" && u.length > 0)
      : [];
    const grantTypes =
      Array.isArray(body.grant_types) && body.grant_types.length > 0
        ? body.grant_types.filter((g): g is string => typeof g === "string" && g.length > 0)
        : redirectUris.length > 0
          ? ["authorization_code", "refresh_token"]
          : ["client_credentials"];
    const sourceId = typeof body.source === "string" && body.source.length > 0 ? body.source : "default";
    let federatedRead: string[] | undefined;
    if (body.read !== undefined) {
      if (
        !Array.isArray(body.read) ||
        body.read.length === 0 ||
        !body.read.every((x) => typeof x === "string" && x.length > 0)
      ) {
        return badRequest("read must be a non-empty array of source ids");
      }
      federatedRead = body.read as string[];
    }

    try {
      // Validate the source scope only when explicitly set — the implicit
      // 'default' floor mirrors the CLI, which does not validate.
      if (body.source !== undefined || federatedRead !== undefined) {
        const missing = await missingSourceIds(engine, sourceId, federatedRead ?? [sourceId]);
        if (missing.length > 0) return badRequest(`unknown source id(s): ${missing.join(", ")}`);
      }
      const provider = new OAuthProvider({ engine });
      const { clientId, clientSecret } = await provider.registerClientManual(
        name,
        grantTypes,
        scopeString,
        redirectUris,
        sourceId,
        federatedRead,
        authMethod,
      );
      if (tokenTtl !== null) {
        await engine.query("UPDATE oauth_clients SET token_ttl = $1 WHERE client_id = $2", [tokenTtl, clientId]);
      }
      return Response.json({
        ok: true,
        client_id: clientId,
        client_secret: clientSecret ?? null,
        client_name: name,
        grant_types: grantTypes,
        scope: scopeString,
        source_id: sourceId,
        federated_read: federatedRead ?? [sourceId],
        token_ttl: tokenTtl,
        note:
          clientSecret === undefined
            ? "Public client (auth method 'none') — no secret minted; PKCE authenticates."
            : "Store client_secret now — it is not recoverable.",
      });
    } catch (e) {
      return serverError("register-client", e);
    }
  }

  // POST /admin/api/update-client-ttl — set/clear a client's per-token TTL
  // override. The exchange path already reads `oauth_clients.token_ttl`;
  // this is the missing write surface.
  if (p === "/admin/api/update-client-ttl" && req.method === "POST") {
    let body: { client_id?: unknown; token_ttl?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.client_id !== "string" || body.client_id.length === 0) return badRequest("client_id required");
    let ttl: number | null;
    try {
      ttl = parseTokenTtl(body.token_ttl);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : "invalid token_ttl");
    }
    try {
      const r = await engine.query<{ client_id: string }>(
        "UPDATE oauth_clients SET token_ttl = $1 WHERE client_id = $2 AND deleted_at IS NULL RETURNING client_id",
        [ttl, body.client_id],
      );
      if (r.rows.length === 0) {
        return Response.json({ error: `no client "${body.client_id}"` }, { status: 404 });
      }
      return Response.json({ ok: true, client_id: body.client_id, token_ttl: ttl });
    } catch (e) {
      return serverError("update-client-ttl", e);
    }
  }

  // POST /admin/api/rescope-client — change an existing client's tenancy
  // grant without revoke + re-register, through the grant mutation service:
  // revision-checked (`expected_revision`), previewable (`dry_run`) and
  // audited. Already-issued tokens pick up the new grant on their next
  // verification (the verify path JOINs the client row).
  if (p === "/admin/api/rescope-client" && req.method === "POST") {
    let body: {
      client_id?: unknown;
      source?: unknown;
      read?: unknown;
      bound_slug_prefixes?: unknown;
      tenant_mode?: unknown;
      scopes?: unknown;
      expected_revision?: unknown;
      dry_run?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.client_id !== "string" || body.client_id.length === 0) return badRequest("client_id required");
    if (typeof body.source !== "string" || body.source.length === 0) return badRequest("source required");
    const isIdList = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
    let federatedRead: string[] | undefined;
    if (body.read !== undefined) {
      if (!isIdList(body.read) || body.read.length === 0) {
        return badRequest("read must be a non-empty array of source ids");
      }
      federatedRead = body.read;
    }
    // Tri-state fence: absent leaves it, null or [] clears it, a list replaces it.
    let boundSlugPrefixes: string[] | undefined;
    if (body.bound_slug_prefixes === null) boundSlugPrefixes = [];
    else if (body.bound_slug_prefixes !== undefined) {
      if (!isIdList(body.bound_slug_prefixes)) {
        return badRequest("bound_slug_prefixes must be an array of slug prefixes, or null to clear");
      }
      boundSlugPrefixes = body.bound_slug_prefixes;
    }
    let tenantMode: TenantMode | undefined;
    if (body.tenant_mode !== undefined) {
      if (body.tenant_mode !== "client" && body.tenant_mode !== "enrollment") {
        return badRequest("tenant_mode must be 'client' or 'enrollment'");
      }
      tenantMode = body.tenant_mode;
    }
    // Absent leaves the client's scopes; a list replaces them (validated by the
    // provider, which answers invalid_scope).
    let scopes: string[] | undefined;
    if (body.scopes !== undefined) {
      if (!Array.isArray(body.scopes) || !body.scopes.every((x) => typeof x === "string")) {
        return badRequest("scopes must be an array of scope names");
      }
      scopes = body.scopes as string[];
    }
    let expectedRevision: number | undefined;
    if (body.expected_revision !== undefined) {
      if (typeof body.expected_revision !== "number" || !Number.isInteger(body.expected_revision) || body.expected_revision < 0) {
        return badRequest("expected_revision must be a non-negative integer");
      }
      expectedRevision = body.expected_revision;
    }
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
      return badRequest("dry_run must be a boolean");
    }
    try {
      const provider = new OAuthProvider({ engine });
      const result = await provider.rescopeClient(
        body.client_id,
        { sourceId: body.source, federatedRead, boundSlugPrefixes, tenantMode, scopes },
        // The admin session carries no per-person identity yet (one bootstrap
        // secret), so every admin change is attributed to the admin role.
        { actor: "admin", via: "admin_api", expectedRevision, dryRun: body.dry_run === true },
      );
      return Response.json({
        ok: true,
        client_id: result.clientId,
        dry_run: result.dryRun,
        revision: result.revision,
        source_id: result.after.source_id,
        federated_read: result.after.federated_read,
        before: result.before,
        after: result.after,
        changed: result.changed,
        revoked_unbound: {
          access_tokens: result.revokedUnbound.accessTokens,
          refresh_tokens: result.revokedUnbound.refreshTokens,
          codes: result.revokedUnbound.codes,
        },
      });
    } catch (e) {
      if (e instanceof GrantNotFoundError) {
        return Response.json({ error: "not_found", detail: `no active client "${body.client_id}"` }, { status: 404 });
      }
      if (e instanceof GrantConflictError) {
        return Response.json({ error: "grant_conflict", expected: e.expected, actual: e.actual }, { status: 409 });
      }
      if (e instanceof GrantValidationError) {
        return Response.json({ error: "invalid_grant", reasons: e.reasons }, { status: 400 });
      }
      return serverError("rescope-client", e);
    }
  }

  // POST /admin/api/invalidate-tokens — delete every token and code of a
  // client, or of one enrollment grant on it (`grant_id`), keeping the client
  // (= `auth invalidate-tokens`). Audited like a rescope.
  if (p === "/admin/api/invalidate-tokens" && req.method === "POST") {
    let body: { client_id?: unknown; grant_id?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.client_id !== "string" || body.client_id.length === 0) return badRequest("client_id required");
    if (body.grant_id !== undefined && (typeof body.grant_id !== "string" || body.grant_id.length === 0)) {
      return badRequest("grant_id must be an enrollment id");
    }
    try {
      const r = await new OAuthProvider({ engine }).invalidateClientTokens(body.client_id, {
        actor: "admin",
        via: "admin_api",
        ...(typeof body.grant_id === "string" ? { grantId: body.grant_id } : {}),
      });
      return Response.json({
        ok: true,
        client_id: r.clientId,
        grant_id: r.grantId,
        revision: r.revision,
        deleted: {
          access_tokens: r.deleted.accessTokens,
          refresh_tokens: r.deleted.refreshTokens,
          codes: r.deleted.codes,
        },
      });
    } catch (e) {
      if (e instanceof GrantNotFoundError) {
        const detail =
          e.grantId === undefined
            ? `no active client "${body.client_id}"`
            : `no enrollment "${e.grantId}" on client "${body.client_id}"`;
        return Response.json({ error: "not_found", detail }, { status: 404 });
      }
      return serverError("invalidate-tokens", e);
    }
  }

  // GET /admin/api/grant-audit?client_id= — who changed a client's grant and
  // when, newest first. Grant fields only; the audit rows hold no secrets.
  if (p === "/admin/api/grant-audit" && req.method === "GET") {
    const clientId = url.searchParams.get("client_id");
    if (!clientId) return badRequest("client_id required");
    try {
      const rows = await new OAuthProvider({ engine }).listGrantAudit(clientId, 100);
      return Response.json({ client_id: clientId, rows });
    } catch (e) {
      return serverError("grant-audit", e);
    }
  }

  // POST /admin/api/revoke-client — soft-delete an OAuth client and kill its
  // live tokens and codes (= `auth revoke-client`). The row stays, so the grant
  // history and spend keep pointing at something. Audited like a rescope.
  if (p === "/admin/api/revoke-client" && req.method === "POST") {
    let body: { client_id?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.client_id !== "string" || body.client_id.length === 0) return badRequest("client_id required");
    try {
      const r = await new OAuthProvider({ engine }).revokeClient(body.client_id, { actor: "admin", via: "admin_api" });
      return Response.json({
        ok: true,
        revoked: r.revoked,
        client_id: r.clientId,
        revision: r.revision,
        tokens_deleted: r.deleted.accessTokens + r.deleted.refreshTokens,
        codes_deleted: r.deleted.codes,
      });
    } catch (e) {
      if (e instanceof GrantNotFoundError) {
        return Response.json({ error: `no client "${body.client_id}"` }, { status: 404 });
      }
      return serverError("revoke-client", e);
    }
  }

  // POST /admin/api/set-redirect-uris — replace a client's redirect URIs without
  // rotating its secret (= `auth set-redirect-uris`). Revision-checked
  // (`expected_revision`) and audited; codes minted before the change stop
  // redeeming.
  if (p === "/admin/api/set-redirect-uris" && req.method === "POST") {
    let body: { client_id?: unknown; redirect_uris?: unknown; expected_revision?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.client_id !== "string" || body.client_id.length === 0) return badRequest("client_id required");
    if (
      !Array.isArray(body.redirect_uris) ||
      body.redirect_uris.length === 0 ||
      !body.redirect_uris.every((u) => typeof u === "string" && u.length > 0)
    ) {
      return badRequest("redirect_uris must be a non-empty array of URIs");
    }
    let expectedRevision: number | undefined;
    if (body.expected_revision !== undefined) {
      if (typeof body.expected_revision !== "number" || !Number.isInteger(body.expected_revision) || body.expected_revision < 0) {
        return badRequest("expected_revision must be a non-negative integer");
      }
      expectedRevision = body.expected_revision;
    }
    const uris = body.redirect_uris as string[];
    const invalid = uris.filter((u) => !isAllowedRedirectUri(u));
    if (invalid.length > 0) {
      return badRequest(`redirect URIs must use https:// (or http on a loopback host): ${invalid.join(", ")}`);
    }
    try {
      const r = await new OAuthProvider({ engine }).setRedirectUris(body.client_id, uris, {
        actor: "admin",
        via: "admin_api",
        expectedRevision,
      });
      return Response.json({
        ok: true,
        client_id: r.clientId,
        revision: r.revision,
        before: r.before,
        after: r.after,
        removed: r.removed,
      });
    } catch (e) {
      if (e instanceof GrantNotFoundError) {
        return Response.json({ error: "not_found", detail: `no active client "${body.client_id}"` }, { status: 404 });
      }
      if (e instanceof GrantConflictError) {
        return Response.json({ error: "grant_conflict", expected: e.expected, actual: e.actual }, { status: 409 });
      }
      return serverError("set-redirect-uris", e);
    }
  }

  // GET /admin/api/enrollments?client_id= — enrollment codes and the people
  // who redeemed them (= `auth enrollments`), never the code itself.
  if (p === "/admin/api/enrollments" && req.method === "GET") {
    const clientId = url.searchParams.get("client_id") ?? undefined;
    try {
      const rows = await new OAuthProvider({ engine }).listEnrollments(clientId);
      return Response.json({ count: rows.length, enrollments: rows });
    } catch (e) {
      return serverError("enrollments-list", e);
    }
  }

  // POST /admin/api/enrollments — issue a one-time enrollment code
  // (= `auth enroll`). The code is returned ONCE; only its hash persists.
  // `replaces` issues it for the same person as an earlier enrollment.
  if (p === "/admin/api/enrollments" && req.method === "POST") {
    let body: {
      source?: unknown;
      read?: unknown;
      label?: unknown;
      client_id?: unknown;
      ttl_seconds?: unknown;
      replaces?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    const optString = (v: unknown): v is string | undefined =>
      v === undefined || (typeof v === "string" && v.length > 0);
    if (!optString(body.source) || !optString(body.label) || !optString(body.client_id) || !optString(body.replaces)) {
      return badRequest("source, label, client_id and replaces must be non-empty strings when given");
    }
    if (body.source === undefined && body.replaces === undefined) return badRequest("source or replaces required");
    if (
      body.read !== undefined &&
      (!Array.isArray(body.read) || !body.read.every((x) => typeof x === "string" && x.length > 0))
    ) {
      return badRequest("read must be an array of source ids");
    }
    if (
      body.ttl_seconds !== undefined &&
      (typeof body.ttl_seconds !== "number" || !Number.isInteger(body.ttl_seconds) || body.ttl_seconds <= 0)
    ) {
      return badRequest("ttl_seconds must be a positive integer");
    }
    try {
      const r = await new OAuthProvider({ engine }).issueEnrollment(
        {
          ...(body.source !== undefined ? { sourceId: body.source } : {}),
          ...(Array.isArray(body.read) && body.read.length > 0 ? { federatedRead: body.read as string[] } : {}),
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.client_id !== undefined ? { clientId: body.client_id } : {}),
          ...(typeof body.ttl_seconds === "number" ? { ttlSeconds: body.ttl_seconds } : {}),
          ...(body.replaces !== undefined ? { replaces: body.replaces } : {}),
        },
        { actor: "admin", via: "admin_api" },
      );
      return Response.json({
        ok: true,
        enrollment_id: r.id,
        code: r.code,
        source_id: r.sourceId,
        federated_read: r.federatedRead,
        label: r.label,
        client_id: r.clientId,
        spend_id: r.spendId,
        replaces: r.replaces,
        expires_at: r.expiresAt,
        note: "Give this code to the person. It works once — store nothing else.",
      });
    } catch (e) {
      // Every refusal here is an operator input problem (unknown source,
      // client or enrollment, a client not in enrollment mode, a ttl out of
      // range); the messages name ids the operator typed, nothing internal.
      const msg = e instanceof Error ? e.message : "";
      if (/^(?:Unknown |Client '|ttl must|an enrollment needs)/.test(msg)) return badRequest(msg);
      return serverError("enrollments-issue", e);
    }
  }

  // POST /admin/api/revoke-enrollment — kill a code nobody redeemed yet
  // (= `auth revoke-enrollment`). Audited.
  if (p === "/admin/api/revoke-enrollment" && req.method === "POST") {
    let body: { id?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.id !== "string" || body.id.length === 0) return badRequest("id required");
    try {
      const ok = await new OAuthProvider({ engine }).revokeEnrollment(body.id, { actor: "admin", via: "admin_api" });
      if (!ok) {
        return Response.json({ error: `no live enrollment "${body.id}" (used, revoked or unknown)` }, { status: 404 });
      }
      return Response.json({ ok: true, enrollment_id: body.id, revoked: true });
    } catch (e) {
      return serverError("revoke-enrollment", e);
    }
  }

  // POST /admin/api/revoke-grant — cut off one person who redeemed her code:
  // revoke the enrollment and delete every token minted under it
  // (= `auth revoke-grant`). Others on the same connector are untouched.
  if (p === "/admin/api/revoke-grant" && req.method === "POST") {
    let body: { id?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.id !== "string" || body.id.length === 0) return badRequest("id required");
    try {
      const r = await new OAuthProvider({ engine }).revokeGrant(body.id, { actor: "admin", via: "admin_api" });
      if (!r.revoked) return Response.json({ error: `no enrollment "${body.id}"` }, { status: 404 });
      return Response.json({ ok: true, enrollment_id: body.id, revoked: true, tokens_deleted: r.tokens });
    } catch (e) {
      return serverError("revoke-grant", e);
    }
  }

  // GET /admin/api/requests?page=N — recent MCP request log rows (RequestLog
  // page). The table (mig 046) exists; a request-logger populates it. Paginated.
  if (p === "/admin/api/requests" && req.method === "GET") {
    try {
      const PER = 25;
      const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));
      // Optional filters (all parameterized) so an operator can isolate one
      // agent's traffic, one operation, or the failures. `total` honours the
      // same filter so pagination stays correct.
      const filters: unknown[] = [];
      const clauses: string[] = [];
      const agent = url.searchParams.get("agent");
      if (agent) { filters.push(agent); clauses.push(`agent_name = $${filters.length}`); }
      const operation = url.searchParams.get("operation");
      if (operation) { filters.push(operation); clauses.push(`operation = $${filters.length}`); }
      const status = url.searchParams.get("status");
      if (status) { filters.push(status); clauses.push(`status = $${filters.length}`); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await engine.query<Record<string, unknown>>(
        // error_message capped (left(...,300)) — admin-only, but it can carry
        // upstream payload/path text; no need to ship the raw blob to the UI.
        // `params` is stored already-redacted (param-redaction.ts), so shipping
        // it lets the operator see WHAT a misbehaving agent called.
        `SELECT id, token_name, agent_name, operation, latency_ms, status, params,
                left(error_message, 300) AS error_message, created_at::text AS created_at
           FROM mcp_request_log ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $${filters.length + 1} OFFSET $${filters.length + 2}`,
        [...filters, PER, (page - 1) * PER],
      );
      const total = await engine.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM mcp_request_log ${where}`,
        filters,
      );
      return Response.json({ page, per_page: PER, total: total.rows[0]?.n ?? 0, rows: rows.rows });
    } catch (e) {
      return serverError("requests", e);
    }
  }

  // GET /admin/api/jobs/watch — job queue snapshot (JobsWatch page): status
  // counts + the most-recent jobs.
  if (p === "/admin/api/jobs/watch" && req.method === "GET") {
    try {
      const counts = await engine.query<{ status: string; n: number }>(
        "SELECT status, count(*)::int AS n FROM jobs GROUP BY status ORDER BY status",
      );
      const recent = await engine.query<Record<string, unknown>>(
        `SELECT id, kind, status, retry_count, left(last_error, 300) AS last_error,
                created_at::text AS created_at,
                started_at::text AS started_at, finished_at::text AS finished_at
           FROM jobs
          ORDER BY created_at DESC
          LIMIT 25`,
      );
      return Response.json({ counts: counts.rows, recent: recent.rows });
    } catch (e) {
      return serverError("jobs-watch", e);
    }
  }

  // GET /admin/api/calibration/profile — the latest synthesis calibration
  // scorecard (Calibration page). Null when no profile has been computed yet.
  if (p === "/admin/api/calibration/profile" && req.method === "GET") {
    try {
      const profile = await getCalibrationProfile(engine);
      return Response.json({ profile });
    } catch (e) {
      return serverError("calibration-profile", e);
    }
  }

  // GET /admin/api/agents/spend — per-OAuth-client daily spend vs budget cap.
  // The mig-081 spend ledger enforces budget_usd_per_day on paid ops; this is
  // the read side so an operator can see who is near their cap.
  if (p === "/admin/api/agents/spend" && req.method === "GET") {
    try {
      const rows = await engine.query<Record<string, unknown>>(
        `SELECT c.client_id, c.client_name, c.budget_usd_per_day AS cap_usd_per_day,
                COALESCE((SELECT SUM(spend_cents) FROM mcp_spend_log
                            WHERE client_id = c.client_id
                              AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0) AS spent_cents_today,
                COALESCE((SELECT SUM(estimated_cents) FROM mcp_spend_reservations
                            WHERE client_id = c.client_id AND status = 'pending'
                              AND expires_at > now()), 0) AS pending_cents
           FROM oauth_clients c
          WHERE c.deleted_at IS NULL
          ORDER BY c.client_name`,
      );
      return Response.json({ agents: rows.rows });
    } catch (e) {
      return serverError("agents-spend", e);
    }
  }

  // GET /admin/api/spend/report?days=N — the ledger by model, feature and
  // spender, with the calls the totals cannot price.
  if (p === "/admin/api/spend/report" && req.method === "GET") {
    const raw = url.searchParams.get("days");
    const days = raw === null ? 7 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      return badRequest("days must be a whole number from 1 to 366");
    }
    try {
      return Response.json(await spendReport(engine, { days }));
    } catch (e) {
      return serverError("spend-report", e);
    }
  }

  // GET /admin/api/stats — dashboard rollup counts (auth surface).
  if (p === "/admin/api/stats" && req.method === "GET") {
    try {
      const r = await engine.query<Record<string, number>>(
        `SELECT
           (SELECT count(*)::int FROM oauth_clients WHERE deleted_at IS NULL) AS connected_agents,
           (SELECT count(*)::int FROM oauth_tokens WHERE token_type = 'access' AND revoked_at IS NULL
               AND expires_at > extract(epoch FROM now())) AS active_tokens,
           (SELECT count(*)::int FROM access_tokens WHERE revoked_at IS NULL) AS active_api_keys,
           (SELECT count(*)::int FROM mcp_request_log WHERE created_at > now() - interval '24 hours') AS requests_today`,
      );
      return Response.json(r.rows[0] ?? {});
    } catch (e) {
      return serverError("stats", e);
    }
  }

  // GET /admin/api/health-indicators — token-expiry + error-rate tiles.
  if (p === "/admin/api/health-indicators" && req.method === "GET") {
    try {
      const r = await engine.query<{
        tokens_expiring_24h: number;
        total_24h: number;
        errors_24h: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM oauth_tokens WHERE token_type = 'access' AND revoked_at IS NULL
               AND expires_at > extract(epoch FROM now())
               AND expires_at <= extract(epoch FROM now() + interval '24 hours')) AS tokens_expiring_24h,
           (SELECT count(*)::int FROM mcp_request_log WHERE created_at > now() - interval '24 hours') AS total_24h,
           (SELECT count(*)::int FROM mcp_request_log WHERE created_at > now() - interval '24 hours'
               AND status <> 'success') AS errors_24h`,
      );
      const row = r.rows[0];
      const total = row?.total_24h ?? 0;
      const errRate = total > 0 ? ((row?.errors_24h ?? 0) / total) * 100 : 0;
      return Response.json({
        tokens_expiring_24h: row?.tokens_expiring_24h ?? 0,
        error_rate_24h: Math.round(errRate * 10) / 10,
      });
    } catch (e) {
      return serverError("health-indicators", e);
    }
  }

  return null; // not a known data route
}
