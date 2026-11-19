/**
 * One trust vocabulary for pages, chunks and facts, most trusted first:
 *
 *   owner     the operator, the local CLI and the brain's own internal writers
 *   member    a member principal (`member:<id>`); no credential issues one yet
 *   agent     any other authenticated client: OAuth, PAT, the public bearer
 *   external  text that arrived from outside: a connector or importer source
 *
 * A row's tier is recorded at write time from the credential the dispatcher
 * resolved and the kind of the source it lands in, never from an argument.
 * `pages` and `entity_facts` carry it through the triggers in migration 158;
 * `documents` carry it when an authenticated client indexes inline text.
 *
 * Existing rows are not backfilled: their tier needs joins over sources and
 * page history, so a migration would have to rewrite every row. A NULL column
 * means "not recorded" and the effective tier is derived at read time from the
 * same evidence the outside-content framing uses (trust-frame.ts). That
 * derivation also stays a floor for recorded rows: a stored tier can lower the
 * effective tier, never raise it.
 *
 * Deterministic, no model involved.
 */
import { OperationError } from "./operation-error.ts";
import { PAGE_MIRROR_PATH_SQL, PAGE_TRUTH_PATH_SQL } from "./page-index.ts";
import { EXTERNAL_SOURCE_KINDS } from "./sources.ts";

export const TRUST_TIERS = ["owner", "member", "agent", "external"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

const RANK: Readonly<Record<TrustTier, number>> = { owner: 3, member: 2, agent: 1, external: 0 };
const OWNER_RANK = RANK.owner;


export function isTrustTier(value: unknown): value is TrustTier {
  return typeof value === "string" && (TRUST_TIERS as readonly string[]).includes(value);
}

export function trustRank(tier: TrustTier): number {
  return RANK[tier];
}

export function tierOfRank(rank: number): TrustTier {
  return TRUST_TIERS.find(t => RANK[t] === rank) ?? "external";
}

export function meetsMinTrust(tier: TrustTier, min: TrustTier | undefined): boolean {
  return min === undefined || RANK[tier] >= RANK[min];
}

/** `external` admits every tier, so it returns undefined: no predicate, no cache bypass. */
export function parseMinTrust(value: unknown, tool: string): TrustTier | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isTrustTier(value)) {
    throw new OperationError(
      "invalid_params",
      `${tool}: \`min_trust\` must be one of ${TRUST_TIERS.join(", ")}`,
      "Pass owner, member, agent or external, or omit min_trust to read every tier.",
    );
  }
  return value === "external" ? undefined : value;
}

/** The tier a source of `kind` gives the text written into it. */
export function sourceKindTier(kind: string | null | undefined): TrustTier {
  return kind && (EXTERNAL_SOURCE_KINDS as readonly string[]).includes(kind) ? "external" : "owner";
}

/** The less trusted of two tiers. */
export function lowerTier(a: TrustTier, b: TrustTier): TrustTier {
  return RANK[a] <= RANK[b] ? a : b;
}

/** The tier of a `written_by_principal` value; NULL is an internal writer. */
export function principalTier(principal: string | null | undefined): TrustTier {
  if (principal === undefined || principal === null || principal === "" || principal === "operator") return "owner";
  return principal.startsWith("member:") ? "member" : "agent";
}

// SQL builders. Every fragment is constant text with no parameters; aliases
// with a `tt_` prefix keep the nested lookups from capturing a caller's alias.
// PAGE_*_PATH_SQL name their page `p`, so the document lookup aliases it `p`.

const KINDS_SQL = `(${EXTERNAL_SOURCE_KINDS.map(k => `'${k}'`).join(", ")})`;

export function tierRankSql(tierExpr: string): string {
  return `CASE ${tierExpr} WHEN 'owner' THEN 3 WHEN 'member' THEN 2 WHEN 'agent' THEN 1 WHEN 'external' THEN 0 END`;
}

export function rankTierSql(rankExpr: string): string {
  return `CASE ${rankExpr} WHEN 3 THEN 'owner' WHEN 2 THEN 'member' WHEN 1 THEN 'agent' WHEN 0 THEN 'external' END`;
}

function principalRankSql(column: string): string {
  return `CASE WHEN ${column} IS NULL OR ${column} IN ('', 'operator') THEN 3 WHEN ${column} LIKE 'member:%' THEN 2 ELSE 1 END`;
}

function sourceRankSql(column: string): string {
  return `CASE WHEN EXISTS (SELECT 1 FROM sources tt_s WHERE tt_s.id = ${column} AND tt_s.kind IN ${KINDS_SQL}) THEN 0 ELSE 3 END`;
}

const stored = (column: string): string => `COALESCE(${tierRankSql(column)}, ${OWNER_RANK})`;

/** Effective rank of the page row aliased `alias`: stored tier, source kind, every contributor. */
export function pageRankSql(alias: string): string {
  return `LEAST(${stored(`${alias}.trust_tier`)},
    ${sourceRankSql(`${alias}.source_id`)},
    CASE WHEN ${alias}.compiled_truth->>'provider' = 'github' THEN 0 ELSE 3 END,
    COALESCE((SELECT MIN(CASE WHEN tt_v.written_by = 'connector-github' THEN 0 ELSE ${principalRankSql("tt_v.written_by_principal")} END)
      FROM page_versions tt_v WHERE tt_v.slug = ${alias}.slug AND tt_v.source_id = ${alias}.source_id), ${OWNER_RANK}))`;
}

/** Effective rank of the document row aliased `alias`, and so of each of its chunks. */
export function documentRankSql(alias: string): string {
  return `LEAST(${stored(`${alias}.trust_tier`)},
    ${sourceRankSql(`${alias}.source_id`)},
    COALESCE((SELECT MIN(${pageRankSql("p")}) FROM pages p WHERE p.source_id = COALESCE(${alias}.source_id, 'default')
      AND ${alias}.source_path IN (${PAGE_MIRROR_PATH_SQL}, ${PAGE_TRUTH_PATH_SQL}, p.slug, p.slug || '.md', p.slug || '.markdown')), ${OWNER_RANK}))`;
}

/** Effective rank of an `entity_facts` (or `timeline_events`, `withStored` false) row. */
export function factRankSql(alias: string, origin: string, withStored = true): string {
  return `LEAST(${withStored ? stored(`${alias}.trust_tier`) : OWNER_RANK},
    ${principalRankSql(`${alias}.written_by_principal`)},
    ${sourceRankSql(`${alias}.source_id`)},
    COALESCE((SELECT MIN(${pageRankSql("tt_p")}) FROM pages tt_p WHERE tt_p.source_id = ${alias}.source_id AND ${origin}), ${OWNER_RANK}),
    COALESCE((SELECT MIN(${documentRankSql("tt_d")}) FROM chunks tt_c JOIN documents tt_d ON tt_d.id = tt_c.document_id
      WHERE tt_c.id = ${alias}.source_chunk_id AND tt_d.source_id = ${alias}.source_id), ${OWNER_RANK}))`;
}

/**
 * The min_trust predicate for a query aliasing documents `d` (the search arms
 * and hydrate do). Empty when no floor was asked for.
 */
export function minTrustClause(params: unknown[], minTrust: TrustTier | undefined, alias = "d"): string {
  if (minTrust === undefined || minTrust === "external") return "";
  params.push(RANK[minTrust]);
  return ` AND (${documentRankSql(alias)}) >= $${params.length}::int`;
}
