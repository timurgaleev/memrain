/**
 * skillpack/routing-eval.ts — a deterministic, LLM-free router over skill
 * triggers, and the score it earns on the pack's `routing-eval.jsonl` cases.
 *
 * An agent picks a skill by matching the request against the catalog's
 * `triggers`. This router does the literal version of that: a trigger
 * matches when its normalised words appear as a run of whole words in the
 * normalised request, and the longest matching trigger wins. Two skills tied
 * at that length is an ambiguous route. Free to run, so it is a CI gate: a
 * trigger edit that steals another skill's cases, or a new trigger that
 * collides with an old one, moves the score.
 */
import type { RoutingCase } from "../skillopt/benchmark.ts";

export interface SkillTriggers {
  slug: string;
  triggers: readonly string[];
}

export type RouteResult =
  | { kind: "match"; slug: string; trigger: string }
  | { kind: "ambiguous"; slugs: string[]; trigger: string }
  | { kind: "none" };

/**
 * Lowercase, every run of non-letter/non-digit characters folded to one
 * space, trimmed. Two triggers that normalise the same are the same trigger.
 */
export function normalizeTrigger(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Whether normalised `needle` is a run of whole words inside normalised `hay`. */
export function containsWords(hay: string, needle: string): boolean {
  if (needle.length === 0) return false;
  return ` ${hay} `.includes(` ${needle} `);
}

/** Route one request to a skill by its longest matching trigger. */
export function routeByTriggers(query: string, skills: readonly SkillTriggers[]): RouteResult {
  const q = normalizeTrigger(query);
  let bestLength = 0;
  let bestTrigger = "";
  let winners = new Set<string>();
  for (const skill of skills) {
    for (const raw of skill.triggers) {
      const t = normalizeTrigger(raw);
      if (t.length < bestLength || !containsWords(q, t)) continue;
      if (t.length > bestLength) {
        bestLength = t.length;
        bestTrigger = t;
        winners = new Set();
      }
      winners.add(skill.slug);
    }
  }
  if (winners.size === 0) return { kind: "none" };
  const slugs = [...winners].sort();
  if (slugs.length === 1) return { kind: "match", slug: slugs[0]!, trigger: bestTrigger };
  return { kind: "ambiguous", slugs, trigger: bestTrigger };
}

export type RoutingOutcome = "correct" | "missed" | "wrong" | "ambiguous" | "false_positive";

export interface RoutingFailure {
  intent: string;
  expected_skill: string | null;
  outcome: Exclude<RoutingOutcome, "correct">;
  /** The skill(s) the router picked; empty when it picked none. */
  got: string[];
}

export interface RoutingScore {
  total: number;
  correct: number;
  missed: number;
  wrong: number;
  ambiguous: number;
  false_positives: number;
  /** correct / total, 0 for an empty benchmark. */
  accuracy: number;
  failures: RoutingFailure[];
}

type ScoredCase = Pick<RoutingCase, "intent" | "expected_skill" | "ambiguous_with">;

/**
 * Judge one case. A route is correct when it lands on the expected skill or
 * on a skill the case names in `ambiguous_with`; an ambiguous route is
 * correct when every tied skill is one of those and the expected skill is
 * among them. A negative case (expected null) is correct only with no route.
 */
export function judgeRoute(c: ScoredCase, route: RouteResult): RoutingOutcome {
  if (c.expected_skill === null) return route.kind === "none" ? "correct" : "false_positive";
  if (route.kind === "none") return "missed";
  const accepted = new Set([c.expected_skill, ...c.ambiguous_with]);
  if (route.kind === "match") return accepted.has(route.slug) ? "correct" : "wrong";
  const fits = route.slugs.includes(c.expected_skill) && route.slugs.every((s) => accepted.has(s));
  return fits ? "correct" : "ambiguous";
}

/** Route every case and tally the outcomes. */
export function scoreBenchmark(
  cases: readonly ScoredCase[],
  skills: readonly SkillTriggers[],
): RoutingScore {
  const score: RoutingScore = {
    total: cases.length,
    correct: 0,
    missed: 0,
    wrong: 0,
    ambiguous: 0,
    false_positives: 0,
    accuracy: 0,
    failures: [],
  };
  for (const c of cases) {
    const route = routeByTriggers(c.intent, skills);
    const outcome = judgeRoute(c, route);
    if (outcome === "correct") {
      score.correct++;
      continue;
    }
    if (outcome === "false_positive") score.false_positives++;
    else score[outcome]++;
    score.failures.push({
      intent: c.intent,
      expected_skill: c.expected_skill,
      outcome,
      got: route.kind === "match" ? [route.slug] : route.kind === "ambiguous" ? route.slugs : [],
    });
  }
  score.accuracy = score.total === 0 ? 0 : score.correct / score.total;
  return score;
}
