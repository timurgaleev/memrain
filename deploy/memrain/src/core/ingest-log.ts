/**
 * ingest_log substrate (migrations 023 + 087) — the durable ingestion /
 * absorb-failure audit trail.
 *
 * Two consumer classes:
 *   - Recipes / importers log a row per ingestion run (`logIngest`) and the
 *     operator reads them back (`getIngestLog`).
 *   - The facts extraction pipeline logs every ABSORBED failure with a stable
 *     reason code (`writeFactsAbsorbLog`), so a gateway blip or parser break
 *     survives a restart instead of vanishing with the in-memory queue
 *     counters. A doctor facts_extraction_health check can group by reason.
 *
 * The absorb writer is best-effort by contract: a failure to log must never
 * blow up the caller's actual work — errors are caught and stderr-warned.
 */
import { classifyBedrockError } from "./llm/bedrock-errors.ts";
import type { Engine } from "./engine/interface.ts";

export interface IngestLogEntry {
  source_type: string;
  source_ref?: string | null;
  pages_updated?: string[];
  summary?: string | null;
  /** Tenant axis (mig087). Omitted -> the column DEFAULT 'default'. */
  source_id?: string;
}

export interface IngestLogRow {
  id: number;
  source_id: string;
  source_type: string;
  source_ref: string | null;
  pages_updated: string[];
  summary: string | null;
  created_at: string;
}

/** Append one ingestion-event row. */
export async function logIngest(
  engine: Engine,
  entry: IngestLogEntry,
): Promise<{ id: number | null }> {
  if (typeof entry.source_type !== "string" || entry.source_type.length === 0) {
    throw new Error("logIngest: source_type must be a non-empty string");
  }
  const pages = Array.isArray(entry.pages_updated)
    ? entry.pages_updated.filter((p): p is string => typeof p === "string")
    : [];
  const sourceId =
    typeof entry.source_id === "string" && entry.source_id.length > 0
      ? entry.source_id
      : "default";
  const r = await engine.query<{ id: number }>(
    `INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary)
     VALUES ($1, $2, $3, $4::text::jsonb, $5)
     RETURNING id`,
    [
      sourceId,
      entry.source_type,
      entry.source_ref ?? null,
      // JSON text through a ::text::jsonb cast: a bare JS array would be read
      // as a Postgres array, and a string bound to a bare ::jsonb position
      // double-encodes on real Postgres (postgres.js wraps it into a jsonb
      // string scalar). ::text::jsonb parses the text instead.
      JSON.stringify(pages),
      entry.summary ?? null,
    ],
  );
  return { id: r.rows[0]?.id ?? null };
}

export interface GetIngestLogOptions {
  limit?: number;
  /** Filter by source_type ('facts:absorb', an importer name, …). */
  source_type?: string;
  /** Tenant scope (mig087). Omitted -> unscoped; `[]` -> nothing. */
  sourceIds?: string[];
}

