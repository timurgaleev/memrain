/**
 * Operator-authored takes canon — the DB side of the fenced takes model
 * (migrations 090/091).
 *
 *   deriveResolutionTuple — pure (quality, outcome) derivation shared by every
 *     resolve write site, so the schema CHECK is defense-in-depth, not the
 *     first line.
 *   resolveTake — write the resolution tuple onto a synth_takes row. This is
 *     how a take gets RESOLVED (by the operator, or by the gated auto-resolve
 *     path in grade_takes) — distinct from synth_take_grades, which stay
 *     advisory judge verdicts. Calibration then measures the human: the
 *     scorecard reads the take's own resolution tuple ahead of the latest
 *     judge grade.
 *   syncTakesFromFence — derive synth_takes rows from a page's fenced takes
 *     table. Markdown is canonical; the DB rows are the index. Keyed on
 *     (source_ref, row_num), append-only row numbers, so re-sync is
 *     idempotent and claim edits update in place.
 */
import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import {
  parseTakesFence,
  normalizeWeightForStorage,
  type ParsedFenceTake,
  type TakeQuality,
} from "./takes-fence.ts";
import { contentHash16 } from "./atoms.ts";
import { fenceBounds, hasFenceMarker } from "../fence-shared.ts";
import { normalizeScope } from "../source-scope.ts";

/** Prompt-version marker for fence-derived rows — they never came from an LLM
 *  prompt, but the column is NOT NULL and doubles as provenance. */
export const FENCE_PROMPT_VERSION = "operator-fence-v1";
/** model_id provenance for fence-derived rows. */
export const FENCE_MODEL_ID = "operator";

export interface TakeResolution {
  quality?: TakeQuality;
  /** Back-compat boolean alias: true=correct, false=incorrect. */
  outcome?: boolean;
  value?: number;
  unit?: string;
  /** Human note / evidence pointer. */
  source?: string;
  resolvedBy?: string;
  /** ISO timestamp; defaults to now() at the write site. */
  resolvedAt?: string;
}

/**
 * Derive the (quality, outcome) tuple that gets written to the take row.
 * `quality` wins when both are set; a contradiction between the two throws
 * rather than silently overwriting. Throws when neither is set. A boolean
 * outcome alone can never derive 'partial'/'unresolvable' — those need
 * explicit quality.
 */
export function deriveResolutionTuple(resolution: TakeResolution): {
  quality: TakeQuality;
  outcome: boolean | null;
} {
  const { quality, outcome } = resolution;
  if (quality === undefined && outcome === undefined) {
    throw new Error(
      "resolveTake: must pass either `quality` (correct|incorrect|partial|unresolvable) or `outcome` (true|false)",
    );
  }
  if (quality !== undefined) {
    if (outcome !== undefined) {
      const expected = quality === "correct" ? true : quality === "incorrect" ? false : null;
      if (expected !== outcome) {
        throw new Error(
          `resolveTake: quality=${quality} contradicts outcome=${outcome}; pass only one`,
        );
      }
    }
    return {
      quality,
      outcome: quality === "correct" ? true : quality === "incorrect" ? false : null,
    };
  }
  return {
    quality: outcome ? "correct" : "incorrect",
    outcome: outcome ?? null,
  };
}

export interface ResolveTakeOptions {
  /** Tenant scope, mirroring setTakeStatus: when supplied, the update only
   *  lands if the take's source document belongs to one of these tenants;
   *  an empty scope updates nothing. */
  sourceIds?: string[];
  /** When true, an already-resolved take is left untouched (the auto-resolve
   *  posture: a machine verdict never overwrites a human resolution). */
  onlyIfUnresolved?: boolean;
}

/**
 * Write a resolution tuple onto a take, addressed by take_key. Only active
 * takes resolve. Returns whether a row was actually updated.
 */
