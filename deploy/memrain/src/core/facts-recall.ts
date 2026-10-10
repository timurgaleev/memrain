/**
 * Single-fact recall + forget (soft-delete) over the `entity_facts` ledger.
 *
 * The ledger itself is append-only (see facts.ts), and `entity_facts` is
 * dedup'd per (entity_slug, fact, source_chunk_id). The list/aggregate reads
 * live in facts.ts; this module is the by-id pair:
 *
 *   - `recallFact(id)` — read ONE fact row by its primary key. Returns null
 *     when the id is unknown OR the fact has been forgotten (tombstoned). A
 *     forgotten fact is invisible to recall, mirroring how a soft-deleted page
 *     is invisible to `getPage`.
 *   - `forgetFact(id)` — tombstone a fact by stamping `forgotten_at` (and an
 *     optional `forgotten_reason`). The row stays for audit, exactly like
 *     page soft-delete keeps the page + its version chain. Idempotent: a
 *     second forget on an already-forgotten row is a no-op (forgotten=false),
 *     and an unknown id reports found=false rather than throwing.
 *
 * `forgotten_at` is the tombstone column added by the accompanying migration
 * (ADD COLUMN IF NOT EXISTS, NULLABLE). Append-only writes never touch it; a
 * NULL `forgotten_at` is a live fact.
 *
 * Deterministic and LLM-free.
 */
import type { Storage } from "./storage.ts";
import { andSourceScope } from "./source-scope.ts";
import { lockWithdrawals } from "./fact-withdrawals.ts";
import { deadlockSafeTransaction } from "./retry.ts";
import { normalizeFactRow } from "./facts.ts";
import type { SimilarActive } from "./facts-similar-active.ts";

/**
 * A single fact row as returned by `recallFact`. Mirrors the projection in
 * facts.ts `FactRow` plus the `forgotten_at` tombstone column. Always live
 * (recall filters out tombstoned rows), so `forgotten_at` is reported for
 * completeness but is NULL for any row this function returns.
 */
export interface RecalledFact {
  id: number;
  entity_slug: string;
  fact: string;
  confidence: number;
  source_slug: string | null;
  source_chunk_id: string | null;
  written_by: string | null;
  written_at: string;
  kind: string | null;
  notability: string | null;
  valid_from: string | null;
  valid_until: string | null;
  /** mig085 lifecycle metadata. */
  visibility: string;
  superseded_by: number | null;
  consolidated_into: number | null;
  context: string | null;
  source_session: string | null;
  /** mig130 speaker; NULL when not recorded. */
  attributed_to: string | null;
  /** Tombstone timestamp; NULL for every live row recall returns. */
  forgotten_at: string | null;
}

function normaliseId(id: unknown): number {
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    throw new Error("id must be a positive integer");
  }
  return id;
}

/**
 * Read one fact by id. Returns null when the id is unknown or the fact has
 * been forgotten (`forgotten_at IS NOT NULL`) — a tombstoned fact is treated
 * as gone, the same posture `getPage` takes for a soft-deleted page.
 */
export async function recallFact(
  storage: Storage,
  id: number,
  sourceIds?: string[],
): Promise<RecalledFact | null> {
  const factId = normaliseId(id);
  const params: unknown[] = [factId];
  // Tenant scope (mig047): filter whenever a list is given; `[]` matches nothing.
  const scopeFilter = andSourceScope("source_id", sourceIds, params);
  const r = await storage.engine().query<RecalledFact>(
    `SELECT id, entity_slug, fact, confidence,
            source_slug, source_chunk_id, written_by,
            written_at::text AS written_at,
            kind, notability,
            valid_from::text   AS valid_from,
            valid_until::text  AS valid_until,
            visibility, superseded_by, consolidated_into,
            context, source_session, attributed_to,
            forgotten_at::text AS forgotten_at
       FROM entity_facts
       WHERE id = $1 AND forgotten_at IS NULL${scopeFilter}`,
    params,
  );
  const row = r.rows[0];
  return row ? normalizeFactRow(row) : null;
}

/**
 * Structured tombstone cause (migration 062) — distinct from the free-text
 * `reason` audit note. A by-id operator forget is `forget`; an automatic
 * dedup/supersede retirement is `supersede`. A consumer that must not resurrect
 * a genuinely-forgotten fact honors ONLY `forget`.
 */
export type ForgetCause = "forget" | "supersede";

export interface ForgetFactInput {
  /** Optional audit note stored in `forgotten_reason`. */
  reason?: string;
  /**
   * Structured cause stamped in `forgotten_cause` (migration 062). Defaults to
   * `forget` — the by-id path is an explicit operator forget. A supersede/dedup
   * path passes `supersede` so a fence-reconcile skip-set can tell the two
   * apart and never suppress a superseded fence claim's legitimate re-insert.
   */
  cause?: ForgetCause;
}

