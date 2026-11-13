/**
 * Per-request auth identity + source-scope resolution for the MCP/REST ingress.
 *
 * memrain composes this with the existing public-redaction model in
 * `mcp/dispatch.ts`: that layer already carries a single trust bit
 * (`DispatchOptions.isPublic`) which decides whether note bodies are redacted.
 * `AuthInfo` is the richer identity that the transport resolves at
 * token-verification time and threads alongside that bit. `isPublic` stays the
 * authoritative trust flag — it lives ON `AuthInfo` so identity and trust travel
 * together, and the dispatcher reads `auth.isPublic` exactly where it reads
 * `opts.isPublic` today.
 *
 * The source-scope helpers (`sourceScopeOpts` / `resolveRequestedScope`) are the
 * tenancy primitives: a single resolver every read-op routes through so a remote
 * caller can never opt out of its grant by passing `all_sources` or an
 * out-of-grant `source_id`. They are adapted to take `AuthInfo` directly rather
 * than a heavyweight operation context — memrain's dispatch layer is lean and has
 * no per-op `OperationContext`, so the trust input is the explicit `isPublic`
 * flag the transport already owns.
 */

import { OperationError } from "./operation-error.ts";
import { LEGACY_NO_SOURCE_SENTINEL } from "./brand.ts";

/**
 * Which credential a principal presented, by a reference that is not a bearer:
 * a queued job stores it and re-reads the live grant before it writes. A PAT is
 * its `access_tokens.id`; an OAuth session is its refresh family, which
 * survives rotation and dies with the family; a token minted without a family
 * (client credentials, or one issued before families) is its own row, keyed by
 * the stored hash. The client id rides along only to narrow the lookup: it
 * never selects a credential on its own.
 */
export type PrincipalRef =
  | { kind: "pat"; id: string }
  | { kind: "oauth_family"; id: string; client_id: string }
  | { kind: "oauth_token"; id: string; client_id: string };

/** The principal a queued job names, or null when it is absent or malformed. */
export function parsePrincipalRef(raw: unknown): PrincipalRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "pat") return typeof r.id === "string" && /^\d{1,19}$/.test(r.id) ? { kind: "pat", id: r.id } : null;
  if (r.kind !== "oauth_family" && r.kind !== "oauth_token") return null;
  if (typeof r.id !== "string" || r.id.length === 0 || r.id.length > 200) return null;
  if (typeof r.client_id !== "string" || r.client_id.length === 0) return null;
  return { kind: r.kind, id: r.id, client_id: r.client_id };
}

export interface AuthInfo {
  /** The raw bearer/OAuth token presented by the caller. */
  token: string;
  /** Stable client identifier (OAuth client_id, or a bearer-token name). */
  clientId: string;
  /** Granted OAuth scopes (validate with `hasScope` from `core/scope.ts`). */
  scopes: string[];
  /**
   * The source this client may WRITE to (write authority). Undefined for legacy
   * tokens that predate source-scoping; engines fall back to unscoped behavior.
   */
  sourceId?: string;
  /**
   * Source ids this client may READ from (federation). Independent of
   * `sourceId`: a client can write to one source while reading a union.
   *
   * Empty `[]` means "no federated read scope beyond `sourceId`" — it MUST NOT
   * be read as "all sources". Undefined means "not populated" (back-compat:
   * fall back to the scalar `sourceId`).
   */
  allowedSources?: string[];
  /**
   * Slug-prefix write fence (`oauth_clients.bound_slug_prefixes`): when
   * non-empty, dispatch confines this principal's write ops to slugs under
   * one of these prefixes and refuses write ops that name no slug
   * (deny-by-default). Undefined/empty = unbounded (the default).
   */
  boundSlugPrefixes?: readonly string[];
  /**
   * True when the caller arrived over the public ingress (`brain.<domain>/mcp`
   * via Cloudflare). This is the authoritative trust bit — it gates body
   * redaction in the dispatcher and fail-closes the scope resolvers below.
   * False for the internal-token ingress and local CLI callers.
   */
  isPublic: boolean;
  /**
   * Takes-holder allow-list from the token's `permissions.takes_holders`
   * (mig 072). When present, the takes read paths only surface takes whose
   * `holder` is in the list. Undefined = no knob on the credential → holder
   * reads stay unscoped (the operator path and OAuth clients, which carry no
   * takes_holders grant).
   */
  takesHolders?: string[];
  /**
   * The principal's daily spend cap in USD, read with the token: the OAuth
   * client's or the PAT's `budget_usd_per_day`. null = verified uncapped;
   * undefined = not resolved, so the spend chokepoint looks it up.
   */
  budgetUsdPerDay?: number | null;
  /**
   * Who this principal spends as, when not `clientId`: an enrollment id, so
   * the people on one shared connector each have their own daily budget.
   */
  spendId?: string;
  /** The credential behind this principal; absent for callers no token resolved. */
  principal?: PrincipalRef;
}

