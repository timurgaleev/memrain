/**
 * Failure backoff for per-document synthesis phases (`synth_failures`, mig 129).
 *
 * propose_takes and extract_atoms memoize a document only when the model
 * answers cleanly, which is right — a failure memoized as "nothing here" would
 * bury a document for good. But left alone, a document whose call throws or
 * whose answer never parses is paid for on every cycle, and because discovery
 * is recency-ordered a handful of them can take every slot of the run.
 *
 * So a failure parks the document instead: it is skipped until
 * `next_eligible_at`, which moves out 24h, 48h, 96h ... per consecutive failure
 * and never further than 7 days. The row only counts while the document's
 * content hash AND the model are the ones that failed — an edit or a model
 * switch makes the document eligible at once, and a failure after that starts
 * the count again. A clean answer deletes the row.
 *
 * Bookkeeping here must never cost the phase its run: every helper is
 * fail-open. A filter that cannot read the table returns the candidates
 * unfiltered (the pre-backoff behaviour), and a write that fails is reported
 * on stderr and dropped.
 */
import type { Engine } from "../engine/interface.ts";

export type SynthPhase = "propose_takes" | "extract_atoms";

export type SynthFailureKind = "llm_error" | "unparseable" | "truncated";

/** First wait after a failure. */
export const BACKOFF_BASE_MS = 24 * 60 * 60 * 1000;

/** The wait stops growing here. */
export const BACKOFF_CAP_MS = 7 * 24 * 60 * 60 * 1000;

/** Wait after the `attempts`-th consecutive failure: min(24h · 2^(n-1), 7d). */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  // 2^3 · 24h already passes the cap; clamping the exponent keeps the
  // arithmetic finite for any attempt count.
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 8), BACKOFF_CAP_MS);
}

export interface BackoffCandidate {
  id: string;
  contentHash16: string;
}

/**
 * Drop the candidates still parked for this phase, content hash and model.
 * Callers run it BEFORE they cut the list to the run's slot count, so a parked
 * document gives its slot to the next one instead of holding it.
 */
export async function filterBackedOff<T extends BackoffCandidate>(
  engine: Engine,
  phase: SynthPhase,
  candidates: readonly T[],
  model: string,
): Promise<T[]> {
  if (candidates.length === 0) return [];
  try {
    const { rows } = await engine.query<{ doc_id: string }>(
      `SELECT f.doc_id
         FROM synth_failures f
         JOIN unnest($1::text[], $2::text[]) AS w(doc_id, content_hash)
           ON f.doc_id = w.doc_id AND f.content_hash = w.content_hash
        WHERE f.phase = $3
          AND f.model = $4
          AND f.next_eligible_at > now()`,
      [candidates.map((c) => c.id), candidates.map((c) => c.contentHash16), phase, model],
    );
    if (rows.length === 0) return [...candidates];
    const parked = new Set(rows.map((r) => r.doc_id));
    return candidates.filter((c) => !parked.has(c.id));
  } catch (e) {
    warn(`${phase} backoff filter`, e);
    return [...candidates];
  }
}

export interface SynthFailureInput {
  docId: string;
  phase: SynthPhase;
  contentHash: string;
  model: string;
  kind: SynthFailureKind;
}

/**
 * Record one failed attempt. Consecutive failures on the same content and
 * model grow the wait; a different hash or model restarts it at 24h.
 */
export async function recordSynthFailure(engine: Engine, f: SynthFailureInput): Promise<void> {
  const sameQuestion =
    "synth_failures.content_hash = EXCLUDED.content_hash AND synth_failures.model = EXCLUDED.model";
  const attempts = `CASE WHEN ${sameQuestion} THEN synth_failures.attempts + 1 ELSE 1 END`;
  try {
    await engine.query(
      `INSERT INTO synth_failures
         (doc_id, phase, content_hash, model, attempts, kind, next_eligible_at, last_at)
       VALUES ($1, $2, $3, $4, 1, $5, now() + ($6::bigint * interval '1 millisecond'), now())
       ON CONFLICT (doc_id, phase) DO UPDATE SET
         attempts = ${attempts},
         next_eligible_at = now() + LEAST(
           $7::bigint * power(2, LEAST(${attempts} - 1, 8)) * interval '1 millisecond',
           $8::bigint * interval '1 millisecond'),
         content_hash = EXCLUDED.content_hash,
         model = EXCLUDED.model,
         kind = EXCLUDED.kind,
         last_at = now()`,
      [f.docId, f.phase, f.contentHash, f.model, f.kind, backoffMs(1), BACKOFF_BASE_MS, BACKOFF_CAP_MS],
    );
  } catch (e) {
    warn(`${f.phase} backoff record for ${f.docId}`, e);
  }
}

/** Forget a document's failures once it has answered cleanly. */
export async function clearSynthFailure(
  engine: Engine,
  docId: string,
  phase: SynthPhase,
): Promise<void> {
  try {
    await engine.query(`DELETE FROM synth_failures WHERE doc_id = $1 AND phase = $2`, [docId, phase]);
  } catch (e) {
    warn(`${phase} backoff clear for ${docId}`, e);
  }
}

function warn(what: string, e: unknown): void {
  process.stderr.write(`[synth-failures] ${what} failed: ${e instanceof Error ? e.message : String(e)}\n`);
}