export async function resolveTake(
  engine: Engine,
  takeKey: string,
  resolution: TakeResolution,
  opts: ResolveTakeOptions = {},
): Promise<{ resolved: boolean }> {
  const { quality, outcome } = deriveResolutionTuple(resolution);
  const params: unknown[] = [
    quality,
    outcome,
    resolution.value ?? null,
    resolution.unit ?? null,
    resolution.source ?? null,
    resolution.resolvedBy ?? null,
    resolution.resolvedAt ?? null,
    takeKey,
  ];
  let guard = "";
  if (opts.onlyIfUnresolved) guard += " AND resolved_at IS NULL";
  const scoped = normalizeScope(opts.sourceIds);
  if (scoped !== undefined && scoped.length === 0) {
    guard += " AND FALSE";
  } else if (scoped !== undefined) {
    params.push(scoped);
    guard += ` AND EXISTS (
        SELECT 1 FROM documents d
         WHERE d.id = synth_takes.source_ref
           AND d.source_id = ANY($${params.length}::text[])
      )`;
  }
  const { rows } = await engine.query<{ id: number }>(
    `UPDATE synth_takes
        SET resolved_at      = COALESCE($7::timestamptz, now()),
            resolved_quality = $1,
            resolved_outcome = $2,
            resolved_value   = $3,
            resolved_unit    = $4,
            resolved_source  = $5,
            resolved_by      = $6
      WHERE take_key = $8 AND active${guard}
    RETURNING id`,
    params,
  );
  return { resolved: rows.length > 0 };
}

/** Stable take_key for a fence row — a function of the page + row number, NOT
 *  the claim text, so an in-place claim edit updates the same row. */
export function fenceTakeKey(sourceRef: string, rowNum: number): string {
  return createHash("sha256").update(`fence ${sourceRef} #${rowNum}`).digest("hex");
}

export interface SyncTakesFenceResult {
  rowsUpserted: number;
  /** Rows previously synced from this page's fence but no longer present in
   *  it (hand-deleted) — marked inactive, never deleted. */
  rowsDeactivated: number;
  weightsClamped: number;
  warnings: string[];
}

/**
 * Sync a page's fenced takes table into synth_takes (the derived index).
 *
 * - Upserts one row per fence row, keyed on (source_ref, row_num) via the
 *   deterministic fenceTakeKey. Claim/kind/holder/weight/dates/active and any
 *   inline resolution columns follow the fence on every sync.
 * - Fence rows enter as status 'accepted' (operator-authored canon — they are
 *   not an LLM proposal awaiting review).
 * - A previously-synced row missing from the current fence is marked
 *   active=false (markdown is canonical; the index follows it) — never
 *   deleted, so grades and references survive.
 * - A body with no fence is a no-op (returns zeros), so this is safe to call
 *   on every page write.
 * - A body carrying both a `memrain:` and a `memex:` takes fence is a no-op
 *   too (TAKES_FENCE_MIXED warning): the empty parse must not reach the
 *   deactivation below, or every fence take of the page would go inactive.
 */