/**
 * The effective READ sources for a caller: the federated `allowedSources` union
 * when populated, else the scalar `sourceId`, else `undefined` (unscoped — local
 * callers and pre-scoping tokens keep their existing whole-brain view).
 *
 * An empty `allowedSources: []` is treated as "no federated scope" and defers to
 * the scalar `sourceId`; it never widens to "all sources".
 */
export function effectiveReadSourceIds(
  auth: AuthInfo | undefined,
): string[] | undefined {
  const allowed = auth?.allowedSources;
  if (allowed && allowed.length > 0) return allowed;
  if (auth?.sourceId) return [auth.sourceId];
  return undefined;
}

/**
 * Reserved source id that matches NO real source. The write path returns it for
 * an authenticated caller with no write grant so the dispatcher can refuse the
 * write. Reads use `[]` for the same caller; read helpers still treat a
 * sentinel-only list as "no grant" (see core/source-scope.ts).
 */
export const NO_SOURCE_SENTINEL = "__memrain_no_source__";

/**
 * True for either spelling of the reserved id. Test with this, never with
 * `=== NO_SOURCE_SENTINEL`: a server on the other side of the rename (a
 * whoami read by remote-doctor, a stored grant) carries the other spelling,
 * and missing it would treat "no grant" as a grant.
 */
export function isNoSourceSentinel(id: unknown): boolean {
  return id === NO_SOURCE_SENTINEL || id === LEGACY_NO_SOURCE_SENTINEL;
}

/**
 * Is the fail-closed multi-tenant read policy enabled? Default OFF — only an
 * explicit `MEMRAIN_TENANT_FAIL_CLOSED=1` (or `=true`) opts in. Off, the ingress
 * resolver is byte-for-byte {@link effectiveReadSourceIds}, so the daily
 * static-bearer path is untouched.
 */
export function tenantFailClosedEnabled(): boolean {
  const v = process.env["MEMRAIN_TENANT_FAIL_CLOSED"];
  return v === "1" || v === "true";
}

/**
 * Ingress-side read scope with an OPTIONAL fail-closed floor.
 *
 * Resolves the base scope via {@link effectiveReadSourceIds}. When the caller
 * holds a grant it is honored verbatim. When they hold none (`base === undefined`)
 * the policy branches on whether the caller is an AUTHENTICATED principal:
 *
 *   - `failClosed` on AND `auth` present (`auth !== undefined`)
 *       → `[]` (reads NOTHING — an authenticated caller with no
 *         source grant must not fall through to the redacted whole-brain). This
 *         covers an OAuth tenant (`isPublic === false`) as well as an authenticated
 *         public caller — a scopeless registered client is NOT whole-brain-trusted.
 *   - otherwise → `undefined` (UNCHANGED whole-brain): this is the static public
 *       bearer and the trusted-local path, both of which present `auth === undefined`.
 *       The discriminator is `auth === undefined`, so the daily Claude Code
 *       static-bearer path is never scoped.
 */
export function effectiveReadSourceIdsForIngress(
  auth: AuthInfo | undefined,
  opts?: { failClosed?: boolean },
): string[] | undefined {
  const base = effectiveReadSourceIds(auth);
  if (base !== undefined) return base;
  if (opts?.failClosed === true && auth !== undefined) {
    return [];
  }
  return undefined;
}

/**
 * The caller's effective takes-holder allow-list, or `undefined` when holder
 * reads are unscoped (no authInfo = operator/trusted-local, or an explicit
 * `*` wildcard entry — the operator's "all holders" escape hatch).
 *
 * Fail-safe: a REMOTE authenticated principal whose credential carries no
 * holder knob is floored to ['world'] — any remote token without the
 * allow-list is defaulted the same way. Only the operator path is unscoped
 * by absence.
 */
export function effectiveTakesHolders(
  auth: AuthInfo | undefined,
): string[] | undefined {
  const remoteFloor = auth === undefined ? undefined : ["world"];
  const list = auth?.takesHolders;
  if (!Array.isArray(list) || list.length === 0) return remoteFloor;
  const cleaned = list.filter((s) => typeof s === "string" && s.length > 0);
  if (cleaned.length === 0) return remoteFloor;
  if (cleaned.includes("*")) return undefined;
  return Array.from(new Set(cleaned));
}

/** The source a caller is authorized to WRITE to, or `undefined` if unscoped. */
export function effectiveWriteSourceId(
  auth: AuthInfo | undefined,
): string | undefined {
  return auth?.sourceId;
}

