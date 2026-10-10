/**
 * Quarantine — a frontmatter marker (no DB column) that hides a document from
 * search without deleting it. Two-tier model:
 *
 *   * `quarantine`   — HIDE: high-confidence junk; excluded from search.
 *   * `content_flag` — WARN: stays searchable; surfaced to the reader, no SQL
 *                      filter. (Marker only; consumers may render a warning.)
 *
 * Quarantine lives in `documents.frontmatter` (JSONB), so it needs no schema
 * change — the `? 'quarantine'` key test is the whole mechanism.
 */

import { createHash } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import { logIngest } from "./ingest-log.ts";
import { wellFormForText } from "./well-form.ts";
import {
  describeQuarantineTrip,
  quarantinePatternNames,
  type ContentSanityResult,
} from "./content-sanity.ts";

export const QUARANTINE_KEY = "quarantine";

/** `ingest_log.source_type` of a content-sanity trip. */
export const QUARANTINE_AUDIT_SOURCE_TYPE = "quarantine";
export const CONTENT_FLAG_KEY = "content_flag";

/**
 * An operator's decision that a held document is not junk, written by
 * `memrain quarantine clear`. The gate re-derives `quarantine` on every index,
 * so deleting the marker alone never survives the next write of the same
 * content. The override is bound to the gate's inputs (title and body): while
 * they are unchanged the gate keeps its classifier verdict (junk patterns,
 * operator literals, markup ratio) off the document; any change expires it.
 * The size gate (oversize `embed_skip`) is never overridden.
 */
export const QUARANTINE_OVERRIDE_KEY = "quarantine_override";

/**
 * Frontmatter keys only the gate and trusted local paths may set. An untrusted
 * write has them stripped before the gate runs. `embed_skip` is spelled out
 * rather than imported: embed-skip.ts imports this module.
 */
export const GATE_OWNED_KEYS: readonly string[] = Object.freeze([
  QUARANTINE_KEY,
  CONTENT_FLAG_KEY,
  "embed_skip",
  QUARANTINE_OVERRIDE_KEY,
]);

export interface QuarantineOverride {
  binding: string;
  cleared_at: string;
}

export interface QuarantineVerdict {
  reason: string;
  detail: string;
}

/** The document content an override is bound to: the gate's own inputs. */
export interface OverrideBound {
  title: string | null | undefined;
  /** The prose chunks joined with a blank line, exactly what the gate assessed. */
  body: string;
  frontmatter?: Record<string, unknown> | null;
}

/**
 * Hash binding an override to a document's title and body. Both are
 * well-formed first so the value computed at index time matches the one
 * recomputed from the stored (already well-formed) rows.
 */