export async function syncTakesFromFence(
  engine: Engine,
  sourceRef: string,
  body: string,
): Promise<SyncTakesFenceResult> {
  const { takes, warnings } = parseTakesFence(body);
  const result: SyncTakesFenceResult = {
    rowsUpserted: 0,
    rowsDeactivated: 0,
    weightsClamped: 0,
    warnings,
  };
  if (fenceBounds(body, "takes")?.brand === "both") return result;
  if (takes.length === 0 && !hasFenceMarker(body, "takes")) return result;

  for (const t of takes) {
    const { weight, clamped } = normalizeWeightForStorage(t.weight);
    if (clamped) result.weightsClamped += 1;
    const resolution = t.resolvedQuality !== undefined ? fenceResolution(t) : null;
    await engine.query(
      `INSERT INTO synth_takes
         (take_key, source_ref, source_hash, prompt_version, claim_text, kind,
          weight, status, model_id, holder, active, row_num, since_date, until_date,
          resolved_at, resolved_quality, resolved_outcome, resolved_value,
          resolved_unit, resolved_source, resolved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'accepted', $8, $9, $10, $11, $12, $13,
               $14::timestamptz, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (take_key) DO UPDATE SET
         source_hash      = EXCLUDED.source_hash,
         claim_text       = EXCLUDED.claim_text,
         kind             = EXCLUDED.kind,
         weight           = EXCLUDED.weight,
         holder           = EXCLUDED.holder,
         active           = EXCLUDED.active,
         since_date       = EXCLUDED.since_date,
         until_date       = EXCLUDED.until_date,
         resolved_at = CASE
           WHEN EXCLUDED.resolved_quality IS NOT NULL THEN EXCLUDED.resolved_at
           WHEN synth_takes.claim_text IS DISTINCT FROM EXCLUDED.claim_text THEN NULL
           ELSE synth_takes.resolved_at END,
         resolved_quality = CASE
           WHEN EXCLUDED.resolved_quality IS NOT NULL THEN EXCLUDED.resolved_quality
           WHEN synth_takes.claim_text IS DISTINCT FROM EXCLUDED.claim_text THEN NULL
           ELSE synth_takes.resolved_quality END,
         resolved_outcome = CASE
           WHEN EXCLUDED.resolved_quality IS NOT NULL THEN EXCLUDED.resolved_outcome
           WHEN synth_takes.claim_text IS DISTINCT FROM EXCLUDED.claim_text THEN NULL
           ELSE synth_takes.resolved_outcome END,
         resolved_value = CASE
           WHEN EXCLUDED.resolved_quality IS NOT NULL THEN EXCLUDED.resolved_value
           WHEN synth_takes.claim_text IS DISTINCT FROM EXCLUDED.claim_text THEN NULL
           ELSE synth_takes.resolved_value END,
         resolved_unit = CASE
           WHEN EXCLUDED.resolved_quality IS NOT NULL THEN EXCLUDED.resolved_unit
           WHEN synth_takes.claim_text IS DISTINCT FROM EXCLUDED.claim_text THEN NULL
           ELSE synth_takes.resolved_unit END,
         resolved_source = CASE
           WHEN EXCLUDED.resolved_quality IS NOT NULL THEN EXCLUDED.resolved_source
           WHEN synth_takes.claim_text IS DISTINCT FROM EXCLUDED.claim_text THEN NULL
           ELSE synth_takes.resolved_source END,
         resolved_by = CASE
           WHEN EXCLUDED.resolved_quality IS NOT NULL THEN EXCLUDED.resolved_by
           WHEN synth_takes.claim_text IS DISTINCT FROM EXCLUDED.claim_text THEN NULL
           ELSE synth_takes.resolved_by END,
         status = CASE
           WHEN synth_takes.claim_text IS DISTINCT FROM EXCLUDED.claim_text AND synth_takes.status = 'graded'
           THEN 'accepted' ELSE synth_takes.status END`,
      [
        fenceTakeKey(sourceRef, t.rowNum),
        sourceRef,
        contentHash16(t.claim),
        FENCE_PROMPT_VERSION,
        t.claim,
        t.kind,
        weight,
        FENCE_MODEL_ID,
        t.holder,
        t.active,
        t.rowNum,
        t.sinceDate ?? null,
        t.untilDate ?? null,
        resolution?.resolvedAt ?? null,
        resolution?.quality ?? null,
        resolution?.outcome ?? null,
        t.resolvedValue ?? null,
        t.resolvedUnit ?? null,
        t.resolvedEvidence ?? null,
        t.resolvedBy ?? null,
      ],
    );
    result.rowsUpserted += 1;
  }

  // Deactivate previously-synced fence rows that vanished from the fence.
  const liveRowNums = takes.map((t) => t.rowNum);
  const { rows: deactivated } = await engine.query<{ id: number }>(
    `UPDATE synth_takes
        SET active = false
      WHERE source_ref = $1
        AND row_num IS NOT NULL
        AND active
        AND NOT (row_num = ANY($2::int[]))
    RETURNING id`,
    [sourceRef, liveRowNums],
  );
  result.rowsDeactivated = deactivated.length;
  return result;
}

function fenceResolution(t: ParsedFenceTake): {
  quality: TakeQuality;
  outcome: boolean | null;
  resolvedAt: string | null;
} {
  const { quality, outcome } = deriveResolutionTuple({
    ...(t.resolvedQuality !== undefined ? { quality: t.resolvedQuality } : {}),
    ...(t.resolvedOutcome !== undefined ? { outcome: t.resolvedOutcome } : {}),
  });
  // The fence's `resolved` cell is free-hand text; only a parseable date makes
  // it into the timestamptz column (a bad cell must not fail the whole sync).
  const raw = t.resolvedAt?.trim();
  const resolvedAt = raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
  return { quality, outcome, resolvedAt };
}