/**
 * Ingress-side WRITE scope with an OPTIONAL fail-closed floor — the write-path
 * mirror of {@link effectiveReadSourceIdsForIngress}.
 *
 * Resolves the base write source via {@link effectiveWriteSourceId}. When the
 * caller holds a write grant it is returned verbatim. When they hold none
 * (`base === undefined`) the policy branches on whether the caller is an
 * AUTHENTICATED principal:
 *
 *   - `failClosed` on AND `auth` present (`auth !== undefined`)
 *       → `NO_SOURCE_SENTINEL` — the dispatcher MUST reject the write with
 *         permission_denied rather than let it default to the 'default' tenant
 *         (an orphaned/no-write-source OAuth principal must not write anywhere).
 *   - otherwise → `undefined` (UNCHANGED unscoped write): the static public
 *       bearer and the trusted-local path, both of which present `auth === undefined`.
 *       Same discriminator as the read helper, so the daily static-bearer path is
 *       never scoped.
 */
export function effectiveWriteSourceIdForIngress(
  auth: AuthInfo | undefined,
  opts?: { failClosed?: boolean },
): string | undefined {
  const base = effectiveWriteSourceId(auth);
  if (base !== undefined) return base;
  if (opts?.failClosed === true && auth !== undefined) {
    return NO_SOURCE_SENTINEL;
  }
  return undefined;
}

/**
 * Resolve the source-scope filter for a read-side op handler. Returns an opts
 * fragment ready to spread into an engine call.
 *
 * Precedence:
 *  1. `auth.allowedSources` (federated read) → `{ sourceIds: [...] }`.
 *  2. `auth.sourceId` (scalar write authority, used as read floor) →
 *     `{ sourceId: '...' }`.
 *  3. Neither set → `{}` (unscoped — local callers / pre-scoping tokens).
 *
 * Routing every read through one ladder keeps the per-site drift (the bug class
 * that leaks cross-source reads) out of the handlers.
 */
export function sourceScopeOpts(
  auth: AuthInfo | undefined,
): { sourceId?: string; sourceIds?: string[] } {
  const allowed = auth?.allowedSources;
  // An attacker-controlled `[]` MUST NOT widen scope to "all sources" — defer to
  // the scalar `sourceId` below when the federated list is empty.
  if (allowed && allowed.length > 0) return { sourceIds: allowed };
  if (auth?.sourceId) return { sourceId: auth.sourceId };
  return {};
}

/**
 * Resolve a per-call requested source scope against the caller's trust + grant.
 * FAIL-CLOSED: anything not strictly `isPublic === false` is treated as
 * untrusted/remote.
 *
 * The single resolver for every read op that accepts a per-call `source_id` /
 * `all_sources` parameter. Inlining the `__all__` branch per handler is the bug
 * class that leaks cross-source reads: a remote client could pass
 * `source_id: '__all__'` to opt out of its grant, or pass an out-of-grant
 * `source_id` that was never checked.
 *
 *   - `__all__` / `all_sources`:
 *       trusted local (isPublic === false) → `{}` (spans the whole brain)
 *       remote/public                       → the caller's grant (sourceScopeOpts)
 *   - explicit `source_id`:
 *       remote + federated grant that excludes it → permission_denied
 *       otherwise                                 → `{ sourceId }`
 *   - neither → the caller's grant (sourceScopeOpts).
 */
export function resolveRequestedScope(
  auth: AuthInfo | undefined,
  sourceIdParam: string | undefined,
  allSourcesParam = false,
): { sourceId?: string; sourceIds?: string[] } {
  // SECURITY: "trusted" means the static-bearer / trusted-local / internal path,
  // which presents NO authInfo (`auth === undefined`). An OAuth tenant has
  // `isPublic === false` too, so keying on isPublic would let a tenant pose as
  // trusted-local and request any source (IDOR). A tenant is ALWAYS scoped to its
  // grant here.
  const trustedLocal = auth === undefined;
  const wantsAll = allSourcesParam || sourceIdParam === "__all__";
  if (wantsAll) {
    return trustedLocal ? {} : sourceScopeOpts(auth);
  }
  if (sourceIdParam !== undefined) {
    if (!trustedLocal) {
      // Fail-closed: a scoped caller may only name a source inside its grant.
      // An empty/absent grant matches nothing, so a caller with no allowed
      // sources is rejected rather than passed through verbatim.
      const allowed = auth?.allowedSources ?? [];
      const own = auth?.sourceId;
      const permitted =
        allowed.includes(sourceIdParam) || sourceIdParam === own;
      if (!permitted) {
        throw new OperationError(
          "permission_denied",
          `source '${sourceIdParam}' is outside your granted sources`,
          "Request access to this source, or omit source_id to read within your grant.",
        );
      }
    }
    return { sourceId: sourceIdParam };
  }
  return sourceScopeOpts(auth);
}
