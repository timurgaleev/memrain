/**
 * Which tools a caller may call — the one predicate behind both `tools/list`
 * and `tools/call`.
 *
 * A tool is refused to a caller at one of two layers:
 *
 *   ingress   the HTTP transport's walls: the public-ingress denylist and the
 *             internal-token wall for an anonymous bridge caller;
 *   dispatch  the per-credential gates: a missing write source (fail-closed),
 *             operator-only tools, the per-op OAuth scope, the slug-bound
 *             client's deny-by-default for write tools that name no slug, a
 *             credential carrying a read floor (refused outright) and a
 *             narrowed tool surface (mcp/surface.ts).
 *
 * Both layers ask this module, and `tools/list` advertises exactly the tools
 * for which it finds no refusal. Listing and calling therefore cannot drift:
 * a listed tool is never turned away for scope or permission, and a hidden
 * tool is one the caller could not have called. Refusals that depend on the
 * ARGUMENTS (a slug outside the bound prefixes) are not tool-level and stay
 * in dispatch.
 */
import {
  effectiveWriteSourceIdForIngress,
  isNoSourceSentinel,
  tenantFailClosedEnabled,
  type AuthInfo,
} from "../core/auth-info.ts";
import { hasScope } from "../core/scope.ts";
import { OPERATIONS, WRITE_SCOPED_TOOLS } from "./operations.ts";
import { readForceSurfaceEnv, toolOnSurface } from "./surface.ts";
import { TOOL_DEFS, type ToolDef } from "./tool_defs.ts";

const OP_BY_NAME = new Map(OPERATIONS.map((o) => [o.name, o]));

/**
 * Operator-only tools. They expose brain-wide state that has no per-source
 * axis (whole-brain counts, migrations, embed coverage, lock and OAuth client
 * health), so any authenticated principal (`authInfo !== undefined`) is
 * refused them. The static bearer and the trusted-local path (both
 * `authInfo === undefined`) are the operator and keep them. Per-source health
 * stays reachable through `sources_status`.
 */
export const OPERATOR_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "stats",
  "run_doctor",
]);

/**
 * Which params of a write op name the slugs it MUTATES — the surface the
 * per-client slug-prefix fence (`oauth_clients.bound_slug_prefixes`) checks.
 * Provenance-only pointers (add_fact's `source_slug`, `source_chunk_id`) are
 * deliberately not listed: the fence bounds what a client can change, not
 * what it can cite. A write/admin op ABSENT from this map names no slug and
 * is refused for bound clients outright (deny-by-default), so a future write
 * tool cannot bypass the fence by omission.
 *
 * DELIBERATELY OUTSIDE the fence: edges/facts the BRAIN derives from an
 * in-prefix page's body (wikilink/mention/typed-link sync, on-write fact
 * extraction). Those are the server's own indexing of ingested content —
 * the background cycle would derive the identical set from the same body —
 * and they never mutate another page's content, only reference it. Fencing
 * them would fork the derivation pipeline per principal for no containment
 * gain.
 */
export const SLUG_PARAMS_BY_WRITE_TOOL: Readonly<Record<string, readonly string[]>> = {
  page_put: ["slug"],
  page_append: ["slug"],
  page_edit: ["slug"],
  page_rename: ["from", "to"],
  page_delete: ["slug"],
  page_restore: ["slug"],
  page_revert: ["slug"],
  add_tag: ["slug"],
  remove_tag: ["slug"],
  link: ["source_slug", "target_slug"],
  unlink: ["source_slug", "target_slug"],
};

export type ToolRefusal =
  | { kind: "public_ingress" }
  | { kind: "internal_token" }
  | { kind: "no_write_source" }
  | { kind: "operator_only" }
  | { kind: "insufficient_scope"; requiredScope: string }
  | { kind: "slug_bound" }
  | { kind: "credential_unsupported" }
  | { kind: "tool_surface"; surface: "starter" | "verbs"; forced?: true };

