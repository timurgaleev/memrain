/**
 * Public-ingress body redaction — the SINGLE source of truth shared by
 * both ingress paths (REST routes in `http/` and the MCP JSON-RPC
 * dispatcher in `mcp/`). It lives in `core/` so neither ingress layer
 * imports the other: importing an `http/` route into `mcp/dispatch.ts`
 * created a module cycle that left exports undefined at init.
 *
 * Policy: on public ingress (Cloudflare `Cf-Connecting-Ip`) read tools
 * return only an allowlist of metadata fields — never note bodies —
 * unless the operator opts in with `MEMRAIN_PUBLIC_READ_BODIES=1`.
 * Allowlists are fail-safe: a new body-ish field is stripped by default.
 */
import { randomBytes } from "node:crypto";
import { redactConnectionInfo } from "./url-redact.ts";

/** True when the operator opted into returning full bodies publicly. */
export function publicReadBodiesAllowed(): boolean {
  const v = (process.env["MEMRAIN_PUBLIC_READ_BODIES"] ?? "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

/** Generic text returned across the public boundary in place of a raw
 *  exception message. */
export const PUBLIC_ERROR_MESSAGE = "internal error";

// Ceiling on the raw detail kept in the operator log line. A Postgres error
// puts its diagnosis in the first sentence and can then append an entire
// offending row in DETAIL/CONTEXT; the cap bounds how much note-derived data a
// single failure drags into the log without costing the operator the signal.
const MAX_LOGGED_DETAIL_CHARS = 500;

/**
 * Fold an error detail into something safe to write as ONE operator log line.
 *
 * The detail is a single `.message` the caller can influence, so a crafted
 * error carrying CRLF would otherwise terminate the line and let the attacker
 * forge a second, fully attacker-authored one. C0/C1 and the Unicode line
 * separators collapse to spaces (not deleted — deleting would silently splice
 * two unrelated tokens into one plausible-looking word).
 *
 * What is deliberately NOT stripped is the detail itself. A Postgres message
 * can embed a column VALUE, i.e. user data — but this line is the operator's
 * only diagnostic for a failure whose caller got nothing back but "internal
 * error", and the same data is already readable by anyone with host access.
 * That trade holds only while the logs stay on the box. Ship them to
 * CloudWatch or any other aggregator and the value half stops being free:
 * that change has to come with real value redaction here first.
 */
function logSafeDetail(detail: string): string {
  // eslint-disable-next-line no-control-regex
  const oneLine = detail.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ");
  // Scrub any DSN / credential / IP before it reaches the operator log —
  // a postgres-js connection error can carry the password-bearing DSN.
  const scrubbed = redactConnectionInfo(oneLine);
  return scrubbed.length > MAX_LOGGED_DETAIL_CHARS
    ? `${scrubbed.slice(0, MAX_LOGGED_DETAIL_CHARS)}…[truncated]`
    : scrubbed;
}

/**
 * Sanitize an error for a response that may cross the public boundary.
 * A raw exception message can leak Postgres schema/column names, the DSN
 * host, or stack internals — none of which a public-bearer (or the
 * unauthenticated `/health`) caller should see. On public ingress we log
 * the real detail server-side for the operator and return a generic
 * string carrying an incident id that the log line also carries; the
 * internal path keeps the detail so debugging is unaffected.
 */
export function publicSafeErrorMessage(e: unknown, isPublic: boolean): string {
  const detail = e instanceof Error ? e.message : String(e);
  if (isPublic) {
    // A random id, not a counter or a hash of the detail: it must tell the
    // caller nothing, yet let the operator find this line from their report.
    const incident = randomBytes(8).toString("hex");
    console.error(
      `[memrain] suppressed error on public ingress (incident ${incident}):`,
      logSafeDetail(detail),
    );
    return `${PUBLIC_ERROR_MESSAGE} (incident ${incident})`;
  }
  return detail;
}

// Search-hit fields safe to return on public ingress. `evidence` /
// `create_safety` are constrained enum labels (the match-strength signal +
// don't-duplicate hint), NOT note content — safe to surface so the agent can
// read the same retrieval contract on public + internal ingress.
const PUBLIC_SAFE_FIELDS = new Set([
  "title",
  "sourcePath",
  "score",
  "documentId",
  "chunkId",
  "kind",
  "rank",
  "evidence",
  "create_safety",
]);

// Graph-edge fields safe to return on public ingress. The slugs and the
// constrained edge `type` enum stay public (consistent with the rest of the
// read surface, where slugs/paths are already returned); the provenance
// (`source_chunk_id`, `written_at`), the raw confidence signal, and the
// internal row `id` are dropped so a public-bearer caller cannot pull the
// full relationship-provenance bundle. `direction` (graph_neighbors) is a
// traversal hint, not sensitive.
const PUBLIC_SAFE_GRAPH_FIELDS = new Set([
  "source_slug",
  "target_slug",
  "type",
  "direction",
]);

/** Strip every graph-edge field not in the public allowlist. */
export function redactGraphLinks<T extends Record<string, unknown>>(
  links: readonly T[],
): T[] {
  return links.map((l) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(l)) {
      if (PUBLIC_SAFE_GRAPH_FIELDS.has(k)) out[k] = l[k];
    }
    return out as T;
  });
}

