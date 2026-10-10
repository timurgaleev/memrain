/**
 * Ranking changes that ship off by default and are promoted one at a time,
 * after a paired A/B on the live corpus says they help. Each flag is read on
 * every call so an eval run can flip it per query.
 */
export const RANKING_FLAGS = [
  "METADATA_GATE",
  "ENTITY_TRUTH_SOFT",
  "KEYWORD_OR_RETRY",
  "PAGE_FUSION",
  "KEYWORD_CONFIDENCE",
  "EXACT_LOOKUP",
] as const;

export type RankingFlag = (typeof RANKING_FLAGS)[number];

export const RANKING_FLAG_ENV: readonly string[] = RANKING_FLAGS.map((f) => `MEMRAIN_RANK_${f}`);

export function rankFlag(flag: RankingFlag, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[`MEMRAIN_RANK_${flag}`];
  return raw === "1" || raw?.toLowerCase() === "true";
}

/** "" when every flag is off, so flags-off cache keys stay byte-identical. */
export function rankFlagsSignature(env: NodeJS.ProcessEnv = process.env): string {
  const on = RANKING_FLAGS.filter((f) => rankFlag(f, env));
  return on.length === 0 ? "" : `:W6=${on.join(",")}`;
}
