/**
 * Which tools a caller may call — the one predicate behind both `tools/list`
 * and `tools/call`.
 *
 * A tool is refused to a caller at one of two layers:
 *
 *   ingress   the HTTP transport's walls: the public-ingress denylist and the
 *             internal-token wall for an anonymous bridge caller;
 *   dispatch  the per-credential gates: a missing write source (fail-closed),
 *             operator-only tools, the per-op OAuth scope, and the slug-bound
 *             client's deny-by-default for write tools that name no slug.
 *
 * Both layers ask this module, and `tools/list` advertises exactly the tools
 * for which it finds no refusal. Listing and calling therefore cannot drift:
 * a listed tool is never turned away for scope or permission, and a hidden
 * tool is one the caller could not have called. Refusals that depend on the
 * ARGUMENTS (a slug outside the bound prefixes, `extract_facts persist`) are
 * not tool-level and stay in dispatch.
 */
import {
  effectiveWriteSourceIdForIngress,
  isNoSourceSentinel,
  tenantFailClosedEnabled,
  type AuthInfo,
} from "../core/auth-info.ts";
import { hasScope } from "../core/scope.ts";
import { OPERATIONS, WRITE_SCOPED_TOOLS } from "./operations.ts";
import { TOOL_DEFS, type ToolDef } from "./tool_defs.ts";

const OP_BY_NAME = new Map(OPERATIONS.map((o) => [o.name, o]));

/**
 * Operator-only operational tools. These expose brain-wide state that has no
 * per-source axis — the job queue (jobs_* return another tenant's job
 * payload/result/logs: vault paths, note snippets) and the advisor/stats
 * dashboards (migrations, embed coverage, whole-brain counts, internal-auth
 * config). They are refused for any authenticated tenant principal
 * (`authInfo !== undefined`), i.e. an OAuth `memrain_at_` caller. The static
 * daily bearer and the trusted-local/internal path (both `authInfo === undefined`)
 * keep full access — they are the operator. `source_health` is deliberately NOT
 * here: it is the per-source (tenant-safe) health view.
 */
export const OPERATOR_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "stats",
  "advisor",
  "jobs_submit",
  "jobs_list",
  "jobs_get",
  "jobs_cancel",
  "jobs_logs",
  // list_concepts reads synth_concepts, which has no source axis — its narratives
  // are clustered across EVERY tenant's atoms. An OAuth tenant token is trusted
  // (isPublic:false) so the public denylist doesn't cover it; gate it operator-only
  // so one tenant can never read concepts derived from another tenant's notes.
  // (Proper per-tenant concepts would need a source_id column on synth_concepts.)
  "list_concepts",
  // Job lifecycle mutators/reads share the jobs_* posture: another tenant's
  // job rows carry payload/progress free text.
  "retry_job",
  "get_job_progress",
  // Whole-brain operational snapshots (admin scope).
  "get_status_snapshot",
  "run_doctor",
  // purge_deleted_pages is NOT operator-only: it is gated at the
  // `admin` scope (the per-op scope gate enforces it), reachable by an
  // admin-scoped token. The static bearer + internal
  // path are never gated here anyway.
  // chronicle_backfill sweeps EVERY conversation-shape page in scope and spends
  // (queued) chronicle-extract work — an operator maintenance action, not a
  // tenant-reachable one.
  "chronicle_backfill",
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
  page_delete: ["slug"],
  page_restore: ["slug"],
  page_revert: ["slug"],
  add_tag: ["slug"],
  remove_tag: ["slug"],
  add_timeline_event: ["slug"],
  put_raw_data: ["slug"],
  link: ["source_slug", "target_slug"],
  unlink: ["source_slug", "target_slug"],
  add_fact: ["entity_slug"],
  ontology_propose: ["entity"],
};

export type ToolRefusal =
  | { kind: "public_ingress" }
  | { kind: "internal_token" }
  | { kind: "no_write_source" }
  | { kind: "operator_only" }
  | { kind: "insufficient_scope"; requiredScope: string }
  | { kind: "slug_bound" };

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
  return null;
}

/** Every tool-level refusal a caller meets, ingress first, as a call would. */
export function toolRefusal(
  name: string,
  ctx: CallerContext,
  forbidPublic: (name: string) => boolean,
): ToolRefusal | null {
  return ingressRefusal(name, ctx, forbidPublic) ?? dispatchRefusal(name, ctx.authInfo);
}

/** The `tools/list` answer for this caller: every tool it can actually call. */
export function visibleToolDefs(
  ctx: CallerContext,
  forbidPublic: (name: string) => boolean,
): ToolDef[] {
  return TOOL_DEFS.filter((t) => toolRefusal(t.name, ctx, forbidPublic) === null);
}
