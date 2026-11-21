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
 * caller cannot retire, or even probe for, a sibling tenant's fact. A remote
 * (non-operator) caller reads only world facts, so it may only retire those.
 *
 * The old fact must be about the same entity as the new one: a correction
 * about one person never retires, or points the supersede chain of, another's.
 *
 * A new fact less trusted than the old one does not retire it: a trust
 * proposal waits for the owner instead (core/trust-proposals.ts).
 */
import { ownerOnlyLineageSql } from "./owner-only.ts";
import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { supersededValidUntilSql } from "./fact-validity.ts";
import { contestIfLessTrusted } from "./trust-proposals.ts";

export type ReplaceSkipReason = "not_live_or_out_of_scope" | "not_written" | "same_fact" | "entity_mismatch" | "contested";

export interface ReplaceOutcome {
  replaced: boolean;
  /** Present only when `replaced` is false. */
  replace_reason?: ReplaceSkipReason;
  /** With `contested`: the trust proposal the owner decides. */
  proposal_id?: number;
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
  opts: { worldOnly?: boolean } = {},
): Promise<ReplaceOutcome> {
  if (newId === null) return { replaced: false, replace_reason: "not_written" };
  // Restating the very fact being replaced refreshes it in place; retiring it
  // would leave the caller with no live copy at all.
  if (newId === oldId) return { replaced: false, replace_reason: "same_fact" };
  const retired = await engine.transaction(async (tx): Promise<ReplaceSkipReason | { proposal_id: number } | null> => {
    const params: unknown[] = [oldId];
    const scope = andSourceScope("source_id", sourceIds, params);
    const world = opts.worldOnly ? ` AND visibility = 'world' AND ${ownerOnlyLineageSql("fact", "entity_facts.id")}` : "";
    const locked = await tx.query<{ entity_slug: string }>(
      `SELECT entity_slug FROM entity_facts
        WHERE id = $1 AND forgotten_at IS NULL${scope}${world}
        FOR UPDATE`,
      params,
    );
    const row = locked.rows[0];
    if (!row || (allowEntity && !allowEntity(row.entity_slug))) return "not_live_or_out_of_scope";
    // Compared with the stored row, so both sides carry the same canonical slug.
    const fresh = await tx.query<{ entity_slug: string; valid_from: string | null }>(
      `SELECT entity_slug, valid_from::text AS valid_from FROM entity_facts WHERE id = $1`, [newId],
    );
    if (fresh.rows[0]?.entity_slug !== row.entity_slug) return "entity_mismatch";
    const contested = await contestIfLessTrusted(tx, { oldId, newId, guard: "replaces" });
    if (contested) return { proposal_id: contested.proposal_id };
    await tx.query(
      `UPDATE entity_facts
          SET forgotten_at = NOW(), forgotten_reason = $2,
              forgotten_cause = 'supersede', superseded_by = $3,
              valid_until = ${supersededValidUntilSql(4)}
        WHERE id = $1 AND forgotten_at IS NULL`,
      [oldId, `replaced by fact ${newId}`, newId, fresh.rows[0]!.valid_from],
    );
    return null;
  });
  if (retired === null) return { replaced: true };
  if (typeof retired === "object") return { replaced: false, replace_reason: "contested", proposal_id: retired.proposal_id };
  return { replaced: false, replace_reason: retired };
}
