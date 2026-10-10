/**
 * `add_fact` with `replaces`: retire one named fact in favour of the fact that
 * was just written.
 *
 * The new fact is written first through the ordinary `addFact` path; only once
 * it landed is the old one retired, under a row lock so two replacements of the
 * same fact cannot both claim it. The retirement is a supersede, not a forget:
 * `forgotten_cause = 'supersede'` plus the mig085 `superseded_by` pointer, so
 * the chain stays visible to `fact_supersessions` and the claim is not
 * withdrawn (a later restatement of the old text is still allowed to land).
 *
 * Scope: the lookup is confined to the caller's write source (and, for a
 * slug-bound caller, to entities under its prefixes). A fact outside that scope
 * is reported exactly like an unknown or already-retired one, so a scoped
 * caller cannot retire, or even probe for, a sibling tenant's fact.
 */
import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";

export type ReplaceSkipReason = "not_live_or_out_of_scope" | "not_written" | "same_fact";

export interface ReplaceOutcome {
  replaced: boolean;
  /** Present only when `replaced` is false. */
  replace_reason?: ReplaceSkipReason;
}

/**
 * Retire `oldId` as superseded by `newId`. `newId` is null when the write did
 * not land (a withdrawn claim), in which case nothing is retired.
 */
export async function replaceFact(
  engine: Engine,
  oldId: number,
  newId: number | null,
  sourceIds: string[] | undefined,
  /** A slug-bound caller may only retire facts about entities it may write. */
  allowEntity?: (entitySlug: string) => boolean,
): Promise<ReplaceOutcome> {
  if (newId === null) return { replaced: false, replace_reason: "not_written" };
  // Restating the very fact being replaced refreshes it in place; retiring it
  // would leave the caller with no live copy at all.
  if (newId === oldId) return { replaced: false, replace_reason: "same_fact" };
  const retired = await engine.transaction(async (tx) => {
    const params: unknown[] = [oldId];
    const scope = andSourceScope("source_id", sourceIds, params);
    const locked = await tx.query<{ entity_slug: string }>(
      `SELECT entity_slug FROM entity_facts
        WHERE id = $1 AND forgotten_at IS NULL${scope}
        FOR UPDATE`,
      params,
    );
    const row = locked.rows[0];
    if (!row || (allowEntity && !allowEntity(row.entity_slug))) return false;
    await tx.query(
      `UPDATE entity_facts
          SET forgotten_at = NOW(), forgotten_reason = $2,
              forgotten_cause = 'supersede', superseded_by = $3
        WHERE id = $1 AND forgotten_at IS NULL`,
      [oldId, `replaced by fact ${newId}`, newId],
    );
    return true;
  });
  return retired ? { replaced: true } : { replaced: false, replace_reason: "not_live_or_out_of_scope" };
}
