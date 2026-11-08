/**
 * Claim withdrawals (migration 112): a forgotten claim stays forgotten under
 * its (source_id, visibility, entity_slug, claim_key) key.
 *
 * Lock order, for every transaction that touches both: take fact row locks
 * first (UPDATE/DELETE of entity_facts), the per-source withdraw lock after.
 * Inserts take the lock shared from the migration 112 trigger, and a fence
 * reconcile deletes a page's rows before it inserts, so a writer that took the
 * exclusive lock and then waited on a fact row would deadlock against it.
 * Under the exclusive lock, only re-sweep for rows that raced in; every row
 * already committed is retired before the lock is taken.
 *
 * That two-sided sweep is why no single global order exists: the retirement has
 * to run once outside the lock and once under it. Two writers in this order (a
 * forget and a merge; a forget and a fence rebuild) can therefore still close a
 * cycle — the second sweep waits on a row the other side holds while the other
 * side waits for the lock — so every transaction that takes this lock goes
 * through `deadlockSafeTransaction` and is re-run if Postgres aborts it.
 */
import type { Engine } from "./engine/interface.ts";
import { FACT_WITHDRAW_LOCK_NS } from "./brand.ts";

export interface WithdrawalDetail {
  source_id: string;
  visibility: string;
  entity_slug: string;
  withdrawn_at: string;
  scope: "normalized_claim";
}

/** Metadata only: the reason and original claim may contain private free text. */
export async function getWithdrawalDetail(
  engine: Pick<Engine, "query">,
  key: { source_id: string; visibility: string; entity_slug: string; fact: string },
): Promise<WithdrawalDetail | undefined> {
  const r = await engine.query<WithdrawalDetail>(
    `SELECT source_id, visibility, entity_slug, created_at::text AS withdrawn_at,
            'normalized_claim'::text AS scope
       FROM fact_withdrawals WHERE source_id = $1 AND visibility = $2
        AND entity_slug = $3 AND claim_key = memrain_fact_claim_key($4)`,
    [key.source_id, key.visibility, key.entity_slug, key.fact],
  );
  return r.rows[0];
}

/** Advisory-lock key serializing a source's withdrawals against its fact
 *  inserts (the insert trigger, migrations 112 and 120, takes the same key
 *  shared). */
export function withdrawLockKey(sourceId: string): string {
  return `${FACT_WITHDRAW_LOCK_NS}${sourceId}`;
}

/** Take the exclusive withdraw lock for each source, in a stable order so two
 *  multi-source lockers cannot deadlock on each other. */
export async function lockWithdrawals(tx: Engine, sourceIds: Iterable<string>): Promise<void> {
  for (const id of [...new Set(sourceIds)].sort()) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [withdrawLockKey(id)]);
  }
}

/**
 * Carry the withdrawals keyed on `fromSlug` over to `toSlug` when a merge or a
 * rename re-points facts, and retire any live fact on `toSlug` that is now
 * withdrawn. The re-point is an UPDATE, which the insert trigger never sees,
 * so without this a moved claim, or the next re-extraction of it onto the new
 * slug, would land live. `sourceId` confines both steps to one source (a
 * merge); null covers every source (a rename moves all of a slug's facts).
 * Run it in the re-point's transaction, after the entity_facts UPDATE.
 * Returns the number of facts retired.
 */
export async function carryFactWithdrawals(
  tx: Engine,
  fromSlug: string,
  toSlug: string,
  sourceId: string | null,
): Promise<number> {
  const params: unknown[] = [fromSlug, toSlug];
  let scope = "";
  if (sourceId !== null) {
    params.push(sourceId);
    scope = " AND source_id = $3";
  }
  await tx.query(
    `INSERT INTO fact_withdrawals
       (source_id, visibility, entity_slug, claim_key, first_fact_id, reason)
     SELECT source_id, visibility, $2, claim_key, first_fact_id, reason
       FROM fact_withdrawals
      WHERE entity_slug = $1${scope}
     ON CONFLICT DO NOTHING`,
    params,
  );
  // Withdrawals already on the target count too: a stub-side live copy of a
  // claim forgotten on the canonical slug was just moved onto it.
  const onTarget = await tx.query<{ source_id: string }>(
    `SELECT DISTINCT source_id FROM fact_withdrawals
      WHERE entity_slug = $1${sourceId !== null ? " AND source_id = $2" : ""}`,
    sourceId !== null ? [toSlug, sourceId] : [toSlug],
  );
  const sources = onTarget.rows.map((r) => r.source_id);
  if (sources.length === 0) return 0;
  const sweep = async (): Promise<number> => {
    const swept = await tx.query<{ id: number }>(
      `UPDATE entity_facts ef
          SET forgotten_at = NOW(), forgotten_cause = 'forget',
              forgotten_reason = 'withdrawn (moved from ' || $1 || ')'
         FROM fact_withdrawals w
        WHERE ef.entity_slug = $2
          AND ef.forgotten_at IS NULL
          AND ef.dimension IS NULL
          AND w.source_id = ef.source_id
          AND w.visibility = ef.visibility
          AND w.entity_slug = ef.entity_slug
          AND w.claim_key = memrain_fact_claim_key(ef.fact)${sourceId !== null ? " AND ef.source_id = $3" : ""}
        RETURNING ef.id`,
      params,
    );
    return swept.rows.length;
  };
  // Same order as forgetFact: retire the committed rows before taking the lock,
  // then sweep once more under it for an insert that raced past its trigger
  // check (it holds the lock shared until it commits).
  const early = await sweep();
  await lockWithdrawals(tx, sources);
  return early + (await sweep());
}
