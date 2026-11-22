/**
 * Trust proposals (migration 185): a write whose tier is lower than the fact
 * it would supersede, or the ontology value it would close, does not change
 * that fact. The new fact is stored beside it (an ontology value as
 * quarantined, so readers keep the current one) and a proposal links the two.
 *
 * The owner decides, from the local CLI (`memrain trust`) or the admin
 * Approvals page:
 *   accept  the replacement the writer asked for is applied now
 *   reject  the lower-tier fact is retired in favour of the old one
 * Both re-read the two facts under lock; a proposal whose facts changed in
 * the meantime goes `stale` and changes nothing.
 *
 * Tiers are compared by the readers' own effective rank (factRankSql), so a
 * fact written before migration 158 counts at the tier its evidence gives it.
 */
import type { Engine } from "./engine/interface.ts";
import { supersededValidUntilSql } from "./fact-validity.ts";
import { factRankSql, tierOfRank, trustRank, type TrustTier } from "./trust-tier.ts";
import { forgetInTx } from "./facts-recall.ts";
import { deadlockSafeTransaction } from "./retry.ts";
import { factRemoteEligibleSql } from "./fact-visibility.ts";

type Queryable = Pick<Engine, "query">;

export type TrustProposalGuard = "conflict" | "replaces" | "ontology" | "remote_forget";
export type TrustProposalAction = "supersede_fact" | "forget";
export type TrustProposalStatus = "pending" | "accepted" | "rejected" | "stale";
export type TrustDecisionStatus = "accepted" | "rejected" | "stale" | "already_decided" | "not_found";

export interface Contested {
  proposal_id: number;
  /** The more trusted fact the write left in place. */
  fact_id: number;
}

const FACT_RANK = factRankSql("r", "tt_p.slug IN (r.source_slug, r.source_markdown_slug)");

/** Effective tiers of facts by id. */
async function factTiers(q: Queryable, ids: readonly number[]): Promise<Map<number, TrustTier>> {
  const r = await q.query<{ id: number; rank: number }>(
    // scope: upstream two fact ids the calling writer already resolved in its own scope
    `SELECT r.id, (${FACT_RANK})::int AS rank FROM entity_facts r WHERE r.id = ANY($1::bigint[])`,
    [[...ids]],
  );
  return new Map(r.rows.map(x => [Number(x.id), tierOfRank(Number(x.rank))]));
}

/**
 * Inside the writer's transaction, after the new fact landed: when it is less
 * trusted than the fact it would replace, record (or reuse) the pending
 * proposal and return it; null when the replacement may go ahead.
 */
export async function contestIfLessTrusted(
  tx: Queryable,
  input: { oldId: number; newId: number; guard: TrustProposalGuard },
): Promise<Contested | null> {
  if (input.oldId === input.newId) return null;
  const tiers = await factTiers(tx, [input.oldId, input.newId]);
  const oldTier = tiers.get(input.oldId);
  const newTier = tiers.get(input.newId);
  if (oldTier === undefined || newTier === undefined || trustRank(newTier) >= trustRank(oldTier)) return null;
  const before = { old: { id: input.oldId, tier: oldTier }, new: { id: input.newId, tier: newTier } };
  const ins = await tx.query<{ id: number }>(
    // scope: upstream the new fact the calling writer just inserted in its own scope
    `INSERT INTO trust_proposals (action, guard, source_id, target_id, related_id, before_state, proposer_principal)
     SELECT 'supersede_fact', $1, f.source_id, $2, $3, $4::text::jsonb, f.written_by_principal
       FROM entity_facts f WHERE f.id = $3
     ON CONFLICT (target_id, related_id) WHERE status = 'pending' DO NOTHING
     RETURNING id`,
    [input.guard, input.oldId, input.newId, JSON.stringify(before)],
  );
  let id = ins.rows[0]?.id;
  if (id === undefined) {
    const found = await tx.query<{ id: number }>(
      // scope: upstream the pair of fact ids the calling writer already resolved
      `SELECT id FROM trust_proposals WHERE target_id = $1 AND related_id = $2 AND status = 'pending'`,
      [input.oldId, input.newId],
    );
    id = found.rows[0]?.id;
  }
  if (id === undefined) throw new Error("trust proposal insert conflicted but no pending row was found");
  return { proposal_id: Number(id), fact_id: input.oldId };
}

/**
 * Locks a fact and every live copy of its claim in its source (same
 * visibility and subject), in id order, and returns their ids. A remote forget
 * and the owner's decision on a forget proposal both lock through here before
 * anything else, so they take the same rows in the same order and cannot
 * deadlock each other.
 */
