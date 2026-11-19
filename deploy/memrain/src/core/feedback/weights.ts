/**
 * How ratings become a page's weight, and the weight a ranking multiplier.
 *
 * A page's weight w is a smoothed mean of its votes around a neutral prior:
 *
 *   w = 0.5 + 0.5 · Σ(c·r) / (1 + Σc)
 *
 * over the votes still standing (a withdrawn 0 counts as none), with
 * r ∈ {-1, +1} and c a vote's strength: the voter's tier (owner 1,
 * member 0.5, agent 0.25), times 0.25 for an implicit signal, times 0.5 per
 * FEEDBACK_HALF_LIFE_DAYS of age, times 0.5 when the page changed since the
 * vote. The prior of strength 1 keeps one rater from moving a page further
 * than its own strength allows: a single agent can shift w by at most 0.1.
 *
 * Search multiplies the ordering score by m = 1 + λ·2·(w − 0.5), so m stays
 * within [1 − λ, 1 + λ] and a page nobody rated (w = 0.5) ranks as before.
 */
import { FEEDBACK_HALF_LIFE_DAYS } from "./settings.ts";

export const NEUTRAL_WEIGHT = 0.5;
/** λ: the most feedback can move a score, as a fraction of it. */
export const FEEDBACK_INFLUENCE = 0.1;

export type VoterTier = "owner" | "member" | "agent";
export type FeedbackSignal = "explicit" | "implicit";

const TIER_STRENGTH: Record<VoterTier, number> = { owner: 1, member: 0.5, agent: 0.25 };
const IMPLICIT_STRENGTH = 0.25;

export interface Vote {
  rating: -1 | 0 | 1;
  tier: VoterTier;
  signal: FeedbackSignal;
  ageDays: number;
  /** The page changed since the vote. */
  stale: boolean;
}

export function voteStrength(v: Vote): number {
  const age = Math.max(0, v.ageDays);
  return TIER_STRENGTH[v.tier]
    * (v.signal === "implicit" ? IMPLICIT_STRENGTH : 1)
    * 0.5 ** (age / FEEDBACK_HALF_LIFE_DAYS)
    * (v.stale ? 0.5 : 1);
}

export function aggregateWeight(votes: readonly Vote[]): number {
  let sum = 0;
  let strength = 0;
  for (const v of votes) {
    // A withdrawn vote is no vote: it must not pull the others toward neutral.
    if (v.rating === 0) continue;
    const c = voteStrength(v);
    sum += c * v.rating;
    strength += c;
  }
  if (strength === 0) return NEUTRAL_WEIGHT;
  return NEUTRAL_WEIGHT + NEUTRAL_WEIGHT * (sum / (1 + strength));
}

/** A weight learned on an older version of the page, read halfway back to neutral. */
export function editedWeight(weight: number): number {
  return NEUTRAL_WEIGHT + (weight - NEUTRAL_WEIGHT) / 2;
}

export function feedbackMultiplier(weight: number, influence = FEEDBACK_INFLUENCE): number {
  return 1 + influence * 2 * (weight - NEUTRAL_WEIGHT);
}
