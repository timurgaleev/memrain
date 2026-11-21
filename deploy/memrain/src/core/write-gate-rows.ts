/**
 * The write gate on facts, takes and timeline entries, in flag mode.
 *
 * Documents are gated in the indexer (write-gate-index.ts). A row an agent
 * writes, or one that lands in an outside source, runs through the same
 * detector here after it is stored: when its text reads as instructions to an
 * AI, a receipt goes into `write_gate_receipts` (migration 179) naming the
 * families and a hash of the text, never the text. The row is stored and read
 * exactly as before; no mode quarantines or refuses a row yet.
 *
 * Recording is best effort: a failure is logged and never fails the write.
 * Some writers call this inside their own transaction, where a failed
 * statement would abort it, so every statement here is a read or an insert
 * that cannot violate a constraint (a missing source writes nothing).
 */
import type { Engine } from "./engine/interface.ts";
import type { TrustTier } from "./trust-tier.ts";
import { documentRankSql, factRankSql, isTrustTier, pageRankSql, rankTierSql } from "./trust-tier.ts";
import {
  detectInstructionLike,
  writeGateBinding,
  writeGateOrigin,
  type DetectorResult,
  type GateField,
  type WriteGateOrigin,
} from "./write-gate.ts";

export type GatedRowTable = "entity_facts" | "synth_takes" | "timeline_events";
export type RowGateMode = "off" | "flag";

/**
 * Rows of both origins are checked unless the origin's variable
 * (MEMRAIN_WRITE_GATE_EXTERNAL / MEMRAIN_WRITE_GATE_AGENT) is `off`. A receipt
 * changes nothing a reader sees, so the agent origin is checked even though
 * agent documents are not gated by default; `quarantine` and `reject` still
 * only flag a row.
 */
export function resolveRowGateMode(
  origin: WriteGateOrigin,
  _sourceId: string,
  env: Record<string, string | undefined> = process.env,
): RowGateMode {
  const key = origin === "external" ? "MEMRAIN_WRITE_GATE_EXTERNAL" : "MEMRAIN_WRITE_GATE_AGENT";
  return env[key]?.trim().toLowerCase() === "off" ? "off" : "flag";
}

export interface GatedRow {
  table: GatedRowTable;
  /** The row's id (`synth_takes`: its take_key). */
  targetId: string | number;
  sourceId: string | null;
  /** The writer's trust tier for this row. */
  tier: TrustTier;
  fields: readonly GateField[];
}

/** Check one stored row; true when a receipt was written or bumped. Never throws. */
export async function flagGatedRow(
  engine: Engine,
  row: GatedRow,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const result = detect(row.fields);
  if (result !== null && !result.flagged) return false;
  return recordFlag(engine, row, result, env);
}

/** The detector's result, or null when it threw (recorded as a detector error). */
function detect(fields: readonly GateField[]): DetectorResult | null {
  try {
    return detectInstructionLike(fields);
  } catch {
    return null;
  }
}

async function recordFlag(
  engine: Engine,
  row: GatedRow,
  result: DetectorResult | null,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const sourceId = row.sourceId ?? "default";
  const origin = writeGateOrigin(row.tier);
  if (origin === null || resolveRowGateMode(origin, sourceId, env) === "off") return false;
  try {
    const r = await engine.query<{ id: number }>(
      `INSERT INTO write_gate_receipts
         (target_table, target_id, source_id, origin, verdict, reason_families, detector_version, detector_error, binding)
       SELECT $1, $2, $3, $4, 'flag', $5::text[], $6, $7, $8
        WHERE EXISTS (SELECT 1 FROM sources WHERE id = $3)
       ON CONFLICT (target_table, target_id, binding, detector_version)
       DO UPDATE SET seen_count = write_gate_receipts.seen_count + 1, last_seen_at = NOW()
       RETURNING id`,
      [
        row.table,
        String(row.targetId),
        sourceId,
        origin,
        result?.families ?? [],
        result?.detector_version ?? "unknown",
        result === null,
        writeGateBinding(row.fields),
      ],
    );
    return r.rows.length > 0;
  } catch (e) {
    console.warn(`[write-gate] could not record a flag on ${row.table} ${row.targetId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** The stored row whose effective tier decides the origin, read the way trust-frame.ts reads it. */
export type RowOrigin =
  | { fact: number }
  | { event: number }
  /** A take on a page's takes fence. */
  | { page: string }
  /** A take proposed from a document. */
  | { document: string };

function originQuery(origin: RowOrigin): { sql: string; param: string | number } {
  if ("fact" in origin) {
    // scope: upstream the row the caller just wrote, by its key
    return { sql: `SELECT ${rankTierSql(factRankSql("r", "tt_p.slug IN (r.source_slug, r.source_markdown_slug)"))} AS tier, r.source_id FROM entity_facts r WHERE r.id = $1`, param: origin.fact };
  }
  if ("event" in origin) {
    // scope: upstream the row the caller just wrote, by its key
    return { sql: `SELECT ${rankTierSql(factRankSql("r", "tt_p.slug = r.slug", false))} AS tier, r.source_id FROM timeline_events r WHERE r.id = $1`, param: origin.event };
  }
  if ("page" in origin) {
    // scope: upstream the row the caller just wrote, by its key
    return { sql: `SELECT ${rankTierSql(pageRankSql("pg"))} AS tier, pg.source_id FROM pages pg WHERE pg.slug = $1`, param: origin.page };
  }
  // scope: upstream the document the caller just drew the row from, by its key
  return { sql: `SELECT ${rankTierSql(documentRankSql("d"))} AS tier, COALESCE(d.source_id, 'default') AS source_id FROM documents d WHERE d.id = $1`, param: origin.document };
}

/**
 * Check a stored row whose tier is its effective trust: the writer, the
 * source kind, and the page or document it was drawn from, so a fact the
 * extractor took from an agent's page counts as the agent's. Never throws.
 */
export async function flagRowAt(
  engine: Engine,
  row: { table: GatedRowTable; targetId: string | number; fields: readonly GateField[] },
  origin: RowOrigin,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  // Most rows are plain text: run the detector before the tier lookup, which
  // joins page history and runs inside some writers' transactions.
  const result = detect(row.fields);
  if (result !== null && !result.flagged) return false;
  try {
    const q = originQuery(origin);
    const r = await engine.query<{ tier: string | null; source_id: string | null }>(q.sql, [q.param]);
    const tier = r.rows[0]?.tier;
    if (!isTrustTier(tier)) return false;
    return await recordFlag(engine, { ...row, sourceId: r.rows[0]?.source_id ?? null, tier }, result, env);
  } catch (e) {
    console.warn(`[write-gate] could not check ${row.table} ${row.targetId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