/** Strip every search-hit field not in the public allowlist. */
export function redactBodies<T extends Record<string, unknown>>(
  hits: readonly T[],
): T[] {
  return hits.map((h) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(h)) {
      if (PUBLIC_SAFE_FIELDS.has(k)) out[k] = h[k];
    }
    return out as T;
  });
}

// Page/version row fields safe to return on public ingress.
const PUBLIC_SAFE_PAGE_FIELDS = new Set([
  "slug",
  "type",
  "title",
  "compiled_truth",
  "content_hash",
  "created_at",
  "updated_at",
]);

/** Strip every page/version-row field not in the public allowlist. */
export function redactBody<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    if (PUBLIC_SAFE_PAGE_FIELDS.has(k)) out[k] = row[k];
  }
  return out as T;
}

// Entity-fact row fields safe to return on public ingress. The free-text
// `fact` is note-derived private content — body-equivalent — and is omitted.
//
// `written_by` is deliberately NOT here. It is provenance about who writes into
// this brain, and since every unattributed write is now credited to the caller
// (`client:<id>`, where a PAT's id is its human-readable name), returning it
// would hand an anonymous reader a roster of the brain's writers. A public
// reader that cannot see the fact text has no use for its author.
const PUBLIC_SAFE_FACT_FIELDS = new Set([
  "id",
  "entity_slug",
  "confidence",
  "source_slug",
  "source_chunk_id",
  "written_at",
]);

/** Strip the `fact` text (and any non-allowlisted field) from fact rows. */
export function redactFacts<T extends Record<string, unknown>>(
  rows: readonly T[],
): T[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(r)) {
      if (PUBLIC_SAFE_FACT_FIELDS.has(k)) out[k] = r[k];
    }
    return out as T;
  });
}

// Timeline-event row fields safe to return on public ingress. The free-text
// `event` is note-derived private content — body-equivalent — and is omitted.
const PUBLIC_SAFE_TIMELINE_FIELDS = new Set([
  "id",
  "slug",
  "occurred_at",
  "source_chunk_id",
  "written_at",
]);

/** Strip the `event` text (and any non-allowlisted field) from event rows. */
export function redactTimeline<T extends Record<string, unknown>>(
  rows: readonly T[],
): T[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(r)) {
      if (PUBLIC_SAFE_TIMELINE_FIELDS.has(k)) out[k] = r[k];
    }
    return out as T;
  });
}

// Backlink-hit fields safe to return on public ingress. `surfaceForm` is the
// raw note-authored wikilink display text (e.g. `[[people/jane|Jane's lawyer]]`
// → `Jane's lawyer`) — note-derived private content, body-equivalent, omitted.
// `sourcePath`/`title`/`documentId` already surface via the search/page
// allowlists, so they stay consistent with the existing public policy.
const PUBLIC_SAFE_BACKLINK_FIELDS = new Set([
  "documentId",
  "sourcePath",
  "title",
  "mentionCount",
]);

/** Strip `surfaceForm` (and any non-allowlisted field) from backlink hits. */
export function redactBacklinks<T extends Record<string, unknown>>(
  hits: readonly T[],
): T[] {
  return hits.map((h) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(h)) {
      if (PUBLIC_SAFE_BACKLINK_FIELDS.has(k)) out[k] = h[k];
    }
    return out as T;
  });
}

// Job-row fields safe to return on public ingress. The job operational
// status is non-sensitive, but `payload` (arbitrary caller JSON), `result`
// (handler output), `last_error` (raw error text — can embed vault paths /
// note snippets) and `idempotency_key` (caller-derived, often a path) are
// note-derived/free-text and are omitted. Covers JobSummary (jobs_list),
// JobDetail (jobs_get) and the curated jobs_logs object via one allowlist;
// `children_count` is kept for the jobs_logs shape. Fail-safe: a new
// free-text field is dropped by default.
const PUBLIC_SAFE_JOB_FIELDS = new Set([
  "id",
  "kind",
  "status",
  "priority",
  "retry_count",
  "parent_job_id",
  "depth",
  "created_at",
  "updated_at",
  "next_attempt_at",
  "started_at",
  "finished_at",
  "inbox_unread",
  "children_count",
]);

/** Strip free-text/arbitrary fields from a single job row. */
export function redactJob<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    if (PUBLIC_SAFE_JOB_FIELDS.has(k)) out[k] = row[k];
  }
  return out as T;
}