export function quarantineOverrideBinding(title: string | null | undefined, body: string): string {
  const payload = JSON.stringify([
    "quarantine_override/v1",
    wellFormForText(title ?? ""),
    wellFormForText(body),
  ]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** The override stored in `value`, or null when it is not a well-formed one. */
export function parseQuarantineOverride(value: unknown): QuarantineOverride | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { binding, cleared_at } = value as Record<string, unknown>;
  return typeof binding === "string" && /^[0-9a-f]{64}$/.test(binding) && typeof cleared_at === "string"
    ? { binding, cleared_at }
    : null;
}

/** Whether `page` carries an override bound to its current title and body. */
export function hasCurrentQuarantineOverride(page: OverrideBound): boolean {
  const override = parseQuarantineOverride(page.frontmatter?.[QUARANTINE_OVERRIDE_KEY]);
  return !!override && override.binding === quarantineOverrideBinding(page.title, page.body);
}

/**
 * The gate verdict with the classifier outcomes (hide, markup flag) removed
 * for a document carrying a current override. Size outcomes stay: an oversize
 * body is still embed-skipped and flagged.
 */
export function withQuarantineOverride(
  result: ContentSanityResult,
  page: OverrideBound,
): ContentSanityResult {
  if (!hasCurrentQuarantineOverride(page)) return result;
  const classifier = new Set(["junk_pattern", "literal_substring", "high_markup"]);
  const kept = result.reasons
    .map((reason, i) => [reason, result.reason_messages[i]] as const)
    .filter(([reason]) => !classifier.has(reason));
  return {
    ...result,
    junk_pattern_matches: [],
    literal_substring_matches: [],
    reasons: kept.map(([reason]) => reason),
    reason_messages: kept.map(([, message]) => message).filter((m): m is string => !!m),
    shouldQuarantine: false,
    shouldSkipEmbed: result.oversize,
    shouldFlag: result.oversize,
    flag_reason: result.oversize ? "oversized" : null,
  };
}

/** The `quarantine` marker of a frontmatter object as a verdict, or null. */
export function quarantineVerdictOf(
  frontmatter: Record<string, unknown> | null | undefined,
): QuarantineVerdict | null {
  if (!isQuarantined(frontmatter)) return null;
  const marker = frontmatter![QUARANTINE_KEY];
  const m = marker && typeof marker === "object" ? (marker as Record<string, unknown>) : {};
  return {
    reason: typeof m["reason"] === "string" ? m["reason"] : "unknown",
    detail: typeof m["detail"] === "string" ? m["detail"] : "",
  };
}

/**
 * The quarantine verdict on a page's search mirror, or null when the page is
 * not held or has no mirror. `ownerSourceId` is the page's owning source; the
 * path is built as `pageSourcePath` (page-index.ts) builds it, which is not
 * imported because page-index.ts reaches this module through the indexer.
 */
export async function readQuarantineVerdict(
  engine: Engine,
  slug: string,
  ownerSourceId: string | null | undefined,
): Promise<QuarantineVerdict | null> {
  const path =
    ownerSourceId && ownerSourceId !== "default" ? `page://${ownerSourceId}/${slug}` : `page://${slug}`;
  const r = await engine.query<{ frontmatter: Record<string, unknown> | null }>(
    `SELECT frontmatter FROM documents WHERE source_path = $1 LIMIT 1`,
    [path],
  );
  return quarantineVerdictOf(r.rows[0]?.frontmatter);
}

/**
 * Guard against SQL injection via a table alias. Aliases that feed string
 * interpolation must be plain SQL identifiers — never caller/user input. All
 * current callers pass a literal ('d'); this is defense-in-depth for any future
 * caller that forgets that contract.
 */
export function assertSqlAlias(alias: string): void {
  if (!/^[a-z_]\w*$/i.test(alias)) {
    throw new Error(`unsafe SQL alias: ${JSON.stringify(alias)}`);
  }
}

/** True when a frontmatter object carries the hide-from-search marker. */
export function isQuarantined(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  return !!frontmatter && Object.hasOwn(frontmatter, QUARANTINE_KEY);
}

/** True when a frontmatter object carries the warn-but-show marker. */
export function isContentFlagged(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  return !!frontmatter && Object.hasOwn(frontmatter, CONTENT_FLAG_KEY);
}

/**
 * SQL fragment (a boolean expression, NO leading `AND`) that is true for
 * NON-quarantined documents. `docAlias` is the `documents` row alias in scope.
 * COALESCE guards a NULL frontmatter (treated as not-quarantined).
 */
export function quarantineFilterFragment(docAlias = "d"): string {
  assertSqlAlias(docAlias);
  return `NOT (COALESCE(${docAlias}.frontmatter, '{}'::jsonb) ? '${QUARANTINE_KEY}')`;
}

/**
 * True when `result` quarantines a page whose stored frontmatter did not
 * already carry the same verdict. Re-indexing a held page (a page mirror, a
 * rechunk sweep, a reindex) re-runs the gate and trips again; only a page
 * newly held, or held on a different set of patterns, is a new trip.
 */
export function isNewQuarantineVerdict(
  prior: Record<string, unknown> | null | undefined,
  result: ContentSanityResult,
): boolean {
  if (!result.shouldQuarantine) return false;
  if (!isQuarantined(prior)) return true;
  const marker = prior![QUARANTINE_KEY];
  const priorDetail =
    marker && typeof marker === "object" ? (marker as Record<string, unknown>)["detail"] : undefined;
  return priorDetail !== quarantinePatternNames(result).join(", ");
}

/**
 * One `ingest_log` row per quarantine trip, so a false positive that hides a
 * page leaves a trail naming the pattern that fired. The summary carries the
 * pattern names only, never the matched text: an operator literal can be a
 * string the operator does not want echoed back. Best-effort: the trail must
 * never fail the write it describes.
 */
export async function auditQuarantine(
  engine: Engine,
  result: ContentSanityResult,
  ref: string,
  sourceId: string | null,
): Promise<void> {
  if (!result.shouldQuarantine) return;
  try {
    await logIngest(engine, {
      source_type: QUARANTINE_AUDIT_SOURCE_TYPE,
      source_ref: ref,
      summary: describeQuarantineTrip(result),
      ...(sourceId ? { source_id: sourceId } : {}),
    });
  } catch (e) {
    console.warn(
      `[quarantine] failed to audit the trip for ${ref}: ` +
        (e instanceof Error ? e.message : String(e)),
    );
  }
}