/** Recent ingestion-log entries, newest first. */
export async function getIngestLog(
  engine: Engine,
  opts: GetIngestLogOptions = {},
): Promise<IngestLogRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (typeof opts.source_type === "string" && opts.source_type.length > 0) {
    params.push(opts.source_type);
    where.push(`source_type = $${params.length}`);
  }
  if (opts.sourceIds !== undefined) {
    params.push(opts.sourceIds);
    where.push(`source_id = ANY($${params.length}::text[])`);
  }
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 500
      ? Math.floor(opts.limit)
      : 20;
  params.push(limit);
  const r = await engine.query<IngestLogRow>(
    `SELECT id, source_id, source_type, source_ref, pages_updated, summary,
            created_at::text AS created_at
       FROM ingest_log
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({
    ...row,
    pages_updated: Array.isArray(row.pages_updated) ? row.pages_updated : [],
  }));
}

// ---------------------------------------------------------------------------
// facts:absorb — durable failure records with stable reason codes.
// ---------------------------------------------------------------------------

/** The source_type every facts-absorb row is filed under. */
export const FACTS_ABSORB_SOURCE_TYPE = "facts:absorb";

/** Stable reason codes (eligibility skips are intentionally NOT logged —
 *  high cardinality, low signal). */
export const FACTS_ABSORB_REASONS = [
  "gateway_error",
  "parse_failure",
  // The output cap cut the answer in half. Distinct from `parse_failure`: the
  // model was fine, the ceiling was not, and the operator can raise it. Bedrock
  // Converse names this stop reason `max_tokens`.
  "output_truncated",
  "queue_overflow",
  "queue_shutdown",
  "embed_failure",
  "budget_exhausted",
  "pipeline_error",
  // The model declined part of a page (a refusal or a content filter), even
  // read in halves. Logged with the character range only; the rest was read.
  "model_declined",
] as const;

export type FactsAbsorbReason = (typeof FACTS_ABSORB_REASONS)[number];

/**
 * Classify an arbitrary absorbed error into a stable reason code. Heuristic
 * name/message match, falling back to 'pipeline_error'. Covers memrain's
 * Bedrock error shapes.
 */
export function classifyFactsAbsorbError(err: unknown): FactsAbsorbReason {
  if (!err) return "pipeline_error";
  // Bounded: several patterns below scan with `.*`.
  const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  const name = err instanceof Error ? err.name : "";

  if (name === "BudgetExhausted") return "budget_exhausted";
  if ((err as { code?: unknown }).code === "budget_exhausted") return "budget_exhausted";
  // Paused batch work retries once the pause lifts.
  if (name === "BedrockHalted") return "gateway_error";
  // Access, credential and quota failures repeat on every retry; they are not
  // a flaky gateway. Checked first so an ARN or account id in the message
  // cannot pass for a status code below.
  const bedrock = classifyBedrockError(err);
  if (bedrock === "access" || bedrock === "credential" || bedrock === "quota") return "pipeline_error";

  // Bedrock / HTTP gateway shapes: timeouts, throttling, 5xx, connection loss.
  if (/timed?\s?out|ETIMEDOUT/i.test(msg)) return "gateway_error";
  if (/\b429\b|rate[\s-]?limit|too many requests|Throttling/i.test(msg)) return "gateway_error";
  if (/\b5\d\d\b|server error|internal server|bad gateway|service unavail/i.test(msg)) return "gateway_error";
  if (/ECONNRESET|ECONNREFUSED|EAI_AGAIN|getaddrinfo/i.test(msg)) return "gateway_error";

  if (/JSON\.parse|unexpected token|invalid json|not valid JSON/i.test(msg)) return "parse_failure";

  if (/queue.*overflow|cap.*hit/i.test(msg)) return "queue_overflow";
  if (/queue.*shutdown|shutting down/i.test(msg)) return "queue_shutdown";

  if (/embed/i.test(msg) && /fail|error/i.test(msg)) return "embed_failure";

  return "pipeline_error";
}

/**
 * Write one durable facts:absorb row:
 *
 *   source_type   = 'facts:absorb'
 *   source_ref    = page slug / session id the failure was tied to
 *   summary       = `<reason>: <terse detail truncated to 240 chars>`
 *
 * Best-effort: any error here is caught and stderr-warned; the caller's
 * pipeline keeps running (observability must not break the runtime path).
 */
export async function writeFactsAbsorbLog(
  engine: Engine,
  ref: string,
  reason: FactsAbsorbReason,
  detail: string,
  sourceId: string = "default",
): Promise<void> {
  try {
    const cleaned = (detail ?? "").toString().slice(0, 240);
    await logIngest(engine, {
      source_id: sourceId,
      source_type: FACTS_ABSORB_SOURCE_TYPE,
      source_ref: ref,
      pages_updated: [],
      summary: `${reason}: ${cleaned}`,
    });
  } catch (e) {
    console.warn(
      `[facts:absorb] failed to log ${reason} for ${ref}: ` +
        (e instanceof Error ? e.message : String(e)),
    );
  }
}
