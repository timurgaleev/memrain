/**
 * OAuth 2.1 provider — hash-only token + client store over the SQL engine.
 *
 * This is infrastructure, not brain retrieval: it talks to the raw Engine
 * (PGLite or Postgres) rather than the higher-level indexer/search layers.
 * The HTTP transport wraps these methods — every public method takes plain
 * data and returns plain objects (no Request/Response coupling), so the
 * ingress layer owns redirects, status codes, and header parsing.
 *
 * Supports:
 *  - Client registration (CLI helper + Dynamic Client Registration)
 *  - Authorization-code flow with PKCE (browser-based clients)
 *  - Client-credentials flow (machine-to-machine)
 *  - Refresh-token rotation
 *  - Token revocation
 *  - Legacy access_tokens fallback for the pre-OAuth bearer path
 *
 * Secrets and tokens are stored as SHA-256 hashes only; the plaintext
 * value is returned to the caller exactly once at issuance and never
 * persisted.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import { validateSlug as validatePageSlug } from "./pages.ts";
import {
  hasScope,
  intersectGrantedScopes,
  normalizeScopesInput,
  parseScopeString,
  assertAllowedScopes,
  RETIRED_SCOPES,
} from "./scope.ts";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex digest. Tokens and client secrets are stored hashed. */
function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Generate an opaque token with a human-readable prefix. */
function generateToken(prefix: string): string {
  return prefix + randomBytes(32).toString("hex");
}

/**
 * True when the error is Postgres "undefined column" (SQLSTATE 42703) for
 * the named column. Lets a query degrade gracefully on a brain whose schema
 * predates a given column instead of failing the whole request.
 */
function isUndefinedColumnError(err: unknown, column: string): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? "";
  if (code === "42703") {
    return message.includes(column);
  }
  // PGLite surfaces this as a plain message without the SQLSTATE code.
  return (
    message.includes("does not exist") && message.includes(column)
  );
}

/**
 * Coerce an OAuth timestamp column (Unix epoch seconds, BIGINT) into a JS
 * number, or undefined for SQL NULL. postgres.js returns BIGINT as a string
 * when prepared statements are disabled (PgBouncer transaction mode), so the
 * comparison sites must normalize. Throws on non-finite so a corrupt row
 * fails loud at the boundary rather than letting `NaN` ride past validation.
 */
export function coerceTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(
      `coerceTimestamp: non-finite timestamp value ${JSON.stringify(value)}`,
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// token_endpoint_auth_method validation (RFC 7591 §2)
// ---------------------------------------------------------------------------

export type TokenEndpointAuthMethod =
  | "client_secret_post"
  | "client_secret_basic"
  | "none";

export const ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS =
  new Set<TokenEndpointAuthMethod>([
    "client_secret_post",
    "client_secret_basic",
    "none",
  ]);

export class InvalidTokenEndpointAuthMethodError extends Error {
  readonly code = "invalid_token_endpoint_auth_method";
  constructor(value: unknown) {
    super(
      `Invalid token_endpoint_auth_method: ${JSON.stringify(value)}. ` +
        `Expected one of: ${Array.from(
          ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS,
        ).join(", ")}.`,
    );
    this.name = "InvalidTokenEndpointAuthMethodError";
  }
}

/**
 * Validate a token_endpoint_auth_method at the registration boundary.
 * Returns `client_secret_post` for empty input (RFC 7591 default). Applied
 * on write only — stored rows with legacy values keep working on read.
 */
export function validateTokenEndpointAuthMethod(
  value: unknown,
): TokenEndpointAuthMethod {
  if (value === undefined || value === null || value === "") {
    return "client_secret_post";
  }
  if (typeof value !== "string") {
    throw new InvalidTokenEndpointAuthMethodError(value);
  }
  if (
    !ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS.has(value as TokenEndpointAuthMethod)
  ) {
    throw new InvalidTokenEndpointAuthMethodError(value);
  }
  return value as TokenEndpointAuthMethod;
}

/**
 * Validate a redirect_uri (RFC 6749 §3.1.2.1). Production URIs must be HTTPS;
 * the only plaintext exceptions are loopback hosts, which are unreachable from
 * the network. Used by the DCR path; the CLI path trusts the operator.
 */
function validateRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid redirect_uri: not a parseable URL: ${uri}`);
  }
  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopback) return;
  throw new Error(
    `redirect_uri must use https:// (or http://localhost for loopback): ${uri}`,
  );
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Whether `requested` is one of the client's `registered` redirect URIs. Exact
 * string match, except for an http loopback URI (RFC 8252 §7.3): a native
 * client such as a CLI binds a free port at run time, so for those any port is
 * accepted while the scheme, host, path and query must still match. A loopback
 * callback is only reachable from the machine the browser runs on, so the port
 * carries no trust.
 */
export function redirectUriRegistered(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== "http:" || !LOOPBACK_HOSTS.has(req.hostname)) return false;
  if (req.username || req.password || req.hash) return false;
  return registered.some((uri) => {
    let reg: URL;
    try {
      reg = new URL(uri);
    } catch {
      return false;
    }
    return (
      reg.protocol === "http:" &&
      reg.hostname === req.hostname &&
      !reg.username &&
      !reg.password &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    );
  });
}