export async function lockClaimCopies(tx: Queryable, factId: number): Promise<number[]> {
  const r = await tx.query<{ id: number }>(
    // scope: upstream the named fact and copies of its claim in its own source, which the caller already resolved in its scope
    `SELECT c.id FROM entity_facts t
       JOIN entity_facts c ON c.source_id = t.source_id AND c.visibility = t.visibility AND c.entity_slug = t.entity_slug
                          AND memrain_fact_claim_key(c.fact) = memrain_fact_claim_key(t.fact)
                          AND (c.id = t.id OR (c.forgotten_at IS NULL AND c.dimension IS NULL AND t.dimension IS NULL))
      WHERE t.id = $1
      ORDER BY c.id
      FOR UPDATE OF c`,
    [factId],
  );
  return r.rows.map(x => Number(x.id));
}

/**
 * How many live copies of a fact's claim (other than the fact) that a remote
 * caller can read are more trusted than `tier`. A plain read: a remote forget
 * calls it while holding the withdraw lock, where it must not wait on a row lock.
 */
export async function claimCopiesAbove(tx: Queryable, factId: number, tier: TrustTier): Promise<number> {
  const r = await tx.query<{ id: number }>(
    // scope: upstream copies of the claim in the named fact's own source, which the calling forget already resolved in its scope
    `SELECT c.id FROM entity_facts t
       JOIN entity_facts c ON c.source_id = t.source_id AND c.visibility = t.visibility AND c.entity_slug = t.entity_slug
                          AND memrain_fact_claim_key(c.fact) = memrain_fact_claim_key(t.fact)
                          AND c.id <> t.id AND c.forgotten_at IS NULL AND c.dimension IS NULL
      WHERE t.id = $1 AND t.dimension IS NULL AND ${factRemoteEligibleSql("c")}`,
    [factId],
  );
  const tiers = await factTiers(tx, r.rows.map(x => Number(x.id)));
  return [...tiers.values()].filter(t => trustRank(t) > trustRank(tier)).length;
}

/** Of these fact ids, the ones a remote caller may read (no diary origin, no owner-only lineage). */
async function remoteReadable(tx: Queryable, ids: readonly number[]): Promise<Set<number>> {
  const r = await tx.query<{ id: number }>(
    // scope: upstream fact ids the calling forget already locked in its own scope
    `SELECT c.id FROM entity_facts c WHERE c.id = ANY($1::bigint[]) AND ${factRemoteEligibleSql("c")}`,
    [[...ids]],
  );
  return new Set(r.rows.map(x => Number(x.id)));
}

/**
 * Inside a remote forget's transaction, with the fact and its claim's copies
 * locked (lockClaimCopies). A forget withdraws the claim and retires every
 * live copy of it in the source, so the caller must outrank (or match) each
 * copy, not only the one it named. When a copy is more trusted than the
 * caller, record (or reuse) the pending `forget` proposal on the most trusted
 * copy and return it; null when the forget may go ahead. Only copies the
 * caller can read count: one it cannot read is never named to it, and the
 * forget's sweep leaves it alone (forgetInTx caps the sweep at its tier).
 */
export async function contestForget(
  tx: Queryable,
  input: { factId: number; copies: readonly number[]; writerTier: TrustTier; principal: string | null; hasReason: boolean },
): Promise<{ proposal_id: number; fact_id: number; fact_tier: TrustTier } | null> {
  const others = input.copies.filter(id => id !== input.factId);
  const readable = others.length > 0 ? await remoteReadable(tx, others) : new Set<number>();
  const ids = [input.factId, ...others.filter(id => readable.has(id))];
  const tiers = await factTiers(tx, ids);
  let factId = input.factId;
  let factTier = tiers.get(input.factId);
  for (const id of ids) {
    const t = tiers.get(id);
    if (t !== undefined && (factTier === undefined || trustRank(t) > trustRank(factTier))) { factId = id; factTier = t; }
  }
  if (factTier === undefined || trustRank(input.writerTier) >= trustRank(factTier)) return null;
  const before = { old: { id: factId, tier: factTier }, new: { tier: input.writerTier }, ...(factId !== input.factId ? { asked_id: input.factId } : {}), ...(input.hasReason ? { has_reason: true } : {}) };
  const ins = await tx.query<{ id: number }>(
    // scope: upstream the fact the calling forget already locked in its own write scope
    `INSERT INTO trust_proposals (action, guard, source_id, target_id, related_id, before_state, proposer_principal)
     SELECT 'forget', 'remote_forget', f.source_id, $1, NULL, $2::text::jsonb, $3
       FROM entity_facts f WHERE f.id = $1
     ON CONFLICT (target_id) WHERE status = 'pending' AND action = 'forget' DO NOTHING
     RETURNING id`,
    [factId, JSON.stringify(before), input.principal],
  );
  let id = ins.rows[0]?.id;
  if (id === undefined) {
    const found = await tx.query<{ id: number }>(
      // scope: upstream the fact id the calling forget already resolved
      `SELECT id FROM trust_proposals WHERE target_id = $1 AND action = 'forget' AND status = 'pending'`,
      [factId],
    );
    id = found.rows[0]?.id;
  }
  if (id === undefined) throw new Error("forget proposal insert conflicted but no pending row was found");
  return { proposal_id: Number(id), fact_id: factId, fact_tier: factTier };
}