export interface ForgetFactResult {
  id: number;
  /** False when no row matched the id. */
  found: boolean;
  /** True only when this call flipped a live fact to forgotten. */
  forgotten: boolean;
  /**
   * Other live copies of the same claim (same source, visibility, subject and
   * normalized text) this forget also retired. Always 0 for a supersede or an
   * unflipped call.
   */
  withdrawn_duplicates: number;
  /** Close live rewordings left behind; added by the MCP `forget_fact` handler
   *  after a flip (see facts-similar-active.ts). */
  similar_active?: SimilarActive;
}

/**
 * Tombstone a fact by id. Sets `forgotten_at = NOW()` (and `forgotten_reason`
 * when provided) on a live row; the row is retained for audit. Idempotent:
 *   - unknown id          -> { found: false, forgotten: false }
 *   - already-forgotten   -> { found: true,  forgotten: false }
 *   - live -> tombstoned  -> { found: true,  forgotten: true  }
 *
 * A `forget` (not a `supersede`) also withdraws the claim (migration 112): the
 * claim key is recorded in `fact_withdrawals`, every other live copy of it in
 * the row's source is retired, and any later insert of it lands forgotten.
 */
export async function forgetFact(
  storage: Storage,
  id: number,
  input: ForgetFactInput = {},
  sourceIds?: string[],
): Promise<ForgetFactResult> {
  const factId = normaliseId(id);
  const reason = typeof input.reason === "string" ? input.reason : null;
  // Structured cause (mig062) — defaults to 'forget'; a supersede/dedup path
  // passes 'supersede'. The CHECK constraint rejects any other value.
  const cause: ForgetCause = input.cause === "supersede" ? "supersede" : "forget";
  // Tenant write scope (mig047): when a scope is given, the row lookup, the
  // tombstone UPDATE and the existence probe are confined to it. A fact owned by
  // another source neither flips nor reports found — a scoped caller can never
  // forget, or even prove the existence of, a sibling tenant's fact. An empty
  // scope touches nothing. Unset → whole-brain by id. The withdrawal and the
  // duplicate sweep take the flipped row's own source, so they can never reach
  // past what the scope already allowed.
  const flipped = await deadlockSafeTransaction(storage.engine(), async (tx) => {
    // Flip first, lock after (the lock order in fact-withdrawals.ts): the
    // UPDATE may wait on a fence reconcile that deleted this row and is about
    // to insert under the shared lock, so it must not hold the exclusive one.
    const updParams: unknown[] = [factId, reason, cause];
    const updFilter = andSourceScope("source_id", sourceIds, updParams);
    const upd = await tx.query<{
      source_id: string;
      visibility: string;
      entity_slug: string;
      dimension: string | null;
      claim_key: string;
    }>(
      `UPDATE entity_facts
          SET forgotten_at = NOW(), forgotten_reason = $2, forgotten_cause = $3
        WHERE id = $1 AND forgotten_at IS NULL${updFilter}
        RETURNING source_id, visibility, entity_slug, dimension,
                  memrain_fact_claim_key(fact) AS claim_key`,
      updParams,
    );
    const hit = upd.rows[0];
    if (!hit) return null;
    if (cause !== "forget" || hit.dimension !== null) return { duplicates: 0 };
    await tx.query(
      `INSERT INTO fact_withdrawals
         (source_id, visibility, entity_slug, claim_key, first_fact_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [hit.source_id, hit.visibility, hit.entity_slug, hit.claim_key, factId, reason],
    );
    const sweep = async (): Promise<number> => {
      const swept = await tx.query<{ id: number }>(
        `UPDATE entity_facts
            SET forgotten_at = NOW(), forgotten_cause = 'forget',
                forgotten_reason = $6
          WHERE source_id = $1 AND visibility = $2 AND entity_slug = $3
            AND memrain_fact_claim_key(fact) = $4
            AND id <> $5
            AND forgotten_at IS NULL
            AND dimension IS NULL
          RETURNING id`,
        [
          hit.source_id,
          hit.visibility,
          hit.entity_slug,
          hit.claim_key,
          factId,
          `withdrawn with fact ${factId}`,
        ],
      );
      return swept.rows.length;
    };
    // The committed duplicates are retired before the lock, so their row locks
    // are never awaited while holding it. An insert of this claim that passed
    // its trigger check holds the lock shared until it commits; once the
    // exclusive lock is granted, the second sweep (a new statement) sees it.
    const early = await sweep();
    await lockWithdrawals(tx, [hit.source_id]);
    return { duplicates: early + (await sweep()) };
  });
  if (flipped !== null) {
    return {
      id: factId,
      found: true,
      forgotten: true,
      withdrawn_duplicates: flipped.duplicates,
    };
  }
  // No flip: either the id is unknown (or out of scope), or it was already
  // forgotten. One cheap, same-scope existence probe tells the two apart so the
  // caller gets an honest envelope without leaking another tenant's row.
  const probeParams: unknown[] = [factId];
  const probeFilter = andSourceScope("source_id", sourceIds, probeParams);
  const exists = await storage.engine().query<{ id: number }>(
    `SELECT id FROM entity_facts WHERE id = $1${probeFilter}`,
    probeParams,
  );
  return {
    id: factId,
    found: exists.rows.length > 0,
    forgotten: false,
    withdrawn_duplicates: 0,
  };
}
