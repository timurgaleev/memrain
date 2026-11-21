/**
 * Search mode bundles — conservative / balanced / tokenmax.
 *
 * One env (`MEMRAIN_SEARCH_MODE`) picks a complete knob set so an operator
 * stops flipping per-knob envs. Resolution chain per knob, later never wins
 * over earlier:
 *
 *   per-call SearchOptions → per-knob env (explicit "1"/"0") → mode bundle
 *
 * DELIBERATE: the default mode is `conservative`, which equals today's
 * defaults — every paid/experimental stage OFF and NO token cap. memrain's
 * cost posture is default-OFF; `balanced` (graph + rerank + relational ON,
 * 12000-token cap) and `tokenmax` are one env away.
 *
 * The resolved flag set is folded into the query-cache ranking signature
 * so flipping a mode or knob re-keys the cache instead of serving a stale
 * pre-flip ordering — see query-cache.ts and the suffix hybrid.ts appends
 * for per-call resolved values.
 */

export type SearchMode = "conservative" | "balanced" | "tokenmax";

export const SEARCH_MODES: readonly SearchMode[] = [
  "conservative",
  "balanced",
  "tokenmax",
];

export interface ModeBundle {
  /** LLM query expansion (paid Haiku per search). */
  expansion: boolean;
  /** Two-pass Haiku rerank (paid). */
  rerank: boolean;
  /** Graph-signals post-fusion stage. */
  graphSignals: boolean;
  /** Cosine re-score blend (one embeddings fetch per query). */
  cosineRescore: boolean;
  /** Relational-recall 4th RRF arm. */
  relationalArm: boolean;
  /** Default returned-content token cap; undefined = no cap. */
  tokenBudget: number | undefined;
}

export const MODE_BUNDLES: Readonly<Record<SearchMode, Readonly<ModeBundle>>> =
  Object.freeze({
    // memrain's live defaults, unchanged: all optional stages off, no cap.
    conservative: Object.freeze({
      expansion: false,
      rerank: false,
      graphSignals: false,
      cosineRescore: false,
      relationalArm: false,
      tokenBudget: undefined,
    }),
    // Balanced posture mapped onto memrain knobs: deterministic + paid-rerank
    // stages on, expansion still off (negligible measured lift), Sonnet-sized
    // token cap. With rerank and the relational arm both on, the rerank pins
    // relational pages back at the head (relational-pin.ts) and is skipped
    // when the head is already certain (confidence-grade.ts).
    balanced: Object.freeze({
      expansion: false,
      rerank: true,
      graphSignals: true,
      cosineRescore: true,
      relationalArm: true,
      tokenBudget: 12_000,
    }),
    // Power-user ceiling: everything on, no cap.
    tokenmax: Object.freeze({
      expansion: true,
      rerank: true,
      graphSignals: true,
      cosineRescore: true,
      relationalArm: true,
      tokenBudget: undefined,
    }),
  });

export const DEFAULT_SEARCH_MODE: SearchMode = "conservative";

export function isSearchMode(x: unknown): x is SearchMode {
  return typeof x === "string" && (SEARCH_MODES as readonly string[]).includes(x);
}

/** Active mode from MEMRAIN_SEARCH_MODE; unknown/unset → conservative. */
export function resolveSearchMode(
  envValue: string | undefined = process.env["MEMRAIN_SEARCH_MODE"],
): SearchMode {
  const requested = (envValue ?? "").trim().toLowerCase();
  return isSearchMode(requested) ? requested : DEFAULT_SEARCH_MODE;
}

/** The active mode's bundle. */
export function activeModeBundle(): Readonly<ModeBundle> {
  return MODE_BUNDLES[resolveSearchMode()];
}

/**
 * Resolve one boolean knob: per-call value wins; else an explicit per-knob
 * env "1"/"0" wins; else the mode bundle decides. Any other env value falls
 * through to the bundle (matches the pre-mode `=== "1"` semantics when the
 * bundle default is false).
 */
export function resolveKnob(
  perCall: boolean | undefined,
  envValue: string | undefined,
  bundleValue: boolean,
): boolean {
  if (perCall !== undefined) return perCall;
  if (envValue === "1") return true;
  if (envValue === "0") return false;
  return bundleValue;
}

/**
 * Is LLM query expansion active for the current configuration?
 *
 * Two of the three bundles leave it off, so a set-shaped question answered by
 * `search` returns a plausible non-empty result the caller has no reason to
 * doubt. Surfaces that steer the caller elsewhere need to know whether that is
 * actually the case right now, rather than assuming the default.
 */
export function expansionActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveKnob(undefined, env["MEMRAIN_QUERY_EXPANSION"], activeModeBundle().expansion);
}