export interface TrustProposal {
  id: number;
  /** `forget`: a remote caller asked to forget the fact; accepting applies the forget. */
  action: TrustProposalAction;
  guard: TrustProposalGuard;
  source_id: string;
  entity_slug: string | null;
  dimension: string | null;
  target_id: number;
  /** Null for a `forget` proposal. */
  related_id: number | null;
  old_tier: TrustTier;
  /** The replacing fact's tier; for a `forget`, the tier of the caller that asked. */
  new_tier: TrustTier;
  /** Fact text, for the owner's own review surfaces only. */
  old_fact: string | null;
  new_fact: string | null;
  proposer_principal: string | null;
  status: TrustProposalStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

/** Proposals, oldest first: pending only, or every one. */
export async function listTrustProposals(
  q: Queryable,
  opts: { status?: "pending" | "all"; limit?: number } = {},
): Promise<TrustProposal[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const r = await q.query<Record<string, unknown>>(
    // scope: operator-only the owner's review queue
    `SELECT tp.id, tp.action, tp.guard, tp.source_id, tp.target_id, tp.related_id, tp.before_state, tp.proposer_principal, tp.status,
            tp.created_at::text AS created_at, tp.decided_at::text AS decided_at, tp.decided_by,
            o.entity_slug, o.dimension, o.fact AS old_fact, n.fact AS new_fact
       FROM trust_proposals tp
       LEFT JOIN entity_facts o ON o.id = tp.target_id
       LEFT JOIN entity_facts n ON n.id = tp.related_id
      WHERE ($1::text = 'all' OR tp.status = 'pending')
      ORDER BY tp.id
      LIMIT $2`,
    [opts.status ?? "pending", limit],
  );
  return r.rows.map((row) => {
    const before = (typeof row.before_state === "string" ? JSON.parse(row.before_state) : row.before_state) as {
      old: { tier: TrustTier }; new: { tier: TrustTier };
    };
    return {
      id: Number(row.id),
      action: row.action as TrustProposalAction,
      guard: row.guard as TrustProposalGuard,
      source_id: String(row.source_id),
      entity_slug: (row.entity_slug as string | null) ?? null,
      dimension: (row.dimension as string | null) ?? null,
      target_id: Number(row.target_id),
      related_id: row.related_id === null || row.related_id === undefined ? null : Number(row.related_id),
      old_tier: before.old.tier,
      new_tier: before.new.tier,
      old_fact: (row.old_fact as string | null) ?? null,
      new_fact: (row.new_fact as string | null) ?? null,
      proposer_principal: (row.proposer_principal as string | null) ?? null,
      status: row.status as TrustProposalStatus,
      created_at: String(row.created_at),
      decided_at: (row.decided_at as string | null) ?? null,
      decided_by: (row.decided_by as string | null) ?? null,
    };
  });
}

interface LockedFact { id: number; live: boolean; open: boolean; valid_from: string | null }

async function lockFacts(tx: Queryable, ids: readonly number[]): Promise<Map<number, LockedFact>> {
  const r = await tx.query<{ id: number; forgotten_at: string | null; valid_until: string | null; valid_from: string | null }>(
    // scope: operator-only the two facts one proposal names
    `SELECT id, forgotten_at::text AS forgotten_at, valid_until::text AS valid_until, valid_from::text AS valid_from
       FROM entity_facts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
    [[...ids]],
  );
  return new Map(r.rows.map(x => [Number(x.id), {
    id: Number(x.id), live: x.forgotten_at === null, open: x.forgotten_at === null && x.valid_until === null, valid_from: x.valid_from,
  }]));
}

/**
 * Applies the owner's decision on one proposal. `decidedBy` is recorded as
 * given (`operator` from the CLI, `admin` from the admin page).
 */
export async function decideTrustProposal(
  engine: Engine,
  id: number,
  decision: "accept" | "reject",
  decidedBy: string,
): Promise<{ id: number; status: TrustDecisionStatus }> {
  const status = await deadlockSafeTransaction(engine, async (tx): Promise<TrustDecisionStatus> => {
    // Facts first, then the proposal: the order a writer filing a proposal
    // takes them in (it holds the facts while it files), so the two never
    // deadlock. A forget proposal locks every live copy of its claim, as the
    // remote forget does (lockClaimCopies), since accepting it retires them.
    const peek = await tx.query<{ action: TrustProposalAction; target_id: number; related_id: number | null }>(
      // scope: operator-only a decision names one proposal by id from the owner's queue
      `SELECT action, target_id, related_id FROM trust_proposals WHERE id = $1`, [id]);
    const first = peek.rows[0];
    if (!first) return "not_found";
    if (first.action === "forget") await lockClaimCopies(tx, Number(first.target_id));
    else await lockFacts(tx, [first.target_id, first.related_id].filter((x): x is number => x !== null).map(Number));
    const p = await tx.query<{ action: TrustProposalAction; guard: TrustProposalGuard; status: string; target_id: number; related_id: number | null }>(
      // scope: operator-only a decision names one proposal by id from the owner's queue
      `SELECT action, guard, status, target_id, related_id FROM trust_proposals WHERE id = $1 FOR UPDATE`, [id]);
    const row = p.rows[0];
    if (!row) return "not_found";
    if (row.status !== "pending") return "already_decided";
    if (row.action === "forget") return decideForget(tx, id, Number(row.target_id), decision, decidedBy);
    const oldId = Number(row.target_id);
    const newId = Number(row.related_id);
    const facts = await lockFacts(tx, [oldId, newId]);
    const oldFact = facts.get(oldId);
    const newFact = facts.get(newId);
    const ontology = row.guard === "ontology";
    // The old value must still be what the write would replace, and the new
    // one still on file; anything else means the brain moved on.
    const applies = oldFact !== undefined && newFact !== undefined && newFact.live && (ontology ? oldFact.open : oldFact.live);
    const next: TrustProposalStatus = !applies ? "stale" : decision === "accept" ? "accepted" : "rejected";
    if (next === "accepted") {
      if (ontology) {
        await tx.query(`UPDATE entity_facts SET dim_status = 'active' WHERE id = $1`, [newId]);
        await tx.query(
          `UPDATE entity_facts SET valid_until = ${supersededValidUntilSql(2)}, superseded_by = $3 WHERE id = $1 AND valid_until IS NULL`,
          [oldId, newFact!.valid_from, newId],
        );
      } else {
        await tx.query(
          `UPDATE entity_facts
              SET forgotten_at = NOW(), forgotten_reason = $2, forgotten_cause = 'supersede', superseded_by = $3,
                  valid_until = ${supersededValidUntilSql(4)}
            WHERE id = $1 AND forgotten_at IS NULL`,
          [oldId, `superseded by fact ${newId} (owner accepted trust proposal ${id})`, newId, newFact!.valid_from],
        );
      }
    } else if (next === "rejected") {
      // A retirement, not a forget: the claim is not withdrawn, and the chain
      // points at the fact the owner kept.
      await tx.query(
        `UPDATE entity_facts
            SET forgotten_at = NOW(), forgotten_reason = $2, forgotten_cause = 'supersede', superseded_by = $3
          WHERE id = $1 AND forgotten_at IS NULL`,
        [newId, `kept fact ${oldId} (owner rejected trust proposal ${id})`, oldId],
      );
    }
    await tx.query(
      `UPDATE trust_proposals SET status = $2, decided_at = NOW(), decided_by = $3 WHERE id = $1 AND status = 'pending'`,
      [id, next, decidedBy],
    );
    return next;
  });
  return { id, status };
}

/**
 * A `forget` proposal: accepting forgets the fact as the caller asked (the
 * claim is withdrawn); rejecting keeps it. A fact no longer on file, or
 * already withdrawn, makes the proposal stale.
 */
async function decideForget(tx: Engine, id: number, factId: number, decision: "accept" | "reject", decidedBy: string): Promise<TrustDecisionStatus> {
  const fact = (await lockFacts(tx, [factId])).get(factId);
  let next: TrustProposalStatus = fact === undefined ? "stale" : decision === "accept" ? "accepted" : "rejected";
  if (next === "accepted") {
    const done = await forgetInTx(tx, factId, { reason: `forgotten by the owner (accepted trust proposal ${id})`, cause: "forget" });
    if (done === null) next = "stale";
  }
  await tx.query(
    `UPDATE trust_proposals SET status = $2, decided_at = NOW(), decided_by = $3 WHERE id = $1 AND status = 'pending'`,
    [id, next, decidedBy],
  );
  return next;
}