/** What the transport knows about the caller of one request. */
export interface CallerContext {
  isPublic: boolean;
  /** False only when the internal token is configured and was not sent. */
  internalAuthOk?: boolean;
  authInfo?: AuthInfo;
}

/**
 * The transport's walls. `forbidPublic` is the ingress denylist the server
 * route layer supplies (isPublicMcpToolForbidden in production).
 */
export function ingressRefusal(
  name: string,
  ctx: CallerContext,
  forbidPublic: (name: string) => boolean,
): ToolRefusal | null {
  if (!forbidPublic(name)) return null;
  if (ctx.isPublic) return { kind: "public_ingress" };
  // An authenticated principal is judged on scope in dispatch, not on the
  // internal token — the wall defends against an anonymous bridge sibling.
  if (ctx.internalAuthOk === false && ctx.authInfo === undefined) {
    return { kind: "internal_token" };
  }
  return null;
}

/**
 * The per-credential gates dispatch applies before any handler runs, in the
 * order dispatch reports them. The operator path (`authInfo === undefined`)
 * passes every one.
 */
export function dispatchRefusal(
  name: string,
  authInfo: AuthInfo | undefined,
  failClosed: boolean = tenantFailClosedEnabled(),
): ToolRefusal | null {
  if (authInfo === undefined) return null;
  const writeDenied =
    isNoSourceSentinel(effectiveWriteSourceIdForIngress(authInfo, { failClosed }));
  if (writeDenied && WRITE_SCOPED_TOOLS.has(name)) return { kind: "no_write_source" };
  if (OPERATOR_ONLY_TOOLS.has(name)) return { kind: "operator_only" };
  const scope = OP_BY_NAME.get(name)?.scope;
  const requiredScope = scope ?? "read";
  if (!hasScope(authInfo.scopes ?? [], requiredScope)) {
    return { kind: "insufficient_scope", requiredScope };
  }
  const bound = authInfo.boundSlugPrefixes;
  if (
    bound &&
    bound.length > 0 &&
    (scope === "write" || scope === "admin") &&
    !Object.hasOwn(SLUG_PARAMS_BY_WRITE_TOOL, name)
  ) {
    return { kind: "slug_bound" };
  }
  // Token verification already refuses a credential with a read floor; this
  // keeps any that reaches dispatch from reading past it.
  if (authInfo.minTrust !== undefined) return { kind: "credential_unsupported" };
  const surface = authInfo.toolSurface;
  if (surface !== undefined && !toolOnSurface(name, surface)) return { kind: "tool_surface", surface };
  return null;
}

/**
 * The operator's MEMRAIN_MCP_FORCE_SURFACE, for every /mcp caller alike (the
 * operator bearer and the public bearer included). It only adds a refusal on
 * top of the credential's own surface, so it never widens one. The local CLI
 * and in-process callers do not come through /mcp and are not narrowed.
 */
export function forcedSurfaceRefusal(name: string): ToolRefusal | null {
  const forced = readForceSurfaceEnv();
  return forced !== null && !toolOnSurface(name, forced) ? { kind: "tool_surface", surface: forced, forced: true } : null;
}

/** Every tool-level refusal a /mcp caller meets, ingress first, as a call would. */
export function toolRefusal(
  name: string,
  ctx: CallerContext,
  forbidPublic: (name: string) => boolean,
): ToolRefusal | null {
  return ingressRefusal(name, ctx, forbidPublic) ?? forcedSurfaceRefusal(name) ?? dispatchRefusal(name, ctx.authInfo);
}

/** The `tools/list` answer for this caller: every tool it can actually call. */
export function visibleToolDefs(
  ctx: CallerContext,
  forbidPublic: (name: string) => boolean,
): ToolDef[] {
  return TOOL_DEFS.filter((t) => toolRefusal(t.name, ctx, forbidPublic) === null);
}