/** True when `uri` would pass registration: https, or http on a loopback host. */
export function isAllowedRedirectUri(uri: string): boolean {
  try {
    validateRedirectUri(uri);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public data shapes (transport-neutral)
// ---------------------------------------------------------------------------

/** Stored/returned client record. `client_secret` is the SHA-256 hash on
 *  read, and the freshly-minted plaintext exactly once at registration. */
export interface OAuthClientInfo {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  scope?: string;
  token_endpoint_auth_method?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  /**
   * Which /authorize flow this client uses. `client` (default) binds the grant
   * to the client row's source. `enrollment` requires a one-time enrollment
   * code at /authorize and binds the grant to the code's source, so one
   * connector can serve many people in separate tenants.
   */
  tenant_mode: TenantMode;
}

export type TenantMode = "client" | "enrollment";

export function parseTenantMode(raw: string | null | undefined): TenantMode {
  if (raw === undefined || raw === null || raw === "" || raw === "client") return "client";
  if (raw === "enrollment") return "enrollment";
  throw new Error(`tenant_mode must be 'client' or 'enrollment', got '${raw}'`);
}

/**
 * True for a client whose authorization only an operator's approval can
 * vouch for: public (no secret — PKCE alone redeems its codes) and pinned to
 * its own row's tenant. Where /authorize auto-approves, such a client's
 * client_id is all it takes to mint a token for that tenant. Enrollment mode
 * is exempt: the one-time code the person presents is the credential.
 */
export function needsOperatorConsent(client: {
  client_secret?: string;
  tenant_mode: TenantMode;
}): boolean {
  return client.client_secret === undefined && client.tenant_mode === "client";
}

/** `MEMRAIN_OAUTH_REQUIRE_LOGIN` as the server reads it: `1` or `true`. */
export function oauthRequireLoginFromEnv(): boolean {
  const v = (process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** One issued enrollment code, as listed to the operator (never the code). */
export interface EnrollmentInfo {
  id: string;
  label: string | null;
  source_id: string;
  federated_read: string[];
  client_id: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  /** The key the person spends under: a predecessor's when this code replaced one. */
  spend_id: string;
  replaces_id: string | null;
  budget_usd_per_day: number | null;
  /** When a token was last minted under this grant (each refresh mints one). */
  last_token_at: string | null;
}

/** Who performed an enrollment change, recorded as data only. */
export interface EnrollmentAuditActor {
  actor: string;
  via: GrantVia | "enrollment";
}

const UNATTRIBUTED: EnrollmentAuditActor = { actor: "unattributed", via: "cli" };

/** Token-endpoint success payload (RFC 6749 §5.1). */
export interface OAuthTokens {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

/** Parameters the ingress collects from the /authorize request. */
/**
 * The tenant a single authorization is pinned to, chosen by the operator when
 * they approve that request — NOT by the client and never by the token holder.
 *
 * It exists because a corporate chat vendor publishes ONE connector for a whole
 * organisation: with tenancy pinned to the client row, one connector can only
 * ever be one tenant. Binding it per grant lets one connector serve many people,
 * each in their own source.
 */
/**
 * Read a stored grant off a code/token row. `grant_bound` is what makes a
 * deliberate "no source" distinguishable from a legacy row: without it, both
 * look like NULL and the client-row fallback would widen the session.
 */
function grantFromRow(row: Record<string, unknown>): GrantScope | undefined {
  if (row["grant_bound"] !== true) return undefined;
  const fed = row["federated_read"];
  const grantId = row["grant_id"];
  return {
    sourceId: (row["source_id"] as string | null) ?? null,
    federatedRead: Array.isArray(fed) ? (fed as string[]) : null,
    ...(typeof grantId === "string" && grantId ? { grantId } : {}),
  };
}

/**
 * The resource a consumed code or refresh row was bound to, else `requested`.
 * Refusing a request that names a DIFFERENT resource is the caller's job and
 * happens before the row is consumed (see `resourceForAuthorizationCode`).
 */
function boundResource(
  row: Record<string, unknown>,
  requested: URL | undefined,
): URL | undefined {
  const stored = row["resource"];
  return typeof stored === "string" && stored ? new URL(stored) : requested;
}

/**
 * True for a grant-bound row with no grant_id (redeemed before migration 108)
 * whose client and source match a redeemed enrollment that has been revoked:
 * the same rows `revokeGrant` deletes. Checked at use, not only at revoke, so a
 * refresh that consumed its row before the revoke and inserts after it cannot
 * mint a token that outlives it. `t` names the oauth_codes / oauth_tokens row.
 */
function legacyGrantRevoked(t: string): string {
  return `(${t}.grant_bound AND ${t}.grant_id IS NULL AND EXISTS (
  SELECT 1 FROM oauth_enrollments le
   WHERE le.revoked_at IS NOT NULL AND le.used_at IS NOT NULL
     AND le.source_id = ${t}.source_id
     AND (le.client_id IS NULL OR le.client_id = ${t}.client_id)))`;
}

/**
 * WHERE clause for an oauth_codes / oauth_tokens row: false once the enrollment
 * its grant was redeemed from is revoked. An unbound row is unaffected.
 */
function grantNotRevoked(t: "oauth_codes" | "oauth_tokens"): string {
  return `(NOT ${t}.grant_bound OR (${t}.grant_id IS NULL AND NOT ${legacyGrantRevoked(t)}) OR (${t}.grant_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM oauth_enrollments e WHERE e.id = ${t}.grant_id AND e.revoked_at IS NOT NULL)))`;
}

/**
 * WHERE clause for an oauth_codes / oauth_tokens row: an unbound row is
 * redeemable only while its client takes the tenant from its own row. An
 * enrollment-mode client issues bound codes only, so an unbound code or refresh
 * token under one predates a rescope to enrollment mode, and redeeming it would
 * put the client row's tenant on a session no enrollment approved.
 */
function unboundAllowed(t: "oauth_codes" | "oauth_tokens"): string {
  return `(${t}.grant_bound OR NOT EXISTS (
  SELECT 1 FROM oauth_clients uc WHERE uc.client_id = ${t}.client_id AND uc.tenant_mode = 'enrollment'))`;
}

export interface GrantScope {
  /** The write source for this session. */
  sourceId: string | null;
  /** The federated read set. Undefined = just `sourceId`. */
  federatedRead?: string[] | null;
  /** The enrollment this grant was redeemed from: the session spends under it. */
  grantId?: string;
}

export interface AuthorizationParams {
  codeChallenge: string;
  redirectUri: string;
  scopes?: string[];
  state?: string;
  resource?: URL;
}

/** Resolved identity carried alongside an authenticated request. The
 *  `sourceId` (write scope) + `allowedSources` (federated read set) fields
 *  feed the tenancy axis downstream. */
export interface AuthInfo {
  token: string;
  clientId: string;
  clientName?: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
  sourceId?: string;
  allowedSources?: string[];
  /** Takes-holder allow-list from a legacy PAT's `permissions.takes_holders`
   *  (mig 072). Undefined for OAuth clients, which carry no such knob. */
  takesHolders?: string[];
  /** Slug-prefix write fence (`oauth_clients.bound_slug_prefixes`): when
   *  non-empty, the dispatch write gate confines every write op to slugs
   *  under these prefixes. Undefined/empty = unbounded. */
  boundSlugPrefixes?: string[];
  /** The OAuth client's, PAT's or enrollment's `budget_usd_per_day`; null when uncapped. */
  budgetUsdPerDay: number | null;
  /** Who the session spends as, when not `clientId`: an enrollment id. */
  spendId?: string;
}

export interface TokenRevocationRequest {
  token: string;
  token_type_hint?: string;
}

export class InvalidTokenError extends Error {
  readonly code = "invalid_token";
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

/** A NUMERIC budget column as dollars; null = uncapped. An unreadable value
 *  fails the token rather than silently uncapping it. */
function toCapUsd(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new InvalidTokenError("Corrupt budget_usd_per_day on token row");
  return n;
}

// ---------------------------------------------------------------------------
// Legacy permissions.source_id parsing
// ---------------------------------------------------------------------------

/**
 * Map a legacy access_tokens `permissions.source_id` grant onto the
 * (sourceId, allowedSources) pair. A scalar string is both the write source
 * and the sole read source; an array is a federated read set anchored on its
 * first element. Anything else falls back to the historical 'default' floor.
 */
function parseLegacyTokenScope(grant: unknown): {
  sourceId: string;
  allowedSources?: string[];
} {
  if (typeof grant === "string" && grant.length > 0) {
    return { sourceId: grant, allowedSources: [grant] };
  }
  if (Array.isArray(grant)) {
    const sources = grant.filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (sources.length > 0) {
      return { sourceId: sources[0] as string, allowedSources: sources };
    }
  }
  return { sourceId: "default" };
}

/** The scopes a personal access token may be minted with. */
const PAT_MINT_SCOPES = ["read", "write"];

/**
 * Validate the tenancy and scopes of a personal access token about to be
 * minted, and return what goes on its row. Omitted scopes keep the historical
 * read+write; omitted source keeps the token unscoped (the 'default' floor), as
 * every existing token is. A write source must be registered, and so must every
 * read source; the read set always contains the write source, because the row
 * stores it as the first element of `permissions.source_id`.
 */
export async function resolvePatGrant(
  engine: Engine,
  input: { sourceId?: string; scopes?: string[]; federatedRead?: string[] },
): Promise<{ scopes: string[]; sourceGrant?: string | string[] }> {
  const scopes = input.scopes ?? PAT_MINT_SCOPES;
  if (scopes.length === 0) throw new Error("scopes cannot be empty");
  const bad = scopes.filter((x) => !PAT_MINT_SCOPES.includes(x));
  if (bad.length > 0) {
    throw new Error(
      `a personal access token is minted with read and/or write, got: ${bad.join(", ")} ` +
        "(admin is granted afterwards, by changing the token's permissions)",
    );
  }
  const federated = input.federatedRead ?? [];
  if (input.sourceId === undefined) {
    if (federated.length > 0) throw new Error("a read set needs a write source");
    return { scopes: Array.from(new Set(scopes)) };
  }
  const wanted = Array.from(new Set([input.sourceId, ...federated]));
  const known = await engine.query<{ id: string }>(
    "SELECT id FROM sources WHERE id = ANY($1::text[])",
    [wanted],
  );
  const knownIds = new Set(known.rows.map((r) => r.id));
  const missing = wanted.filter((id) => !knownIds.has(id));
  if (missing.length > 0) throw new Error(`Unknown source '${missing.join("', '")}'`);
  return {
    scopes: Array.from(new Set(scopes)),
    sourceGrant: wanted.length > 1 ? wanted : input.sourceId,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface OAuthProviderOptions {
  engine: Engine;
  /** Default access-token TTL in seconds (default: 3600). */
  tokenTtl?: number;
  /** Default refresh-token TTL in seconds (default: 30 days). */
  refreshTtl?: number;
  /**
   * Allow a self-registered (DCR) client to request the `client_credentials`
   * grant. Off by default: a self-registered client gets the consent-bearing
   * `authorization_code` grant, so an unauthenticated /register caller can
   * never mint a token that skips the /authorize step. Operators open the
   * machine-to-machine path with `MEMRAIN_ENABLE_DCR_INSECURE=1`. The trusted
   * CLI path (registerClientManual) is unaffected.
   */
  allowClientCredentialsDcr?: boolean;
}

/**
 * A client's tenancy grant as the grant mutation service sees it. Arrays are
 * sorted so a before/after comparison (and the audit JSON) is deterministic;
 * the stored columns keep the caller's order.
 */
export interface GrantSnapshot {
  source_id: string | null;
  federated_read: string[];
  bound_slug_prefixes: string[] | null;
  tenant_mode: TenantMode;
  /** The client's registered scopes. Issued tokens hold at most these. */
  scopes: string[];
}

/**
 * A requested grant change. `federatedRead` omitted defaults to `[sourceId]`.
 * `boundSlugPrefixes` is tri-state: omitted leaves the fence, `[]` clears it,
 * a list replaces it. `tenantMode` omitted leaves the mode alone.
 */
export interface GrantChange {
  sourceId: string;
  federatedRead?: string[];
  boundSlugPrefixes?: string[];
  tenantMode?: TenantMode;
  /**
   * The client's scopes: omitted leaves them, a list replaces them. Narrowing
   * applies to already-issued tokens on their next verification.
   */
  scopes?: string[];
  /** Per-client token lifetimes: omitted leaves them, null clears them. */
  accessTtlSeconds?: number | null;
  refreshTtlSeconds?: number | null;
}

/** Per-client token lifetimes in seconds; absent or null = the server default. */
export interface ClientTtls {
  accessTtlSeconds?: number | null;
  refreshTtlSeconds?: number | null;
}

export type GrantVia = "cli" | "admin_api";

export interface GrantMutationOptions {
  /** Who asked, recorded as data only; it authorizes nothing. */
  actor: string;
  via: GrantVia;
  /** When set, the change applies only if the stored revision still equals it. */
  expectedRevision?: number;
  dryRun?: boolean;
}

export interface GrantMutationResult {
  clientId: string;
  /** The revision after the change; on a dry run, the current revision. */
  revision: number;
  before: GrantSnapshot;
  after: GrantSnapshot;
  /** Grant fields whose value differs between before and after. */
  changed: (keyof GrantSnapshot)[];
  dryRun: boolean;
  /**
   * Unbound codes and tokens the change deleted (on a dry run, would delete):
   * non-zero only when the write source or the tenant mode changed.
   */
  revokedUnbound: UnboundRevocation;
  /** The client's token lifetimes after the change (null = server default). */
  ttls: { accessTtlSeconds: number | null; refreshTtlSeconds: number | null };
}

export interface UnboundRevocation {
  accessTokens: number;
  refreshTokens: number;
  codes: number;
}

export type GrantReasonCode =
  | "unknown_source"
  | "empty_read_set"
  | "invalid_prefix"
  | "invalid_ttl"
  | "invalid_scope"
  | "public_client_mode";

export interface GrantReason {
  code: GrantReasonCode;
  detail: string;
}

export class GrantNotFoundError extends Error {
  readonly code = "not_found";
  constructor(
    readonly clientId: string,
    readonly grantId?: string,
  ) {
    super(
      grantId === undefined
        ? `not_found: no active client "${clientId}"`
        : `not_found: no enrollment "${grantId}" on client "${clientId}"`,
    );
    this.name = "GrantNotFoundError";
  }
}

export class GrantConflictError extends Error {
  readonly code = "grant_conflict";
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`grant_conflict: expected revision ${expected}, current revision is ${actual}`);
    this.name = "GrantConflictError";
  }
}

export class GrantValidationError extends Error {
  readonly code = "invalid_grant";
  constructor(readonly reasons: GrantReason[]) {
    super(`invalid_grant: ${reasons.map((r) => `${r.code} (${r.detail})`).join("; ")}`);
    this.name = "GrantValidationError";
  }
}

/** One applied grant change, as the history read path returns it. */
export interface GrantAuditRow {
  id: number;
  client_id: string;
  revision: number;
  actor: string;
  via: string;
  before: GrantSnapshot;
  after: GrantSnapshot;
  created_at: string;
}

const GRANT_FIELDS: (keyof GrantSnapshot)[] = [
  "source_id",
  "federated_read",
  "bound_slug_prefixes",
  "tenant_mode",
  "scopes",
];

function sortedCopy(xs: string[]): string[] {
  return [...xs].sort();
}

export function grantSnapshot(row: {
  source_id: unknown;
  federated_read: unknown;
  bound_slug_prefixes: unknown;
  tenant_mode: unknown;
  scope: unknown;
}): GrantSnapshot {
  const fence = Array.isArray(row.bound_slug_prefixes) && row.bound_slug_prefixes.length > 0
    ? sortedCopy(row.bound_slug_prefixes as string[])
    : null;
  return {
    source_id: (row.source_id as string | null) ?? null,
    federated_read: Array.isArray(row.federated_read) ? sortedCopy(row.federated_read as string[]) : [],
    bound_slug_prefixes: fence,
    tenant_mode: parseTenantMode(row.tenant_mode as string | null),
    scopes: sortedCopy(parseScopeString(typeof row.scope === "string" ? row.scope : null)),
  };
}

export function grantDiff(before: GrantSnapshot, after: GrantSnapshot): (keyof GrantSnapshot)[] {
  return GRANT_FIELDS.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
}

/**
 * A personal access token's grant as its audit rows record it. Built from the
 * grant columns only — the token hash never reaches an audit row.
 */
export interface PatGrantSnapshot {
  name: string;
  /** null = no scopes recorded (verify falls back to read+write). */
  scopes: string[] | null;
  takes_holders: string[] | null;
  source_id: string | string[] | null;
  budget_usd_per_day: number | null;
}

/** One live token row a PAT grant change applied to. */
export interface PatGrantChange {
  id: number;
  revision: number;
  before: PatGrantSnapshot;
  after: PatGrantSnapshot;
}

/** Who changed a PAT grant, recorded as data only; it authorizes nothing. */
export interface GrantActor {
  actor: string;
  via: GrantVia;
}

const UNATTRIBUTED_GRANT: GrantActor = { actor: "unattributed", via: "cli" };

function patSnapshot(row: {
  name: string;
  scopes: unknown;
  permissions: unknown;
  budget_usd_per_day: unknown;
}): PatGrantSnapshot {
  let perms: unknown = row.permissions;
  if (typeof perms === "string") {
    try {
      perms = JSON.parse(perms);
    } catch {
      perms = undefined;
    }
  }
  const p = perms && typeof perms === "object" ? (perms as Record<string, unknown>) : {};
  const holders = p.takes_holders;
  const source = p.source_id;
  return {
    name: row.name,
    scopes: Array.isArray(row.scopes) ? sortedCopy(row.scopes as string[]) : null,
    takes_holders: Array.isArray(holders) ? (holders as string[]) : null,
    source_id: typeof source === "string" || Array.isArray(source) ? (source as string | string[]) : null,
    budget_usd_per_day: row.budget_usd_per_day == null ? null : Number(row.budget_usd_per_day),
  };
}

const NO_UNBOUND_REVOKED: UnboundRevocation = { accessTokens: 0, refreshTokens: 0, codes: 0 };

function tallyUnbound(tokens: { token_type: string }[], codes: number): UnboundRevocation {
  return {
    accessTokens: tokens.filter((t) => t.token_type === "access").length,
    refreshTokens: tokens.filter((t) => t.token_type === "refresh").length,
    codes,
  };
}

/**
 * How long a consumed refresh token may be presented again without revoking its
 * family. A client that retries a refresh whose response it never saw (or races
 * two of them) presents the same token twice within seconds; that is refused,
 * but it is not treated as theft.
 */
export const REFRESH_REUSE_GRACE_SECONDS = 60;

/**
 * `MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE` as the server reads it: `1` or `true`
 * deletes the family of a replayed refresh token. Off, the replay is refused and
 * logged, and the family keeps working.
 */
export function refreshReuseRevokeFromEnv(): boolean {
  const v = (process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Bounds on a per-client access-token lifetime: 5 minutes to 1 day. */
export const ACCESS_TTL_BOUNDS = { min: 300, max: 86_400 } as const;
/** Bounds on a per-client refresh-token lifetime: 1 hour to 90 days. */
export const REFRESH_TTL_BOUNDS = { min: 3600, max: 90 * 86_400 } as const;

/**
 * Throw unless `seconds` is a whole number inside `bounds`. `null` (clear the
 * override) and `undefined` (leave it) pass.
 */
export function assertClientTtl(
  name: "access_ttl_seconds" | "refresh_ttl_seconds",
  seconds: number | null | undefined,
): void {
  if (seconds === null || seconds === undefined) return;
  const b = name === "access_ttl_seconds" ? ACCESS_TTL_BOUNDS : REFRESH_TTL_BOUNDS;
  if (!Number.isInteger(seconds) || seconds < b.min || seconds > b.max) {
    throw new Error(`${name} must be a whole number of seconds from ${b.min} to ${b.max}, got ${seconds}`);
  }
}

/**
 * Whether a client registered with `grantTypes` may use `grant`. An empty list
 * predates enforcement of the browser grants, so it keeps the historical
 * default of authorization_code + refresh_token (and never client_credentials).
 * NULL is the column default, client_credentials, as `getClient` reads it.
 */
export function clientAllowsGrant(grantTypes: readonly string[] | null | undefined, grant: string): boolean {
  if (grantTypes == null) return grant === "client_credentials";
  if (grantTypes.length === 0) {
    return grant === "authorization_code" || grant === "refresh_token";
  }
  return grantTypes.includes(grant);
}

/** What a code or refresh exchange reads off the locked client row. */
interface IssuePolicy {
  grantRevision: number;
  /** The client's scopes now; an issued grant is cut down to these. */
  scopes: string[];
  grantTypes: string[] | null;
  accessTtl: number | undefined;
  refreshTtl: number | undefined;
}

function positiveOrUndefined(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Share-lock the client row for a code or refresh exchange. rescopeClient takes
 * it FOR UPDATE, so an exchange either finishes (its new unbound tokens are then
 * there for the rescope to revoke) or starts after the rescope committed and
 * judges `unboundAllowed` against the new row. Returns what issuance needs from
 * that same row, or undefined when the client is gone or revoked.
 */
async function lockClientForIssue(tx: Engine, clientId: string): Promise<IssuePolicy | undefined> {
  const r = await tx.query<{
    grant_revision: number | string;
    grant_types: string[] | null;
    access_ttl_seconds: number | string | null;
    refresh_ttl_seconds: number | string | null;
    scope: string | null;
  }>(
    `SELECT grant_revision, grant_types, access_ttl_seconds, refresh_ttl_seconds, scope
       FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL FOR SHARE`,
    [clientId],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  return {
    grantRevision: Number(row.grant_revision),
    scopes: parseScopeString(row.scope),
    grantTypes: row.grant_types,
    accessTtl: positiveOrUndefined(row.access_ttl_seconds),
    refreshTtl: positiveOrUndefined(row.refresh_ttl_seconds),
  };
}

/** Options for one issuance: lifetimes, the tenant grant, the refresh family. */
interface IssueOptions {
  accessTtl?: number;
  refreshTtl?: number;
  grant?: GrantScope;
  /** The refresh family the new tokens join; minted fresh when absent. */
  familyId?: string;
  db?: Engine;
}

interface ClientGrantState {
  grant_revision: number | string;
  tenant_mode: string | null;
  source_id: string | null;
}

async function countUnbound(tx: Engine, clientId: string): Promise<UnboundRevocation> {
  const t = await tx.query<{ token_type: string }>(
    "SELECT token_type FROM oauth_tokens WHERE client_id = $1 AND NOT grant_bound",
    [clientId],
  );
  const c = await tx.query<{ n: number }>(
    "SELECT 1 AS n FROM oauth_codes WHERE client_id = $1 AND NOT grant_bound",
    [clientId],
  );
  return tallyUnbound(t.rows, c.rows.length);
}

async function deleteUnbound(tx: Engine, clientId: string): Promise<UnboundRevocation> {
  const t = await tx.query<{ token_type: string }>(
    "DELETE FROM oauth_tokens WHERE client_id = $1 AND NOT grant_bound RETURNING token_type",
    [clientId],
  );
  const c = await tx.query<{ n: number }>(
    "DELETE FROM oauth_codes WHERE client_id = $1 AND NOT grant_bound RETURNING 1 AS n",
    [clientId],
  );
  return tallyUnbound(t.rows, c.rows.length);
}

/**
 * Cut every token the client holds down to what it was issued AND the client
 * now holds, and delete the ones left with nothing. Verify and refresh also
 * intersect at call time, but against the client's current scopes only, so
 * without the stored cut a client narrowed and then widened again would hand
 * its pre-narrowing tokens their old scopes back. Runs under rescopeClient's
 * row lock, which every refresh waits on.
 */
async function narrowIssuedTokens(tx: Engine, clientId: string, clientScopes: string[]): Promise<void> {
  const r = await tx.query<{ token_hash: string; scopes: string[] | null }>(
    // A revoked row is already dead and stays as it is for its audit trail.
    "SELECT token_hash, scopes FROM oauth_tokens WHERE client_id = $1 AND revoked_at IS NULL FOR UPDATE",
    [clientId],
  );
  for (const row of r.rows) {
    const issued = row.scopes ?? [];
    const kept = intersectGrantedScopes(issued, clientScopes);
    if (kept.length === 0) {
      await tx.query("DELETE FROM oauth_tokens WHERE token_hash = $1", [row.token_hash]);
    } else if (JSON.stringify(sortedCopy(kept)) !== JSON.stringify(sortedCopy(issued))) {
      await tx.query("UPDATE oauth_tokens SET scopes = $2::text[] WHERE token_hash = $1", [row.token_hash, kept]);
    }
  }
}

/** One row of the enrollment trail; `before` is null for an issue. */
async function writeEnrollmentAudit(
  tx: Engine,
  enrollmentId: string,
  clientId: string | null,
  action: string,
  who: EnrollmentAuditActor,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO oauth_enrollment_audit (enrollment_id, client_id, action, actor, via, before, after)
     VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7::text::jsonb)`,
    [enrollmentId, clientId, action, who.actor, who.via, before === null ? null : JSON.stringify(before), JSON.stringify(after)],
  );
}

/**
 * Mark enrollment `id` revoked and delete every code and token minted under
 * it. Returns undefined when no enrollment has that id.
 */
async function revokeGrantIn(
  tx: Engine,
  id: string,
): Promise<{ clientId: string | null; wasRevoked: boolean; used: boolean; tokens: number } | undefined> {
  const e = await tx.query<{ client_id: string | null; source_id: string; used_at: unknown; revoked_at: unknown }>(
    `SELECT client_id, source_id, used_at, revoked_at FROM oauth_enrollments WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const enr = e.rows[0];
  if (!enr) return undefined;
  await tx.query(`UPDATE oauth_enrollments SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1`, [id]);
  // Tokens redeemed before migration 108 are grant-bound but carry no
  // grant_id, and refresh carries the NULL forward, so matching on the id
  // alone would leave them working. Such a token is recognised by the tenant
  // and client the enrollment pinned; a legacy token of another enrollment
  // into the same source on the same client goes too, and that person
  // re-enrolls.
  const legacy = `grant_bound AND grant_id IS NULL AND $2::boolean
      AND source_id = $3 AND ($4::text IS NULL OR client_id = $4::text)`;
  const params = [id, enr.used_at != null, enr.source_id, enr.client_id];
  const t = await tx.query<{ n: number }>(
    `DELETE FROM oauth_tokens
      WHERE (grant_bound AND grant_id = $1) OR (${legacy})
      RETURNING 1 AS n`,
    params,
  );
  await tx.query(
    `DELETE FROM oauth_codes WHERE (grant_bound AND grant_id = $1) OR (${legacy})`,
    params,
  );
  return {
    clientId: enr.client_id,
    wasRevoked: enr.revoked_at != null,
    used: enr.used_at != null,
    tokens: t.rows.length,
  };
}

export class OAuthProvider {
  private engine: Engine;
  private tokenTtl: number;
  private refreshTtl: number;
  private allowClientCredentialsDcr: boolean;

  constructor(options: OAuthProviderOptions) {
    this.engine = options.engine;
    this.tokenTtl = options.tokenTtl || 3600;
    this.refreshTtl = options.refreshTtl || 30 * 24 * 3600;
    this.allowClientCredentialsDcr = options.allowClientCredentialsDcr ?? false;
  }

  private async rows<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const r = await this.engine.query<T>(sql, params);
    return r.rows;
  }

  // -------------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------------

  async getClient(clientId: string): Promise<OAuthClientInfo | undefined> {
    const rows = await this.rows(
      `SELECT client_id, client_secret_hash, client_name, redirect_uris,
              grant_types, scope, token_endpoint_auth_method,
              client_id_issued_at, client_secret_expires_at, tenant_mode
       FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL`,
      [clientId],
    );
    if (rows.length === 0) return undefined;
    const r = rows[0] as Record<string, unknown>;
    // Public clients (token_endpoint_auth_method='none') store a NULL secret
    // hash. Normalize SQL NULL to JS undefined so the caller's public-client
    // detection (`client_secret === undefined`) skips secret comparison.
    const rawSecret = r.client_secret_hash;
    return {
      client_id: r.client_id as string,
      client_secret: rawSecret == null ? undefined : (rawSecret as string),
      client_name: r.client_name as string,
      redirect_uris: (r.redirect_uris as string[]) || [],
      grant_types: (r.grant_types as string[]) || ["client_credentials"],
      scope: (r.scope as string | null) ?? undefined,
      token_endpoint_auth_method:
        (r.token_endpoint_auth_method as string | null) ?? undefined,
      client_id_issued_at: coerceTimestamp(r.client_id_issued_at),
      client_secret_expires_at: coerceTimestamp(r.client_secret_expires_at),
      tenant_mode: parseTenantMode(r.tenant_mode as string | null),
    };
  }

  /**
   * Dynamic Client Registration (RFC 7591). Reachable by unauthenticated
   * network callers when DCR is enabled, so this is the security-relevant
   * registration gate: HTTPS redirect_uris, allowed scopes, and a valid
   * auth method are all enforced here.
   */
  async registerClient(client: {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    scope?: string;
    token_endpoint_auth_method?: string;
  }): Promise<OAuthClientInfo> {
    for (const uri of client.redirect_uris || []) {
      validateRedirectUri(String(uri));
    }
    // A request that names no scope gets what the clamp below would grant a
    // client asking for everything, not a client that can do nothing.
    const requestedScopes = parseScopeString(
      client.scope !== undefined && client.scope.trim() !== "" ? client.scope : "read write",
    ).filter((s) => !RETIRED_SCOPES.has(s));
    assertAllowedScopes(requestedScopes);
    // SECURITY: Dynamic Client Registration is UNAUTHENTICATED (public /register).
    // A self-registered client must NEVER hold an elevated scope — otherwise
    // anyone could POST /register {"scope":"admin"} and mint an admin token via
    // client_credentials, escalating past the public bearer + redaction. We CLAMP
    // (not reject) to read/write: a real client like Claude.ai copies the whole
    // advertised scope list (incl. admin/*_admin) into its DCR request, so a hard
    // reject would break the standard flow — instead the elevated scopes are
    // silently dropped, exactly as `authorize` clamps them. An operator grants
    // admin/*_admin via the CLI (registerClientManual), unreachable from the net.
    const grantableScopes = requestedScopes.filter(
      (s) => s === "read" || s === "write",
    );
    const clampedScope = grantableScopes.join(" ");
    const authMethod = validateTokenEndpointAuthMethod(
      client.token_endpoint_auth_method,
    );

    // A self-registered client defaults to the consent-bearing
    // authorization_code grant. client_credentials mints a token WITHOUT the
    // /authorize step, so an unauthenticated /register caller must not obtain
    // it unless the operator has explicitly opened machine-to-machine
    // self-registration. NOTE: this message must stay free of "redirect_uri" so
    // the /register handler maps it to invalid_client_metadata, not
    // invalid_redirect_uri.
    const grantTypes =
      client.grant_types && client.grant_types.length > 0
        ? client.grant_types
        : ["authorization_code", "refresh_token"];
    if (
      !this.allowClientCredentialsDcr &&
      grantTypes.includes("client_credentials")
    ) {
      throw new Error(
        "self-registered clients receive the authorization_code grant; the " +
          "client_credentials grant is not available through dynamic " +
          "registration. Set MEMRAIN_ENABLE_DCR_INSECURE=1 to allow " +
          "machine-to-machine self-registration, or register a trusted client " +
          "with `memrain auth register-client`.",
      );
    }

    const clientId = generateToken("memrain_cl_");
    // Public clients (auth method 'none') authenticate via PKCE alone — the
    // server must NOT issue a secret for them (RFC 7591 §2). Confidential
    // clients mint a secret and store only its hash.
    const isPublicClient = authMethod === "none";
    const clientSecret = isPublicClient
      ? undefined
      : generateToken("memrain_cs_");
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    const now = Math.floor(Date.now() / 1000);

    // DCR clients default to source_id='default' with read scope == write
    // scope (federated_read=['default']); operators rescope via rescopeClient
    // (`auth rescope-client` / the admin rescope-client endpoint).
    await this.engine.query(
      `INSERT INTO oauth_clients
         (client_id, client_secret_hash, client_name, redirect_uris,
          grant_types, scope, token_endpoint_auth_method,
          client_id_issued_at, source_id, federated_read)
       VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7, $8, $9, $10::text[])`,
      [
        clientId,
        secretHash,
        client.client_name || "unnamed",
        (client.redirect_uris || []).map(String),
        grantTypes,
        clampedScope,
        authMethod,
        now,
        "default",
        ["default"],
      ],
    );

    const response: OAuthClientInfo = {
      client_id: clientId,
      client_name: client.client_name || "unnamed",
      redirect_uris: (client.redirect_uris || []).map(String),
      grant_types: grantTypes,
      scope: clampedScope || undefined,
      token_endpoint_auth_method: authMethod,
      client_id_issued_at: now,
      tenant_mode: "client",
    };
    // Public clients omit client_secret entirely (RFC 7591 §3.2.1).
    if (clientSecret) response.client_secret = clientSecret;
    return response;
  }

  /**
   * Operator-trusted registration (CLI / admin). Sets the tenancy grant
   * directly: `sourceId` is the write source, `federatedRead` the read set
   * (defaults to `[sourceId]` when omitted).
   */
  async registerClientManual(
    name: string,
    grantTypes: string[],
    scopes: string,
    redirectUris: string[] = [],
    sourceId = "default",
    federatedRead?: string[],
    tokenEndpointAuthMethod?: string,
    boundSlugPrefixes?: string[],
    tenantMode: TenantMode = "client",
    ttls: ClientTtls = {},
  ): Promise<{ clientId: string; clientSecret?: string }> {
    assertAllowedScopes(parseScopeString(scopes));
    assertClientTtl("access_ttl_seconds", ttls.accessTtlSeconds);
    assertClientTtl("refresh_ttl_seconds", ttls.refreshTtlSeconds);
    const authMethod = validateTokenEndpointAuthMethod(
      tokenEndpointAuthMethod,
    );
    // A prefix that can't match the slug grammar (uppercase, spaces) would
    // silently deny the client everything — reject it at registration.
    if (boundSlugPrefixes) {
      for (const p of boundSlugPrefixes) validatePageSlug(p);
    }

    const clientId = generateToken("memrain_cl_");
    const isPublicClient = authMethod === "none";
    const clientSecret = isPublicClient
      ? undefined
      : generateToken("memrain_cs_");
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    const now = Math.floor(Date.now() / 1000);
    const federated =
      federatedRead && federatedRead.length > 0 ? federatedRead : [sourceId];

    await this.engine.query(
      `INSERT INTO oauth_clients
         (client_id, client_secret_hash, client_name, redirect_uris,
          grant_types, scope, token_endpoint_auth_method,
          client_id_issued_at, source_id, federated_read, bound_slug_prefixes,
          tenant_mode, access_ttl_seconds, refresh_ttl_seconds)
       VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7, $8, $9, $10::text[],
               $11::text[], $12, $13, $14)`,
      [
        clientId,
        secretHash,
        name,
        redirectUris,
        grantTypes,
        scopes,
        authMethod,
        now,
        sourceId,
        federated,
        boundSlugPrefixes && boundSlugPrefixes.length > 0
          ? boundSlugPrefixes
          : null,
        tenantMode,
        ttls.accessTtlSeconds ?? null,
        ttls.refreshTtlSeconds ?? null,
      ],
    );

    return { clientId, clientSecret };
  }

  /**
   * The one write path for a client's tenancy grant (source, read set, slug
   * fence, tenant mode). Changes it in place — no revoke + re-register, which
   * would rotate the secret — and already-issued tokens see the new grant on
   * their next verification, since that path JOINs the client row.
   *
   * Except across a tenant move: when the write source or the tenant mode
   * changes, the client's unbound codes and tokens are deleted in the same
   * transaction. An unbound token takes its tenant from the client row, so one
   * issued to a person under the old grant would otherwise carry her into a
   * source nobody approved for her. Only a client that can run the
   * authorization-code flow is affected. Grant-bound tokens carry their own
   * tenant and survive; a client_credentials token of such a client goes too,
   * and the caller mints a fresh one with its secret.
   *
   * A change that names scopes also rewrites the scopes stored on every token
   * the client holds to their intersection with the new set, deleting tokens
   * left with none, so widening the client later gives them nothing back.
   *
   * Runs under a row lock so the revision check, validation and write see one
   * consistent row. A stale `expectedRevision` fails with `grant_conflict`
   * before anything is written; validation collects every reason code instead
   * of stopping at the first. An applied change bumps `grant_revision` and
   * writes its audit row in the same statement, so there is no revision
   * without history. A no-op change is still applied and audited: the attempt
   * itself is worth recording.
   *
   * `boundSlugPrefixes` is tri-state (see GrantChange). Prefixes are validated
   * exactly as at registration — a prefix that cannot match the slug grammar
   * would silently deny the client every write.
   */
  async rescopeClient(
    clientId: string,
    change: GrantChange,
    opts: GrantMutationOptions,
  ): Promise<GrantMutationResult> {
    return this.engine.transaction(async (tx) => {
      const locked = await tx.query<{
        source_id: string | null;
        federated_read: string[] | null;
        bound_slug_prefixes: string[] | null;
        tenant_mode: string | null;
        grant_revision: number;
        grant_types: string[] | null;
        access_ttl_seconds: number | null;
        refresh_ttl_seconds: number | null;
        client_secret_hash: string | null;
        scope: string | null;
      }>(
        `SELECT source_id, federated_read, bound_slug_prefixes, tenant_mode, grant_revision, grant_types,
                access_ttl_seconds, refresh_ttl_seconds, client_secret_hash, scope
           FROM oauth_clients
          WHERE client_id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [clientId],
      );
      const row = locked.rows[0];
      if (!row) throw new GrantNotFoundError(clientId);
      const current = Number(row.grant_revision);
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== current) {
        throw new GrantConflictError(opts.expectedRevision, current);
      }

      const federated = change.federatedRead ?? [change.sourceId];
      const scope = await this.validateGrantChange(tx, change, federated);
      // The same refusal register-client makes: with /authorize auto-approving,
      // a public client moved into client mode would mint tokens on its
      // client_id alone, and every sign-in would be refused from then on.
      if (
        change.tenantMode === "client" &&
        parseTenantMode(row.tenant_mode) !== "client" &&
        needsOperatorConsent({
          ...(row.client_secret_hash === null ? {} : { client_secret: row.client_secret_hash }),
          tenant_mode: "client",
        }) &&
        !oauthRequireLoginFromEnv()
      ) {
        throw new GrantValidationError([
          {
            code: "public_client_mode",
            detail:
              "a public client cannot be moved to client tenant mode while /authorize auto-approves; " +
              "keep enrollment mode or run with MEMRAIN_OAUTH_REQUIRE_LOGIN=1",
          },
        ]);
      }

      const before = grantSnapshot(row);
      const fence =
        change.boundSlugPrefixes === undefined
          ? row.bound_slug_prefixes
          : change.boundSlugPrefixes.length > 0
            ? change.boundSlugPrefixes
            : null;
      const after = grantSnapshot({
        source_id: change.sourceId,
        federated_read: federated,
        bound_slug_prefixes: fence,
        tenant_mode: change.tenantMode ?? row.tenant_mode,
        scope: scope ?? row.scope,
      });
      const changed = grantDiff(before, after);
      const ttlsBefore = {
        accessTtlSeconds: row.access_ttl_seconds === null ? null : Number(row.access_ttl_seconds),
        refreshTtlSeconds: row.refresh_ttl_seconds === null ? null : Number(row.refresh_ttl_seconds),
      };
      const ttls = {
        accessTtlSeconds: change.accessTtlSeconds === undefined ? ttlsBefore.accessTtlSeconds : change.accessTtlSeconds,
        refreshTtlSeconds: change.refreshTtlSeconds === undefined ? ttlsBefore.refreshTtlSeconds : change.refreshTtlSeconds,
      };
      // Lifetimes are not part of the tenancy snapshot, but a change to them is
      // recorded alongside it when one was asked for.
      const setsTtl = change.accessTtlSeconds !== undefined || change.refreshTtlSeconds !== undefined;
      const auditBefore = setsTtl
        ? { ...before, access_ttl_seconds: ttlsBefore.accessTtlSeconds, refresh_ttl_seconds: ttlsBefore.refreshTtlSeconds }
        : before;
      const auditAfter = setsTtl
        ? { ...after, access_ttl_seconds: ttls.accessTtlSeconds, refresh_ttl_seconds: ttls.refreshTtlSeconds }
        : after;
      // Only the authorization-code flow puts a person behind an unbound token;
      // a client_credentials-only client's tokens stay the machine's and follow
      // the client row as before.
      const movesTenant =
        (changed.includes("source_id") || changed.includes("tenant_mode")) &&
        (row.grant_types ?? []).includes("authorization_code");
      if (opts.dryRun) {
        const revokedUnbound = movesTenant ? await countUnbound(tx, clientId) : NO_UNBOUND_REVOKED;
        return { clientId, revision: current, before, after, changed, dryRun: true, revokedUnbound, ttls };
      }

      const setFence = change.boundSlugPrefixes !== undefined;
      const applied = await tx.query<{ revision: number }>(
        `WITH u AS (
           UPDATE oauth_clients
              SET source_id = $2, federated_read = $3::text[],
                  bound_slug_prefixes = CASE WHEN $5::boolean THEN $4::text[]
                                             ELSE bound_slug_prefixes END,
                  tenant_mode = COALESCE($6, tenant_mode),
                  access_ttl_seconds = CASE WHEN $11::boolean THEN $12::integer ELSE access_ttl_seconds END,
                  refresh_ttl_seconds = CASE WHEN $13::boolean THEN $14::integer ELSE refresh_ttl_seconds END,
                  scope = COALESCE($15::text, scope),
                  grant_revision = grant_revision + 1
            WHERE client_id = $1 AND deleted_at IS NULL
            RETURNING grant_revision
         )
         INSERT INTO oauth_grant_audit (client_id, revision, actor, via, before, after)
         SELECT $1, u.grant_revision, $7, $8, $9::text::jsonb, $10::text::jsonb FROM u
         RETURNING revision`,
        [
          clientId,
          change.sourceId,
          federated,
          setFence && change.boundSlugPrefixes!.length > 0 ? change.boundSlugPrefixes : null,
          setFence,
          change.tenantMode ?? null,
          opts.actor,
          opts.via,
          JSON.stringify(auditBefore),
          JSON.stringify(auditAfter),
          change.accessTtlSeconds !== undefined,
          change.accessTtlSeconds ?? null,
          change.refreshTtlSeconds !== undefined,
          change.refreshTtlSeconds ?? null,
          scope ?? null,
        ],
      );
      const revision = applied.rows[0]?.revision;
      // The row is locked, so the UPDATE cannot miss it; a missing row here
      // means the invariant broke and the change must not look applied.
      if (revision === undefined) throw new Error(`grant write for "${clientId}" affected no row`);
      const revokedUnbound = movesTenant ? await deleteUnbound(tx, clientId) : NO_UNBOUND_REVOKED;
      if (scope !== undefined) await narrowIssuedTokens(tx, clientId, after.scopes);
      return { clientId, revision: Number(revision), before, after, changed, dryRun: false, revokedUnbound, ttls };
    });
  }

  /**
   * Collect every reason a grant change is invalid; throw when there is any.
   * Returns the normalized scope string when the change sets scopes.
   */
  private async validateGrantChange(
    tx: Engine,
    change: GrantChange,
    federated: string[],
  ): Promise<string | undefined> {
    const reasons: GrantReason[] = [];
    let scope: string | undefined;
    if (change.scopes !== undefined) {
      try {
        scope = normalizeScopesInput(change.scopes);
      } catch (e) {
        reasons.push({ code: "invalid_scope", detail: e instanceof Error ? e.message : String(e) });
      }
    }
    if (federated.length === 0) {
      reasons.push({ code: "empty_read_set", detail: "the read set must name at least one source" });
    }
    const ids = Array.from(new Set([change.sourceId, ...federated]));
    const known = await tx.query<{ id: string }>(
      "SELECT id FROM sources WHERE id = ANY($1::text[])",
      [ids],
    );
    const knownIds = new Set(known.rows.map((r) => r.id));
    for (const id of ids) {
      if (!knownIds.has(id)) {
        const role = id === change.sourceId ? "write" : "read";
        reasons.push({ code: "unknown_source", detail: `${role} source "${id}" is not registered` });
      }
    }
    for (const p of change.boundSlugPrefixes ?? []) {
      try {
        validatePageSlug(p);
      } catch (e) {
        reasons.push({
          code: "invalid_prefix",
          detail: `"${p}": ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    for (const [name, value] of [
      ["access_ttl_seconds", change.accessTtlSeconds],
      ["refresh_ttl_seconds", change.refreshTtlSeconds],
    ] as const) {
      try {
        assertClientTtl(name, value);
      } catch (e) {
        reasons.push({ code: "invalid_ttl", detail: e instanceof Error ? e.message : String(e) });
      }
    }
    if (reasons.length > 0) throw new GrantValidationError(reasons);
    return scope;
  }

  /** A client's grant history, newest first. Grant fields only, no secrets. */
  async listGrantAudit(clientId: string, limit = 100): Promise<GrantAuditRow[]> {
    const capped = Math.min(Math.max(1, Math.floor(limit) || 1), 100);
    const r = await this.engine.query<GrantAuditRow>(
      `SELECT id, client_id, revision, actor, via, before, after, created_at::text AS created_at
         FROM oauth_grant_audit
        WHERE client_id = $1
        ORDER BY revision DESC, id DESC
        LIMIT $2`,
      [clientId, capped],
    );
    return r.rows.map((row) => ({ ...row, id: Number(row.id), revision: Number(row.revision) }));
  }

  /**
   * Delete every access token, refresh token and authorization code of a
   * client — or of one enrollment grant on it — and keep the client itself: its
   * registration, secret and grant are untouched, so a machine client mints a
   * fresh token with its secret and a browser client signs in again.
   *
   * Audited like a rescope: the revision is bumped and one audit row written in
   * the same transaction, under the same row lock. The bump also stops agent
   * jobs the client submitted, which re-check the revision before every step.
   */
  async invalidateClientTokens(
    clientId: string,
    opts: { actor: string; via: GrantVia; grantId?: string },
  ): Promise<{ clientId: string; revision: number; grantId: string | null; deleted: UnboundRevocation }> {
    return this.engine.transaction(async (tx) => {
      const locked = await tx.query<{
        source_id: string | null;
        federated_read: string[] | null;
        bound_slug_prefixes: string[] | null;
        tenant_mode: string | null;
        scope: string | null;
      }>(
        `SELECT source_id, federated_read, bound_slug_prefixes, tenant_mode, scope
           FROM oauth_clients
          WHERE client_id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [clientId],
      );
      const row = locked.rows[0];
      if (!row) throw new GrantNotFoundError(clientId);
      const grantId = opts.grantId ?? null;
      // A mistyped grant id would otherwise delete nothing yet still bump the
      // client-wide revision and write an audit row.
      if (grantId !== null) {
        const enr = await tx.query(
          "SELECT 1 FROM oauth_enrollments WHERE id = $1 AND client_id IS NOT DISTINCT FROM $2",
          [grantId, clientId],
        );
        if (enr.rows.length === 0) throw new GrantNotFoundError(clientId, grantId);
      }
      const t = await tx.query<{ token_type: string }>(
        `DELETE FROM oauth_tokens
          WHERE client_id = $1 AND ($2::text IS NULL OR (grant_bound AND grant_id = $2::text))
          RETURNING token_type`,
        [clientId, grantId],
      );
      const c = await tx.query<{ n: number }>(
        `DELETE FROM oauth_codes
          WHERE client_id = $1 AND ($2::text IS NULL OR (grant_bound AND grant_id = $2::text))
          RETURNING 1 AS n`,
        [clientId, grantId],
      );
      const deleted = tallyUnbound(t.rows, c.rows.length);
      const snapshot = grantSnapshot(row);
      const applied = await tx.query<{ revision: number }>(
        `WITH u AS (
           UPDATE oauth_clients SET grant_revision = grant_revision + 1
            WHERE client_id = $1 AND deleted_at IS NULL
            RETURNING grant_revision
         )
         INSERT INTO oauth_grant_audit (client_id, revision, actor, via, before, after)
         SELECT $1, u.grant_revision, $2, $3, $4::text::jsonb, $5::text::jsonb FROM u
         RETURNING revision`,
        [
          clientId,
          opts.actor,
          opts.via,
          JSON.stringify(snapshot),
          JSON.stringify({
            ...snapshot,
            action: "invalidate_tokens",
            grant_id: grantId,
            deleted: {
              access_tokens: deleted.accessTokens,
              refresh_tokens: deleted.refreshTokens,
              codes: deleted.codes,
            },
          }),
        ],
      );
      const revision = applied.rows[0]?.revision;
      if (revision === undefined) throw new Error(`token invalidation for "${clientId}" affected no row`);
      return { clientId, revision: Number(revision), grantId, deleted };
    });
  }

  /**
   * Replace a client's redirect URIs in place. The secret, the grant and every
   * issued token are untouched, so a connector whose callback moved keeps
   * working without being re-registered.
   *
   * Audited like a rescope: the revision is bumped and one audit row written
   * under the same row lock. The bump is what retires authorization codes
   * already minted for a URI that is no longer registered — /token refuses a
   * code approved under an older revision — and, as with every bump, it stops
   * agent jobs the client submitted.
   *
   * Every URI must be https, or http on a loopback host, as at registration.
   */
  async setRedirectUris(
    clientId: string,
    uris: string[],
    opts: { actor: string; via: GrantVia; expectedRevision?: number },
  ): Promise<{ clientId: string; revision: number; before: string[]; after: string[]; removed: string[] }> {
    const after = Array.from(new Set(uris.map((u) => u.trim()).filter(Boolean)));
    if (after.length === 0) throw new Error("at least one redirect URI is required");
    for (const uri of after) validateRedirectUri(uri);
    return this.engine.transaction(async (tx) => {
      const locked = await tx.query<{
        source_id: string | null;
        federated_read: string[] | null;
        bound_slug_prefixes: string[] | null;
        tenant_mode: string | null;
        grant_revision: number | string;
        redirect_uris: string[] | null;
        scope: string | null;
      }>(
        `SELECT source_id, federated_read, bound_slug_prefixes, tenant_mode, grant_revision, redirect_uris, scope
           FROM oauth_clients
          WHERE client_id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [clientId],
      );
      const row = locked.rows[0];
      if (!row) throw new GrantNotFoundError(clientId);
      const current = Number(row.grant_revision);
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== current) {
        throw new GrantConflictError(opts.expectedRevision, current);
      }
      const before = row.redirect_uris ?? [];
      const snapshot = grantSnapshot(row);
      const applied = await tx.query<{ revision: number }>(
        `WITH u AS (
           UPDATE oauth_clients SET redirect_uris = $2::text[], grant_revision = grant_revision + 1
            WHERE client_id = $1 AND deleted_at IS NULL
            RETURNING grant_revision
         )
         INSERT INTO oauth_grant_audit (client_id, revision, actor, via, before, after)
         SELECT $1, u.grant_revision, $3, $4, $5::text::jsonb, $6::text::jsonb FROM u
         RETURNING revision`,
        [
          clientId,
          after,
          opts.actor,
          opts.via,
          JSON.stringify({ ...snapshot, redirect_uris: before }),
          JSON.stringify({ ...snapshot, action: "set_redirect_uris", redirect_uris: after }),
        ],
      );
      const revision = applied.rows[0]?.revision;
      if (revision === undefined) throw new Error(`redirect URI write for "${clientId}" affected no row`);
      return {
        clientId,
        revision: Number(revision),
        before,
        after,
        removed: before.filter((u) => !after.includes(u)),
      };
    });
  }

  /**
   * Revoke a client: mark it deleted and delete every token and authorization
   * code it holds, in one transaction under the row lock. The row stays, so its
   * grant history, request log and spend keep pointing at something; nothing
   * can authenticate as it again. Audited like a rescope (revision bump + one
   * audit row). Revoking an already revoked client deletes any token left over
   * and reports `revoked: false`.
   */
  async revokeClient(
    clientId: string,
    opts: { actor: string; via: GrantVia },
  ): Promise<{ clientId: string; revoked: boolean; revision: number; deleted: UnboundRevocation }> {
    return this.engine.transaction(async (tx) => {
      const locked = await tx.query<{
        source_id: string | null;
        federated_read: string[] | null;
        bound_slug_prefixes: string[] | null;
        tenant_mode: string | null;
        grant_revision: number | string;
        deleted_at: unknown;
        scope: string | null;
      }>(
        `SELECT source_id, federated_read, bound_slug_prefixes, tenant_mode, grant_revision, deleted_at, scope
           FROM oauth_clients WHERE client_id = $1 FOR UPDATE`,
        [clientId],
      );
      const row = locked.rows[0];
      if (!row) throw new GrantNotFoundError(clientId);
      // oauth_tokens / oauth_codes cascade only on a hard delete.
      const t = await tx.query<{ token_type: string }>(
        "DELETE FROM oauth_tokens WHERE client_id = $1 RETURNING token_type",
        [clientId],
      );
      const c = await tx.query<{ n: number }>(
        "DELETE FROM oauth_codes WHERE client_id = $1 RETURNING 1 AS n",
        [clientId],
      );
      const deleted = tallyUnbound(t.rows, c.rows.length);
      if (row.deleted_at != null) {
        return { clientId, revoked: false, revision: Number(row.grant_revision), deleted };
      }
      const snapshot = grantSnapshot(row);
      const applied = await tx.query<{ revision: number }>(
        `WITH u AS (
           UPDATE oauth_clients SET deleted_at = now(), grant_revision = grant_revision + 1
            WHERE client_id = $1 AND deleted_at IS NULL
            RETURNING grant_revision
         )
         INSERT INTO oauth_grant_audit (client_id, revision, actor, via, before, after)
         SELECT $1, u.grant_revision, $2, $3, $4::text::jsonb, $5::text::jsonb FROM u
         RETURNING revision`,
        [
          clientId,
          opts.actor,
          opts.via,
          JSON.stringify(snapshot),
          JSON.stringify({
            ...snapshot,
            action: "revoke_client",
            deleted: {
              access_tokens: deleted.accessTokens,
              refresh_tokens: deleted.refreshTokens,
              codes: deleted.codes,
            },
          }),
        ],
      );
      const revision = applied.rows[0]?.revision;
      if (revision === undefined) throw new Error(`revoke of "${clientId}" affected no row`);
      return { clientId, revoked: true, revision: Number(revision), deleted };
    });
  }

  // -------------------------------------------------------------------------
  // Enrollment codes — the identity half of per-grant tenancy
  // -------------------------------------------------------------------------

  /**
   * Issue a one-time enrollment code for `sourceId`. The code is returned ONCE
   * and only its hash is stored, like a client secret. `clientId`, when given,
   * pins the code to one client; otherwise any enrollment-mode client may
   * redeem it. The source must exist now — a code for a source that does not
   * exist would mint a grant nobody can read.
   *
   * `replaces` names an earlier enrollment of the same person. The new code
   * inherits what it does not set (source, read set, label, client) plus the
   * predecessor's spend key and daily cap, so her spend keeps counting in one
   * place; redeeming it revokes the predecessor and every token under it.
   */
  async issueEnrollment(
    input: {
      sourceId?: string;
      federatedRead?: string[];
      label?: string;
      clientId?: string;
      ttlSeconds?: number;
      replaces?: string;
    },
    audit: EnrollmentAuditActor = UNATTRIBUTED,
  ): Promise<{
    id: string;
    code: string;
    expiresAt: string;
    spendId: string;
    replaces: string | null;
    sourceId: string;
    federatedRead: string[];
    label: string | null;
    clientId: string | null;
  }> {
    let prior:
      | {
          id: string;
          client_id: string | null;
          source_id: string;
          federated_read: string[] | null;
          label: string | null;
          spend_id: string | null;
          budget_usd_per_day: string | number | null;
        }
      | undefined;
    if (input.replaces !== undefined) {
      prior = (
        await this.rows<NonNullable<typeof prior>>(
          `SELECT id, client_id, source_id, federated_read, label, spend_id, budget_usd_per_day
             FROM oauth_enrollments WHERE id = $1`,
          [input.replaces],
        )
      )[0];
      if (!prior) throw new Error(`Unknown enrollment '${input.replaces}'`);
    }
    const sourceId = input.sourceId ?? prior?.source_id;
    if (sourceId === undefined) throw new Error("an enrollment needs a source (or --replaces)");
    const federatedIn =
      input.federatedRead && input.federatedRead.length > 0
        ? input.federatedRead
        : input.sourceId === undefined && prior?.federated_read && prior.federated_read.length > 0
          ? prior.federated_read
          : [sourceId];
    // Validate EVERY source the grant would read, not just the one it writes:
    // a typo in the read set would mint a grant that silently reads less than
    // the operator meant it to.
    const wanted = Array.from(new Set([sourceId, ...federatedIn]));
    const src = await this.engine.query<{ id: string }>(
      "SELECT id FROM sources WHERE id = ANY($1)",
      [wanted],
    );
    const known = new Set(src.rows.map((r) => r.id));
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(`Unknown source '${missing.join("', '")}'`);
    }
    if (input.clientId) {
      const c = await this.getClient(input.clientId);
      if (!c) throw new Error(`Unknown client '${input.clientId}'`);
      if (c.tenant_mode !== "enrollment") {
        throw new Error(
          `Client '${input.clientId}' is not in enrollment mode — ` +
            `rescope it with --tenant-mode enrollment first`,
        );
      }
    }
    // A predecessor's client is kept as it was recorded: an any-client code
    // records the connector that redeemed it, whatever that connector's mode.
    const clientId = input.clientId ?? prior?.client_id ?? null;
    // A soft-deleted connector would pin the replacement to a client that can
    // never redeem it.
    if (input.clientId === undefined && clientId !== null && !(await this.getClient(clientId))) {
      throw new Error(`Unknown client '${clientId}' (name another client for the replacement)`);
    }
    const label = input.label ?? prior?.label ?? null;
    const ttl = input.ttlSeconds ?? 7 * 24 * 3600;
    // Upper bound as well as lower: `new Date(now + ttl*1000)` throws a bare
    // RangeError once the result leaves the representable range, and a code
    // that outlives the pilot is not a feature anyway.
    const MAX_TTL = 365 * 24 * 3600;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL) {
      throw new Error(`ttl must be between 1 second and ${MAX_TTL} seconds (365d)`);
    }
    const id = generateToken("memrain_enr_");
    const code = generateToken("memrain_en_");
    const federated = federatedIn;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const spendId = prior ? (prior.spend_id ?? prior.id) : null;
    await this.engine.transaction(async (tx) => {
      // One live replacement per predecessor: an older unredeemed one would
      // otherwise stay usable and redeem into a second grant on the same key.
      if (prior) {
        const superseded = await tx.query<{ id: string; client_id: string | null }>(
          `UPDATE oauth_enrollments SET revoked_at = NOW()
            WHERE replaces_id = $1 AND used_at IS NULL AND revoked_at IS NULL
            RETURNING id, client_id`,
          [prior.id],
        );
        for (const old of superseded.rows) {
          await writeEnrollmentAudit(tx, old.id, old.client_id, "revoke_code", audit, { revoked: false }, {
            revoked: true,
            superseded_by: id,
          });
        }
      }
      await tx.query(
        `INSERT INTO oauth_enrollments
           (id, code_hash, client_id, source_id, federated_read, label, expires_at,
            spend_id, replaces_id, budget_usd_per_day)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7::timestamptz, $8, $9, $10)`,
        [
          id,
          hashToken(code),
          clientId,
          sourceId,
          federated,
          label,
          expiresAt,
          spendId,
          prior?.id ?? null,
          prior?.budget_usd_per_day ?? null,
        ],
      );
      await writeEnrollmentAudit(tx, id, clientId, "issue", audit, null, {
        source_id: sourceId,
        federated_read: federated,
        label,
        expires_at: expiresAt,
        spend_id: spendId ?? id,
        replaces_id: prior?.id ?? null,
      });
    });
    return {
      id,
      code,
      expiresAt,
      spendId: spendId ?? id,
      replaces: prior?.id ?? null,
      sourceId,
      federatedRead: federated,
      label,
      clientId,
    };
  }

  /**
   * Redeem an enrollment code for `clientId`. ONE atomic UPDATE claims the row
   * — there is no check-then-act, so two concurrent redemptions cannot both
   * succeed. Returns the grant to bind, or undefined for wrong / used /
   * expired / revoked / other-client alike: the caller renders the same
   * message for all of them so the form is not an oracle.
   */
  async claimEnrollment(
    code: string,
    clientId: string,
  ): Promise<GrantScope | undefined> {
    if (typeof code !== "string" || code.length < 16 || code.length > 256) {
      return undefined;
    }
    return this.engine.transaction(async (tx) => {
      const r = await tx.query<{
        id: string;
        source_id: string;
        federated_read: string[] | null;
        replaces_id: string | null;
      }>(
        // The redeeming connector is recorded on an any-client enrollment: its
        // daily cap is the fallback for the person's own.
        `UPDATE oauth_enrollments
            SET used_at = NOW(), client_id = COALESCE(client_id, $2)
          WHERE code_hash = $1
            AND used_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > NOW()
            AND (client_id IS NULL OR client_id = $2)
          RETURNING id, source_id, federated_read, replaces_id`,
        [hashToken(code), clientId],
      );
      const row = r.rows[0];
      if (!row) return undefined;
      // A replacement retires the enrollment it replaces the moment it is
      // redeemed, so the person never holds two live grants. A claim handed
      // back by releaseEnrollment leaves the predecessor revoked; the person
      // redeems the same code again.
      if (row.replaces_id) {
        const prior = await revokeGrantIn(tx, row.replaces_id);
        if (prior && !prior.wasRevoked) {
          await writeEnrollmentAudit(
            tx,
            row.replaces_id,
            prior.clientId,
            "replaced",
            { actor: `enrollment:${row.id}`, via: "enrollment" },
            { revoked: false },
            { revoked: true, replaced_by: row.id, tokens_deleted: prior.tokens },
          );
        }
      }
      return { sourceId: row.source_id, federatedRead: row.federated_read ?? [row.source_id], grantId: row.id };
    });
  }

  /**
   * Hand a claimed code back when the authorization it was claimed for never
   * got minted. Guarded on `used_code_hash IS NULL` so it can only ever undo a
   * claim that produced nothing — a code whose grant was issued stays spent.
   */
  async releaseEnrollment(code: string): Promise<boolean> {
    const r = await this.engine.query<{ id: string }>(
      `UPDATE oauth_enrollments SET used_at = NULL
        WHERE code_hash = $1 AND used_at IS NOT NULL AND used_code_hash IS NULL
        RETURNING id`,
      [hashToken(code)],
    );
    return r.rows.length > 0;
  }

  /** Record which authorization code a claimed enrollment produced. */
  async linkEnrollmentToCode(code: string, authCodeHash: string): Promise<void> {
    await this.engine.query(
      `UPDATE oauth_enrollments SET used_code_hash = $2 WHERE code_hash = $1`,
      [hashToken(code), authCodeHash],
    );
  }

  /**
   * Every enrollment, newest first. With `clientId`, only those that client
   * redeemed or may redeem: codes pinned to it, and unredeemed any-client codes.
   */
  async listEnrollments(clientId?: string): Promise<EnrollmentInfo[]> {
    const rows = await this.rows(
      `SELECT e.id, e.label, e.source_id, e.federated_read, e.client_id,
              e.expires_at::text AS expires_at, e.used_at::text AS used_at,
              e.revoked_at::text AS revoked_at, e.created_at::text AS created_at,
              COALESCE(e.spend_id, e.id) AS spend_id, e.replaces_id, e.budget_usd_per_day,
              (SELECT max(t.created_at) FROM oauth_tokens t
                WHERE t.grant_bound AND t.grant_id = e.id)::text AS last_token_at
         FROM oauth_enrollments e
        WHERE $1::text IS NULL OR e.client_id = $1::text OR e.client_id IS NULL
        ORDER BY e.created_at DESC`,
      [clientId ?? null],
    );
    return rows.map((r) => {
      const x = r as Record<string, unknown>;
      return {
        id: x.id as string,
        label: (x.label as string | null) ?? null,
        source_id: x.source_id as string,
        federated_read: (x.federated_read as string[]) ?? [],
        client_id: (x.client_id as string | null) ?? null,
        expires_at: x.expires_at as string,
        used_at: (x.used_at as string | null) ?? null,
        revoked_at: (x.revoked_at as string | null) ?? null,
        created_at: x.created_at as string,
        spend_id: x.spend_id as string,
        replaces_id: (x.replaces_id as string | null) ?? null,
        budget_usd_per_day: x.budget_usd_per_day == null ? null : Number(x.budget_usd_per_day),
        last_token_at: (x.last_token_at as string | null) ?? null,
      };
    });
  }

  /** Kill a code nobody redeemed yet. False when it is used, revoked or unknown. */
  async revokeEnrollment(id: string, audit: EnrollmentAuditActor = UNATTRIBUTED): Promise<boolean> {
    return this.engine.transaction(async (tx) => {
      const r = await tx.query<{ id: string; client_id: string | null }>(
        `UPDATE oauth_enrollments SET revoked_at = NOW()
          WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL
          RETURNING id, client_id`,
        [id],
      );
      const row = r.rows[0];
      if (!row) return false;
      await writeEnrollmentAudit(tx, id, row.client_id, "revoke_code", audit, { revoked: false }, { revoked: true });
      return true;
    });
  }

  /**
   * Cut off one person on a shared connector after she redeemed her code.
   * `revokeEnrollment` only kills a code nobody used yet; this marks the
   * enrollment revoked whatever its state and deletes every code and token
   * minted under it, in one transaction, so nothing issued before the revoke
   * outlives it. The other people on the same client are untouched. Returns
   * false when no enrollment has that id.
   */
  async revokeGrant(
    id: string,
    audit: EnrollmentAuditActor = UNATTRIBUTED,
  ): Promise<{ revoked: boolean; tokens: number }> {
    return this.engine.transaction(async (tx) => {
      const r = await revokeGrantIn(tx, id);
      if (!r) return { revoked: false, tokens: 0 };
      await writeEnrollmentAudit(
        tx,
        id,
        r.clientId,
        "revoke_grant",
        audit,
        { revoked: r.wasRevoked, used: r.used },
        { revoked: true, used: r.used, tokens_deleted: r.tokens },
      );
      return { revoked: true, tokens: r.tokens };
    });
  }

  /** Public client-mode clients: the ones an auto-approving /authorize refuses. */
  async listClientsNeedingConsent(): Promise<Array<{ client_id: string; client_name: string }>> {
    return this.rows<{ client_id: string; client_name: string }>(
      `SELECT client_id, client_name FROM oauth_clients
        WHERE deleted_at IS NULL AND client_secret_hash IS NULL
          AND COALESCE(tenant_mode, 'client') = 'client'
          AND 'authorization_code' = ANY(grant_types)
        ORDER BY client_id`,
    );
  }

  // -------------------------------------------------------------------------
  // Personal access token grants
  // -------------------------------------------------------------------------

  /**
   * Apply one grant change to every live token named `name`, under a row lock.
   * Each row's `grant_revision` is bumped and one `oauth_grant_audit` row
   * (`pat:<id>`) written by the same statement, so a PAT grant — promotion to
   * admin included — never changes without a trace. Returns the rows changed;
   * an empty list when no live token has that name.
   */
  private async mutatePatGrant(
    tx: Engine,
    name: string,
    who: GrantActor,
    action: string,
    next: (before: PatGrantSnapshot) => PatGrantSnapshot,
    set: { sql: string; params: unknown[] },
  ): Promise<PatGrantChange[]> {
    const locked = await tx.query<{
      id: number | string;
      name: string;
      scopes: unknown;
      permissions: unknown;
      budget_usd_per_day: unknown;
    }>(
      `SELECT id, name, scopes, permissions, budget_usd_per_day
         FROM access_tokens
        WHERE name = $1 AND revoked_at IS NULL
        ORDER BY id
        FOR UPDATE`,
      [name],
    );
    const out: PatGrantChange[] = [];
    for (const row of locked.rows) {
      const id = Number(row.id);
      const before = patSnapshot(row);
      const after = next(before);
      const applied = await tx.query<{ revision: number | string }>(
        `WITH u AS (
           UPDATE access_tokens SET ${set.sql}, grant_revision = grant_revision + 1
            WHERE id = $1 AND revoked_at IS NULL
            RETURNING id, grant_revision
         )
         INSERT INTO oauth_grant_audit (client_id, revision, actor, via, before, after)
         SELECT 'pat:' || u.id, u.grant_revision, $2, $3, $4::text::jsonb, $5::text::jsonb FROM u
         RETURNING revision`,
        [
          id,
          who.actor,
          who.via,
          JSON.stringify(before),
          JSON.stringify({ ...after, action }),
          ...set.params,
        ],
      );
      const revision = applied.rows[0]?.revision;
      // The row is locked, so the UPDATE cannot miss it.
      if (revision === undefined) throw new Error(`grant write for token ${id} affected no row`);
      out.push({ id, revision: Number(revision), before, after });
    }
    return out;
  }

  /**
   * Replace the scopes of the live personal access token(s) named `name`.
   * Audited and revision-bumped like a client rescope; the next request made
   * with the token is verified against the new set.
   */
  async setPatScopes(name: string, scopes: string[], who: GrantActor): Promise<PatGrantChange[]> {
    const list = Array.from(new Set(scopes.map((s) => s.trim()).filter(Boolean)));
    if (list.length === 0) throw new Error("scope list cannot be empty");
    assertAllowedScopes(list);
    return this.engine.transaction((tx) =>
      this.mutatePatGrant(
        tx,
        name,
        who,
        "set_scopes",
        (b) => ({ ...b, scopes: sortedCopy(list) }),
        { sql: "scopes = $6::text[]", params: [list] },
      ),
    );
  }

  /**
   * Replace the takes-holder allow-list of the live token(s) named `name`.
   * A JSONB merge, not a replace: an operator-set `permissions.source_id`
   * tenant grant survives (a wholesale replace would floor the token to the
   * 'default' source).
   */
  async setPatTakesHolders(name: string, holders: string[], who: GrantActor): Promise<PatGrantChange[]> {
    const list = holders.map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) {
      throw new Error('takes-holders list cannot be empty (use "world" for default-deny on private)');
    }
    return this.engine.transaction((tx) =>
      this.mutatePatGrant(
        tx,
        name,
        who,
        "set_takes_holders",
        (b) => ({ ...b, takes_holders: list }),
        {
          sql: "permissions = COALESCE(permissions, '{}'::jsonb) || $6::text::jsonb",
          params: [JSON.stringify({ takes_holders: list })],
        },
      ),
    );
  }

  /**
   * Set (or clear) the daily USD ceiling of a client, or of a personal access
   * token when no client has that id. `null` removes the cap, which
   * is also the default — an uncapped client is allowed, exactly as before the
   * column existed. The column is NUMERIC(10,2); a value that would not fit is
   * refused here rather than silently rounded by the database. A client's or a
   * token's cap change is audited and revision-bumped like its scopes.
   */
  async setClientBudget(
    clientId: string,
    usdPerDay: number | null,
    who: GrantActor = UNATTRIBUTED_GRANT,
  ): Promise<boolean> {
    if (usdPerDay !== null) {
      if (!Number.isFinite(usdPerDay) || usdPerDay < 0) {
        throw new Error("budget must be a non-negative number of USD, or null to clear it");
      }
      if (usdPerDay > 99_999_999.99) {
        throw new Error("budget exceeds the NUMERIC(10,2) column");
      }
    }
    const isClient = await this.engine.transaction(async (tx) => {
      const locked = await tx.query<{
        source_id: string | null;
        federated_read: string[] | null;
        bound_slug_prefixes: string[] | null;
        tenant_mode: string | null;
        scope: string | null;
        budget_usd_per_day: unknown;
      }>(
        `SELECT source_id, federated_read, bound_slug_prefixes, tenant_mode, scope, budget_usd_per_day
           FROM oauth_clients
          WHERE client_id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [clientId],
      );
      const row = locked.rows[0];
      if (!row) return false;
      const snapshot = grantSnapshot(row);
      const applied = await tx.query<{ revision: number }>(
        `WITH u AS (
           UPDATE oauth_clients SET budget_usd_per_day = $2, grant_revision = grant_revision + 1
            WHERE client_id = $1 AND deleted_at IS NULL
            RETURNING grant_revision
         )
         INSERT INTO oauth_grant_audit (client_id, revision, actor, via, before, after)
         SELECT $1, u.grant_revision, $3, $4, $5::text::jsonb, $6::text::jsonb FROM u
         RETURNING revision`,
        [
          clientId,
          usdPerDay,
          who.actor,
          who.via,
          JSON.stringify({
            ...snapshot,
            budget_usd_per_day: row.budget_usd_per_day == null ? null : Number(row.budget_usd_per_day),
          }),
          JSON.stringify({ ...snapshot, action: "set_budget", budget_usd_per_day: usdPerDay }),
        ],
      );
      // The row is locked, so the UPDATE cannot miss it.
      if (applied.rows[0]?.revision === undefined) throw new Error(`budget write for "${clientId}" affected no row`);
      return true;
    });
    if (isClient) return true;
    // Not an OAuth client: a personal access token spends under its name.
    const t = await this.engine.transaction((tx) =>
      this.mutatePatGrant(
        tx,
        clientId,
        who,
        "set_budget",
        (b) => ({ ...b, budget_usd_per_day: usdPerDay }),
        { sql: "budget_usd_per_day = $6::numeric", params: [usdPerDay] },
      ),
    );
    if (t.length > 0) return true;
    // Or an enrollment: the person redeemed from it spends under its id.
    const e = await this.engine.query<{ id: string }>(
      // Addressed by its own id or by the spend key a replacement inherited.
      `UPDATE oauth_enrollments SET budget_usd_per_day = $2
        WHERE (id = $1 OR spend_id = $1) AND revoked_at IS NULL RETURNING id`,
      [clientId, usdPerDay],
    );
    return e.rows.length > 0;
  }

  // -------------------------------------------------------------------------
  // Authorization-code flow
  // -------------------------------------------------------------------------

  /**
   * Mint an authorization code and return the redirect target. The HTTP
   * layer is responsible for issuing the 302 — this method only returns the
   * URL so it stays transport-neutral.
   */
  async authorize(
    client: OAuthClientInfo,
    params: AuthorizationParams,
    grant?: GrantScope,
  ): Promise<{ redirectUrl: string }> {
    const code = generateToken("memrain_code_");
    const codeHash = hashToken(code);
    const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 min TTL

    // Clamp the requested scope to the client's registered grant (RFC 6749
    // §3.3). An omitted request defaults to the client's full registered
    // scope; an over-broad explicit request is filtered down to the allowed
    // set so it cannot escalate.
    const allowedScopes = parseScopeString(client.scope);
    const requestedScopes =
      params.scopes && params.scopes.length ? params.scopes : allowedScopes;
    const grantedScopes = requestedScopes.filter((s) =>
      hasScope(allowedScopes, s),
    );

    // The client row this approval was made against. An unbound code takes its
    // tenant from that row, so it is minted only if the row is still the same
    // when the code goes in (see the insert below).
    const approved = (
      await this.rows<ClientGrantState>(
        `SELECT grant_revision, tenant_mode, source_id FROM oauth_clients
          WHERE client_id = $1 AND deleted_at IS NULL`,
        [client.client_id],
      )
    )[0];
    if (!approved) throw new Error(`Unknown client '${client.client_id}'`);

    // A named grant must exist before it is handed out: a code pinned to a
    // source that was never registered would fall back to the client row at
    // verification time (COALESCE), silently WIDENING the session instead of
    // narrowing it. Fail closed here instead.
    if (grant?.sourceId) {
      const known = await this.rows<{ id: string }>(
        "SELECT id FROM sources WHERE id = $1",
        [grant.sourceId],
      );
      if (known.length === 0) {
        throw new Error(`Unknown source '${grant.sourceId}' for this grant`);
      }
    }

    // rescopeClient deletes unbound codes under FOR UPDATE on the client row.
    // Inserting under a share lock, after re-reading the row, means a rescope
    // either finds this code and deletes it, or committed first and the stale
    // approval is refused here instead of minting a code for the new tenant.
    await this.engine.transaction(async (tx) => {
      const current = (
        await tx.query<ClientGrantState & { redirect_uris: string[] | null }>(
          `SELECT grant_revision, tenant_mode, source_id, redirect_uris FROM oauth_clients
            WHERE client_id = $1 AND deleted_at IS NULL
            FOR SHARE`,
          [client.client_id],
        )
      ).rows[0];
      if (!current) throw new Error(`Unknown client '${client.client_id}'`);
      // The endpoint checked the redirect URI against an earlier read of the
      // row; a set-redirect-uris that committed since must not get a code for
      // the URI it removed. Grant-bound codes skip the revision compare below,
      // so this is their only check.
      if (!redirectUriRegistered(current.redirect_uris ?? [], params.redirectUri)) {
        throw new GrantConflictError(Number(approved.grant_revision), Number(current.grant_revision));
      }
      if (grant === undefined) {
        const expected = Number(approved.grant_revision);
        const actual = Number(current.grant_revision);
        if (
          actual !== expected ||
          parseTenantMode(current.tenant_mode) !== client.tenant_mode ||
          parseTenantMode(approved.tenant_mode) !== client.tenant_mode ||
          current.source_id !== approved.source_id
        ) {
          throw new GrantConflictError(expected, actual);
        }
      }
      await tx.query(
        `INSERT INTO oauth_codes
           (code_hash, client_id, scopes, code_challenge,
            code_challenge_method, redirect_uri, state, resource, expires_at,
            source_id, federated_read, grant_bound, grant_id, grant_revision)
         VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8, $9, $10, $11::text[], $12, $13, $14)`,
        [
          codeHash,
          client.client_id,
          grantedScopes,
          params.codeChallenge,
          "S256",
          params.redirectUri,
          params.state ?? null,
          params.resource?.toString() ?? null,
          expiresAt,
          grant?.sourceId ?? null,
          grant?.federatedRead ?? null,
          grant !== undefined,
          grant?.grantId ?? null,
          // The revision this approval was made against: /token refuses the
          // code once the client has been rescoped since.
          Number(approved.grant_revision),
        ],
      );
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) redirectUrl.searchParams.set("state", params.state);
    return { redirectUrl: redirectUrl.toString() };
  }

  /** Return the stored PKCE challenge for a code, bound to the client so a
   *  wrong client cannot read another client's challenge. */
  async challengeForAuthorizationCode(
    client: OAuthClientInfo,
    authorizationCode: string,
  ): Promise<string> {
    const codeHash = hashToken(authorizationCode);
    const rows = await this.rows<{ code_challenge: string }>(
      `SELECT code_challenge FROM oauth_codes
       WHERE code_hash = $1 AND client_id = $2 AND expires_at > $3`,
      [codeHash, client.client_id, Math.floor(Date.now() / 1000)],
    );
    if (rows.length === 0) {
      throw new Error("Authorization code not found or expired");
    }
    return rows[0]!.code_challenge;
  }

  /**
   * The resource (RFC 8707) a code was approved for, or null when none was
   * named or the code is not this client's. Read without consuming the code,
   * so a /token request naming another resource can be refused while the
   * code stays redeemable. A code's resource never changes after /authorize.
   */
  async resourceForAuthorizationCode(
    client: OAuthClientInfo,
    authorizationCode: string,
  ): Promise<string | null> {
    const rows = await this.rows<{ resource: string | null }>(
      `SELECT resource FROM oauth_codes WHERE code_hash = $1 AND client_id = $2`,
      [hashToken(authorizationCode), client.client_id],
    );
    return rows[0]?.resource ?? null;
  }

  /** Same as `resourceForAuthorizationCode`, for a refresh token. */
  async resourceForRefreshToken(
    client: OAuthClientInfo,
    refreshToken: string,
  ): Promise<string | null> {
    const rows = await this.rows<{ resource: string | null }>(
      `SELECT resource FROM oauth_tokens
        WHERE token_hash = $1 AND token_type = 'refresh' AND client_id = $2`,
      [hashToken(refreshToken), client.client_id],
    );
    return rows[0]?.resource ?? null;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInfo,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeHash = hashToken(authorizationCode);
    const now = Math.floor(Date.now() / 1000);

    // Single-use redemption: bind client_id (and redirect_uri when present)
    // into the DELETE…RETURNING so the row is consumed atomically. A second
    // request, wrong client, or wrong redirect_uri gets zero rows back. Use
    // `!== undefined` so an empty-string redirect_uri can't skip the binding.
    // Consume and issue share one transaction behind a share lock on the client
    // row, so a rescope (FOR UPDATE) cannot land between them and miss the
    // unbound tokens this issues.
    // A code refused for a stale consent stays consumed: the error travels out
    // as a value so the DELETE commits (see exchangeRefreshToken).
    const outcome = await this.engine.transaction(
      async (tx): Promise<{ tokens: OAuthTokens } | { error: string }> => {
        const policy = await lockClientForIssue(tx, client.client_id);
        if (policy === undefined) return { error: "Client has been revoked" };
        const rows = (
          redirectUri !== undefined
            ? await tx.query<{ scopes: string[] }>(
                `DELETE FROM oauth_codes
                 WHERE code_hash = $1 AND client_id = $2
                   AND redirect_uri = $3 AND expires_at > $4
                   AND ${grantNotRevoked("oauth_codes")}
                   AND ${unboundAllowed("oauth_codes")}
                 RETURNING client_id, scopes, resource, source_id, federated_read,
                           grant_bound, grant_id, grant_revision`,
                [codeHash, client.client_id, redirectUri, now],
              )
            : await tx.query<{ scopes: string[] }>(
                `DELETE FROM oauth_codes
                 WHERE code_hash = $1 AND client_id = $2 AND expires_at > $3
                   AND ${grantNotRevoked("oauth_codes")}
                   AND ${unboundAllowed("oauth_codes")}
                 RETURNING client_id, scopes, resource, source_id, federated_read,
                           grant_bound, grant_id, grant_revision`,
                [codeHash, client.client_id, now],
              )
        ).rows;
        if (rows.length === 0) {
          throw new Error("Authorization code not found or expired");
        }
        const row = rows[0]! as Record<string, unknown>;

        // The operator approved the client as it stood at /authorize. A rescope
        // since then changed what this code would grant, so the person has to
        // go through /authorize again. A code minted before the column existed
        // carries NULL and is redeemed as before.
        const approvedRevision = row["grant_revision"];
        if (
          approvedRevision !== null &&
          approvedRevision !== undefined &&
          (policy === undefined || Number(approvedRevision) !== policy.grantRevision)
        ) {
          return { error: "The client's grant changed after this code was approved; authorize again" };
        }

        // A code carries the scopes approved at /authorize; the client may have
        // been narrowed since.
        const scopes = intersectGrantedScopes((row["scopes"] as string[]) || [], policy.scopes);
        if (scopes.length === 0) {
          return { error: "The client no longer holds any scope this code was approved for" };
        }
        const withRefresh = clientAllowsGrant(policy?.grantTypes, "refresh_token");
        // The resource approved at /authorize binds the tokens; a request-time
        // value only fills in for a code that named none.
        return {
          tokens: await this.issueTokens(
            client.client_id,
            scopes,
            boundResource(row, resource),
            withRefresh,
            {
              accessTtl: policy?.accessTtl,
              refreshTtl: policy?.refreshTtl,
              grant: grantFromRow(row),
              db: tx,
            },
          ),
        };
      },
    );
    if ("error" in outcome) throw new Error(outcome.error);
    return outcome.tokens;
  }

  // -------------------------------------------------------------------------
  // Refresh token
  // -------------------------------------------------------------------------

  async exchangeRefreshToken(
    client: OAuthClientInfo,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    // Checked before the token is consumed: an empty list passes every subset
    // test and would mint tokens that hold no scope.
    if (scopes !== undefined && scopes.length === 0) {
      throw new Error("invalid_scope: the requested scope list is empty");
    }
    const tokenHash = hashToken(refreshToken);
    const now = Math.floor(Date.now() / 1000);

    // Rotate atomically: bind client_id into the DELETE so a wrong-client
    // attempt cannot burn the legitimate client's refresh row (RFC 6749
    // §10.4 stolen-token detection depends on second-use failure). The
    // `revoked_at IS NULL` guard makes soft-revoke (revokeToken) effective for
    // refresh tokens too — a revoked refresh can't rotate a fresh access token.
    // Consume and issue share one transaction behind a share lock on the client
    // row (see exchangeAuthorizationCode). A refused refresh still commits its
    // DELETE, so the token stays burned: the error travels out as a value.
    //
    // Rotation keeps the refresh family and leaves the consumed hash behind. A
    // hash that comes back is either a retry (inside the grace window: refused,
    // nothing revoked) or a second holder of the chain (after it: the whole
    // family is revoked, since there is no telling which holder is legitimate,
    // once MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE is on; until then it is only logged).
    const outcome = await this.engine.transaction(
      async (tx): Promise<{ tokens: OAuthTokens } | { error: string; replayedFamily?: string }> => {
        const policy = await lockClientForIssue(tx, client.client_id);
        if (policy === undefined) return { error: "Client has been revoked" };
        if (!clientAllowsGrant(policy.grantTypes, "refresh_token")) {
          return { error: "Refresh token grant not authorized for this client" };
        }
        const rows = (
          await tx.query<{ scopes: string[]; expires_at: unknown }>(
            `DELETE FROM oauth_tokens
             WHERE token_hash = $1 AND token_type = 'refresh' AND client_id = $2
               AND revoked_at IS NULL
               AND ${grantNotRevoked("oauth_tokens")}
               AND ${unboundAllowed("oauth_tokens")}
             RETURNING client_id, scopes, expires_at, resource, source_id,
                       federated_read, grant_bound, grant_id, family_id`,
            [tokenHash, client.client_id],
          )
        ).rows;
        if (rows.length === 0) return this.refreshReplay(tx, tokenHash, client.client_id, now);

        const row = rows[0]!;
        // A token minted before families existed starts one here.
        const familyId =
          typeof (row as Record<string, unknown>)["family_id"] === "string"
            ? ((row as Record<string, unknown>)["family_id"] as string)
            : randomUUID();
        // NULL expires_at is treated as expired (fail-closed).
        const expiresAt = coerceTimestamp(row.expires_at);
        await tx.query(
          `INSERT INTO oauth_refresh_consumed (token_hash, family_id, client_id, consumed_at, expires_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (token_hash) DO NOTHING`,
          [tokenHash, familyId, client.client_id, now, expiresAt ?? now],
        );
        if (expiresAt === undefined || expiresAt < now) {
          return { error: "Refresh token expired" };
        }

        // Requested scope on refresh must be a subset of the original grant
        // (RFC 6749 §6). hasScope honors the hierarchy so an `admin` grant can
        // refresh down to an implied scope. Omitted scope inherits the grant.
        // The grant is first cut down to what the client holds now, and the new
        // tokens carry the cut-down set, so a refresh never undoes a narrowing,
        // not even after the client is widened again.
        const grantedScopes = intersectGrantedScopes((row.scopes as string[]) || [], policy.scopes);
        if (grantedScopes.length === 0) {
          return { error: "The client no longer holds any scope this refresh token was granted" };
        }
        if (scopes && scopes.some((s) => !hasScope(grantedScopes, s))) {
          return { error: "Requested scope exceeds refresh token grant" };
        }
        const tokenScopes = scopes ?? grantedScopes;
        // The tenant is copied from the consumed refresh row and is NEVER read from
        // the request: a holder may narrow scope on refresh, never move source.
        // The resource rides along the same way, so rotation keeps the audience.
        return {
          tokens: await this.issueTokens(
            client.client_id,
            tokenScopes,
            boundResource(row, resource),
            true,
            {
              accessTtl: policy?.accessTtl,
              refreshTtl: policy?.refreshTtl,
              grant: grantFromRow(row),
              familyId,
              db: tx,
            },
          ),
        };
      },
    );
    if ("error" in outcome) {
      if (outcome.replayedFamily === undefined) throw new Error(outcome.error);
      if (!refreshReuseRevokeFromEnv()) {
        console.warn(
          `[oauth] refresh token reuse for client ${client.client_id}: family ${outcome.replayedFamily} left live (MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE off)`,
        );
        throw new Error("Refresh token reuse detected");
      }
      const revoked = await this.revokeRefreshFamily(client.client_id, outcome.replayedFamily);
      console.warn(
        `[oauth] refresh token reuse for client ${client.client_id}: revoked ${revoked} token(s) of its family`,
      );
      throw new Error("Refresh token reuse detected; the session was revoked");
    }
    return outcome.tokens;
  }

  /**
   * The refusal for a refresh token that matched no live row. When it is one
   * this client already rotated, past the grace window, it also names the
   * family to revoke. Bound to the presenting client, so presenting another
   * client's spent token revokes nothing of theirs. A tombstone past the spent
   * token's own expiry is ignored whether or not the sweep has pruned it yet.
   */
  private async refreshReplay(
    tx: Engine,
    tokenHash: string,
    clientId: string,
    now: number,
  ): Promise<{ error: string; replayedFamily?: string }> {
    const spent = (
      await tx.query<{ family_id: string; consumed_at: number | string }>(
        `SELECT family_id, consumed_at FROM oauth_refresh_consumed
          WHERE token_hash = $1 AND client_id = $2 AND expires_at >= $3`,
        [tokenHash, clientId, now],
      )
    ).rows[0];
    if (!spent) return { error: "Refresh token not found" };
    if (now - Number(spent.consumed_at) <= REFRESH_REUSE_GRACE_SECONDS) {
      return { error: "Refresh token already used" };
    }
    return { error: "Refresh token reuse detected", replayedFamily: spent.family_id };
  }

  /**
   * Delete every live token of one refresh family. Runs in its own transaction
   * behind FOR UPDATE on the client row: that waits out every rotation already
   * holding the share lock, so a token such a rotation inserts into the family
   * is committed (and visible) before the DELETE runs, and blocks new rotations
   * until it is done. Deleting from inside the replay's own transaction would
   * miss those rows under READ COMMITTED.
   */
  private async revokeRefreshFamily(clientId: string, familyId: string): Promise<number> {
    return this.engine.transaction(async (tx) => {
      await tx.query(`SELECT 1 FROM oauth_clients WHERE client_id = $1 FOR UPDATE`, [clientId]);
      const revoked = await tx.query<{ token_type: string }>(
        `DELETE FROM oauth_tokens WHERE family_id = $1 AND client_id = $2 RETURNING token_type`,
        [familyId, clientId],
      );
      return revoked.rows.length;
    });
  }

  // -------------------------------------------------------------------------
  // Token verification
  // -------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenHash = hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    // OAuth tokens first. JOIN oauth_clients so the source_id (write scope)
    // and federated_read (read set) arrive on the same query — no N+1 lookup.
    const oauthRows = await this.rows(
      // Tenancy is resolved TOKEN-FIRST. A grant-bound token carries the source
      // the operator approved for that one person, so a single shared connector
      // can serve several people in separate tenants. `grant_bound` decides
      // which side wins: an unbound row (every token issued before this, and
      // every client_credentials token) still takes the client row.
      `SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name,
              CASE WHEN t.grant_bound THEN t.source_id      ELSE c.source_id      END AS source_id,
              CASE WHEN t.grant_bound THEN t.federated_read ELSE c.federated_read END AS federated_read,
              t.grant_bound,
              c.bound_slug_prefixes,
              c.budget_usd_per_day,
              CASE WHEN t.grant_bound THEN t.grant_id END AS grant_id,
              COALESCE(e.spend_id, e.id) AS grant_spend_id,
              e.budget_usd_per_day AS grant_budget_usd_per_day,
              e.revoked_at AS grant_revoked_at,
              ${legacyGrantRevoked("t")} AS legacy_grant_revoked,
              c.deleted_at AS client_deleted_at,
              c.scope AS current_scope
       FROM oauth_tokens t
       LEFT JOIN oauth_clients c ON c.client_id = t.client_id
       LEFT JOIN oauth_enrollments e ON t.grant_bound AND e.id = t.grant_id
       WHERE t.token_hash = $1 AND t.token_type = 'access'
         AND t.revoked_at IS NULL`,
      [tokenHash],
    );

    if (oauthRows.length > 0) {
      const row = oauthRows[0] as Record<string, unknown>;
      // Revoking a client soft-deletes its row; a token it issued must stop
      // working even if the token row itself was never touched.
      if (row.client_deleted_at != null) {
        throw new InvalidTokenError("Client revoked");
      }
      // Same for one person cut off a shared connector: her tokens are deleted
      // at revoke, and this stops any that were minted while it ran.
      if (
        row.grant_bound === true &&
        (row.grant_revoked_at != null || row.legacy_grant_revoked === true)
      ) {
        throw new InvalidTokenError("Grant revoked");
      }
      // NULL expires_at is treated as expired (fail-closed).
      const expiresAt = coerceTimestamp(row.expires_at);
      if (expiresAt === undefined || expiresAt < now) {
        throw new InvalidTokenError("Token expired");
      }
      // Distinguish empty array (explicit no-federated-read) from undefined.
      const federatedRaw = row.federated_read;
      const allowedSources = Array.isArray(federatedRaw)
        ? (federatedRaw as string[])
        : undefined;
      const boundRaw = row.bound_slug_prefixes;
      // Fail CLOSED on a corrupt fence column: an unparseable value must never
      // silently widen a bound client to unbounded.
      if (boundRaw != null && !Array.isArray(boundRaw)) {
        throw new InvalidTokenError("Corrupt bound_slug_prefixes on client row");
      }
      const boundSlugPrefixes =
        Array.isArray(boundRaw) && boundRaw.length > 0
          ? (boundRaw as string[])
          : undefined;
      // The token holds what it was issued AND its client still holds, so a
      // rescope that narrows the client binds tokens already handed out.
      const scopes = intersectGrantedScopes(
        (row.scopes as string[]) || [],
        parseScopeString(typeof row.current_scope === "string" ? row.current_scope : null),
      );
      if (scopes.length === 0) {
        throw new InvalidTokenError("Token holds no scope its client is still granted");
      }
      return {
        token,
        clientId: row.client_id as string,
        clientName: (row.client_name as string | null) ?? undefined,
        scopes,
        expiresAt,
        resource: row.resource ? new URL(row.resource as string) : undefined,
        sourceId: (row.source_id as string | null) ?? undefined,
        allowedSources,
        ...(boundSlugPrefixes ? { boundSlugPrefixes } : {}),
        // A person enrolled on a shared connector spends under their own
        // enrollment, capped by it, else by the connector's cap on their own.
        // A replacement enrollment spends under its predecessor's key.
        ...(typeof row.grant_id === "string"
          ? { spendId: typeof row.grant_spend_id === "string" ? row.grant_spend_id : row.grant_id }
          : {}),
        budgetUsdPerDay:
          typeof row.grant_id === "string" && row.grant_budget_usd_per_day != null
            ? toCapUsd(row.grant_budget_usd_per_day)
            : toCapUsd(row.budget_usd_per_day),
      };
    }

    // Fallback: legacy access_tokens (pre-OAuth bearer path). These rows may
    // carry a permissions.source_id grant the OAuth transport must preserve
    // instead of pinning every legacy token to 'default'.
    let legacyRows: Record<string, unknown>[];
    try {
      legacyRows = await this.rows(
        `SELECT name, permissions, scopes, budget_usd_per_day FROM access_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash],
      );
    } catch (err) {
      if (isUndefinedColumnError(err, "permissions")) {
        legacyRows = await this.rows(
          `SELECT name FROM access_tokens
           WHERE token_hash = $1 AND revoked_at IS NULL`,
          [tokenHash],
        );
      } else {
        throw err;
      }
    }

    if (legacyRows.length > 0) {
      const row = legacyRows[0]!;
      await this.engine.query(
        // Once a minute is enough for "last used"; writing on every request
        // turns each authenticated read into a row update.
        `UPDATE access_tokens SET last_used_at = now()
          WHERE token_hash = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
        [tokenHash],
      );
      const name = row.name as string;
      // Absent on the pre-`permissions` fallback query below, and NULL on rows
      // written before the column existed — both fall through to the default.
      const rawScopes = row.scopes;
      let permissions: unknown = row.permissions;
      if (typeof permissions === "string") {
        try {
          permissions = JSON.parse(permissions);
        } catch {
          permissions = undefined;
        }
      }
      const sourceGrant =
        permissions && typeof permissions === "object"
          ? (permissions as Record<string, unknown>).source_id
          : undefined;
      const { sourceId, allowedSources } = parseLegacyTokenScope(sourceGrant);
      // The mig-072 takes-holder knob: enforce what the token actually stores.
      // Absent/malformed → no holder scope (holder reads stay unscoped).
      const holdersRaw =
        permissions && typeof permissions === "object"
          ? (permissions as Record<string, unknown>).takes_holders
          : undefined;
      const takesHolders = Array.isArray(holdersRaw)
        ? holdersRaw.filter((s): s is string => typeof s === "string" && s.length > 0)
        : undefined;
      // Enforce what the row actually stores. This used to hand every
      // access_tokens row ["read","write","admin"] regardless of its `scopes`
      // column — so a token both mint paths create as ["read","write"]
      // (admin-api.ts, commands/auth.ts) satisfied the admin gate in
      // mcp/dispatch.ts and could reach `purge_deleted_pages`, which hard
      // deletes. A row with no scopes recorded falls back to the same
      // ["read","write"] those mint paths write — never admin.
      // A row that RECORDS an empty array is a token deliberately stripped of
      // every scope — treat it as such. Only a row with NO scopes recorded at
      // all (NULL / malformed, i.e. written before the column existed) takes
      // the legacy fallback. Folding the two together turned "revoke this
      // token's access" into "give it read+write".
      const storedScopes = Array.isArray(rawScopes)
        ? rawScopes.filter((x): x is string => typeof x === "string" && x.length > 0)
        : null;
      return {
        token,
        clientId: name,
        clientName: name,
        scopes: storedScopes ?? ["read", "write"],
        // Legacy tokens never expire — set a year out so the number check passes.
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        sourceId,
        allowedSources,
        ...(takesHolders && takesHolders.length > 0 ? { takesHolders } : {}),
        budgetUsdPerDay: toCapUsd(row.budget_usd_per_day),
      };
    }

    throw new InvalidTokenError("Invalid token");
  }

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------

  async revokeToken(
    client: OAuthClientInfo,
    request: TokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashToken(request.token);
    // Bind client_id so a client can only revoke its own tokens (RFC 7009
    // §2.1). Soft-revoke (set revoked_at) rather than delete so the row keeps
    // its audit trail: verifyAccessToken already gates on `revoked_at IS NULL`,
    // and exchangeRefreshToken does the same, so a revoked access OR refresh
    // token stops working immediately. Idempotent — a second revoke is a no-op.
    await this.engine.query(
      `UPDATE oauth_tokens SET revoked_at = now()
       WHERE token_hash = $1 AND client_id = $2 AND revoked_at IS NULL`,
      [tokenHash, client.client_id],
    );
  }

  // -------------------------------------------------------------------------
  // Client credentials
  // -------------------------------------------------------------------------

  /**
   * Verify a confidential client's secret without spending it. Returns the
   * client on success; throws an opaque "Invalid client" on failure
   * (RFC 6749 §5.2). Public clients (NULL secret hash) are refused so the
   * PKCE path stays the canonical surface for them.
   */
  async verifyConfidentialClientSecret(
    clientId: string,
    presentedSecret: string,
  ): Promise<OAuthClientInfo> {
    const client = await this.getClient(clientId);
    if (!client) throw new Error("Invalid client");
    if (client.client_secret === undefined) {
      throw new Error("Invalid client");
    }
    const presentedHash = hashToken(presentedSecret);
    if (client.client_secret !== presentedHash) {
      throw new Error("Invalid client");
    }
    await this.assertClientNotRevoked(clientId);
    return client;
  }

  async exchangeClientCredentials(
    clientId: string,
    clientSecret: string,
    requestedScope?: string,
  ): Promise<OAuthTokens> {
    const client = await this.getClient(clientId);
    if (!client) throw new Error("Client not found");

    await this.assertClientNotRevoked(clientId);

    // Grant-type check before secret comparison.
    const grants = client.grant_types || [];
    if (!grants.includes("client_credentials")) {
      throw new Error(
        "Client credentials grant not authorized for this client",
      );
    }

    const secretHash = hashToken(clientSecret);
    if (client.client_secret !== secretHash) {
      throw new Error("Invalid client secret");
    }

    // Clamp requested scope to the client's registered grant; hasScope honors
    // the hierarchy so an `admin` client mints implied scopes too.
    const allowedScopes = parseScopeString(client.scope);
    const requestedScopes = requestedScope
      ? parseScopeString(requestedScope)
      : allowedScopes;
    const grantedScopes = requestedScopes.filter((s) =>
      hasScope(allowedScopes, s),
    );

    // Per-client TTL override: access_ttl_seconds, else the older token_ttl
    // that only this grant ever read.
    const ttlRows = await this.rows<{ token_ttl: unknown; access_ttl_seconds: unknown }>(
      `SELECT token_ttl, access_ttl_seconds FROM oauth_clients WHERE client_id = $1`,
      [clientId],
    );
    const clientTtl =
      positiveOrUndefined(ttlRows[0]?.access_ttl_seconds) ?? positiveOrUndefined(ttlRows[0]?.token_ttl);

    // Client credentials: access token only, no refresh (RFC 6749 §4.4.3).
    return this.issueTokens(clientId, grantedScopes, undefined, false, { accessTtl: clientTtl });
  }

  /**
   * Throw if the client is soft-deleted. Tolerates a schema without the
   * deleted_at column (older brains) but surfaces every other error — a bare
   * catch here would be a fail-open posture in a security path.
   */
  private async assertClientNotRevoked(clientId: string): Promise<void> {
    try {
      const revoked = await this.rows(
        `SELECT deleted_at FROM oauth_clients
         WHERE client_id = $1 AND deleted_at IS NOT NULL`,
        [clientId],
      );
      if (revoked.length > 0) throw new Error("Client has been revoked");
    } catch (e) {
      if (e instanceof Error && e.message === "Client has been revoked") {
        throw e;
      }
      if (!isUndefinedColumnError(e, "deleted_at")) throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /** Delete expired access/refresh tokens and authorization codes. Returns
   *  the total row count swept. */
  async sweepExpiredTokens(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const tokens = await this.rows(
      `DELETE FROM oauth_tokens WHERE expires_at < $1 RETURNING 1`,
      [now],
    );
    const codes = await this.rows(
      `DELETE FROM oauth_codes WHERE expires_at < $1 RETURNING 1`,
      [now],
    );
    // A spent refresh token past its own expiry would be refused as unknown
    // anyway; its tombstone has nothing left to detect.
    const consumed = await this.rows(
      `DELETE FROM oauth_refresh_consumed WHERE expires_at < $1 RETURNING 1`,
      [now],
    );
    return tokens.length + codes.length + consumed.length;
  }

  // -------------------------------------------------------------------------
  // Internal: issue access + optional refresh tokens
  // -------------------------------------------------------------------------

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: URL | undefined,
    includeRefresh: boolean,
    opts: IssueOptions = {},
  ): Promise<OAuthTokens> {
    const db = opts.db ?? this.engine;
    const grant = opts.grant;
    // Access and refresh tokens of one authorization share a family, so reuse
    // of a spent refresh token can revoke everything the chain issued. A
    // client_credentials token has no refresh, and no family.
    const familyId = includeRefresh ? (opts.familyId ?? randomUUID()) : null;
    const accessToken = generateToken("memrain_at_");
    const accessHash = hashToken(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const effectiveTtl = opts.accessTtl || this.tokenTtl;
    const accessExpiry = now + effectiveTtl;

    await db.query(
      `INSERT INTO oauth_tokens
         (token_hash, token_type, client_id, scopes, expires_at, resource,
          source_id, federated_read, grant_bound, grant_id, family_id)
       VALUES ($1, 'access', $2, $3::text[], $4, $5, $6, $7::text[], $8, $9, $10)`,
      [
        accessHash,
        clientId,
        scopes,
        accessExpiry,
        resource?.toString() ?? null,
        grant?.sourceId ?? null,
        grant?.federatedRead ?? null,
        grant !== undefined,
        grant?.grantId ?? null,
        familyId,
      ],
    );

    const result: OAuthTokens = {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: effectiveTtl,
      scope: scopes.join(" "),
    };

    if (includeRefresh) {
      const refreshToken = generateToken("memrain_rt_");
      const refreshHash = hashToken(refreshToken);
      const refreshExpiry = now + (opts.refreshTtl || this.refreshTtl);

      // The refresh row carries the grant too: rotation reads it back, so a
      // refreshed session stays pinned to the source the operator approved.
      await db.query(
        `INSERT INTO oauth_tokens
           (token_hash, token_type, client_id, scopes, expires_at, resource,
            source_id, federated_read, grant_bound, grant_id, family_id)
         VALUES ($1, 'refresh', $2, $3::text[], $4, $5, $6, $7::text[], $8, $9, $10)`,
        [
          refreshHash,
          clientId,
          scopes,
          refreshExpiry,
          resource?.toString() ?? null,
          grant?.sourceId ?? null,
          grant?.federatedRead ?? null,
          grant !== undefined,
          grant?.grantId ?? null,
          familyId,
        ],
      );

      result.refresh_token = refreshToken;
    }

    return result;
  }
}
