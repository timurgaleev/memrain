import type { Engine } from "./engine/interface.ts";
import { factSourceEligibleSql } from "./quarantine.ts";
import { factRemoteEligibleSql } from "./fact-visibility.ts";
import { andSourceScope } from "./source-scope.ts";

export interface TypedConflictClaim {
  id: string;
  fact: string;
  value: string;
  valid_from: string;
  valid_until: string | null;
  source_slug: string | null;
  source_markdown_slug: string | null;
}

export interface TypedConflictGroup {
  entity_slug: string;
  source_id: string | null;
  attributed_to: string | null;
  metric: string;
  unit: string;
  period: string;
  month: string;
  claims: TypedConflictClaim[];
  truncated: boolean;
}

const GROUP_KEY = "entity_slug, source_id, attributed_to, metric, unit, period, month";

function sameGroup(a: string, b: string): string {
  return GROUP_KEY.split(", ").map((key) => `${a}.${key} IS NOT DISTINCT FROM ${b}.${key}`).join(" AND ");
}

/** Two claims of one group conflict when their values differ over a shared half-open interval. */
function conflicting(a: string, b: string): string {
  return `${sameGroup(a, b)} AND ${a}.claim_value <> ${b}.claim_value
           AND (${a}.valid_until IS NULL OR ${b}.valid_from < ${a}.valid_until)
           AND (${b}.valid_until IS NULL OR ${a}.valid_from < ${b}.valid_until)`;
}

/** Live typed claims the caller may see, normalized to their group key. */
function eligibleClaimsSql(scope: string, remote: boolean | undefined): string {
  return `SELECT f.id, f.fact, f.source_id, f.entity_slug, f.attributed_to,
              trim(both '_' from regexp_replace(lower(btrim(f.claim_metric)), '[^a-z0-9]+', '_', 'g')) AS metric,
              lower(btrim(f.claim_unit)) AS unit, lower(btrim(f.claim_period)) AS period,
              to_char(f.valid_from::timestamp, 'YYYY-MM') AS month,
              f.claim_value, f.valid_from, f.valid_until, f.source_slug, f.source_markdown_slug
         FROM entity_facts f
        WHERE f.forgotten_at IS NULL AND f.superseded_by IS NULL
          AND NOT f.consolidated AND f.consolidated_into IS NULL AND f.dimension IS NULL
          AND f.claim_value IS NOT NULL AND f.claim_value::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND btrim(f.claim_metric) <> '' AND btrim(f.claim_unit) <> '' AND btrim(f.claim_period) <> ''
          AND f.valid_from IS NOT NULL AND isfinite(f.valid_from)
          AND (f.valid_until IS NULL OR (isfinite(f.valid_until) AND f.valid_until > f.valid_from))
          AND ${factSourceEligibleSql("f")}${scope}
          ${remote ? `AND f.visibility = 'world' AND ${factRemoteEligibleSql("f")}` : ""}`;
}

export const CONTESTED_WITH_MAX = 5;

/**
 * For facts already chosen for a response, the ids of the claims each one
 * conflicts with: the rule and visibility of `findTypedConflicts`, at most
 * five per fact, smallest first. One query for the whole set; a fact with no
 * conflict is absent from the map.
 */
export async function contestedWith(
  engine: Engine,
  factIds: readonly number[],
  opts: { sourceIds?: string[]; remote?: boolean } = {},
): Promise<Map<number, number[]>> {
  const ids = [...new Set(factIds)];
  if (ids.length === 0) return new Map();
  const params: unknown[] = [];
  const scope = andSourceScope("f.source_id", opts.sourceIds, params);
  params.push(ids);
  const idsParam = `$${params.length}::bigint[]`;
  const { rows } = await engine.query<{ id: string; peers: string[] }>(
    `WITH eligible AS MATERIALIZED (
       ${eligibleClaimsSql(scope, opts.remote)}
          AND f.entity_slug IN (SELECT t.entity_slug FROM entity_facts t WHERE t.id = ANY(${idsParam}))
     )
     SELECT a.id::text AS id, peers.ids AS peers
       FROM eligible a CROSS JOIN LATERAL (
         SELECT array_agg(p.id::text ORDER BY p.id) AS ids FROM (
           SELECT b.id FROM eligible b WHERE ${conflicting("a", "b")} ORDER BY b.id LIMIT ${CONTESTED_WITH_MAX}
         ) p
       ) peers
      WHERE a.id = ANY(${idsParam}) AND a.metric <> '' AND peers.ids IS NOT NULL`,
    params,
  );
  return new Map(rows.map((r) => [Number(r.id), r.peers.map(Number)]));
}

export async function findTypedConflicts(engine: Engine, opts: {
  sourceIds?: string[];
  remote?: boolean;
  entitySlug?: string;
  limit?: number;
} = {}): Promise<{ groups: TypedConflictGroup[]; truncated: boolean }> {
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 20)));
  if (!Number.isFinite(limit)) throw new Error("typed conflict limit must be finite");
  const params: unknown[] = [];
  let scope = andSourceScope("f.source_id", opts.sourceIds, params);
  if (opts.entitySlug !== undefined) {
    params.push(opts.entitySlug);
    scope += ` AND f.entity_slug = $${params.length}`;
  }
  params.push(limit + 1);
  const groupKey = GROUP_KEY;
  const { rows } = await engine.query<Omit<TypedConflictGroup, "truncated">>(
    `WITH eligible AS MATERIALIZED (
       ${eligibleClaimsSql(scope, opts.remote)}
     ), participating AS MATERIALIZED (
       SELECT a.* FROM eligible a WHERE a.metric <> '' AND EXISTS (
         SELECT 1 FROM eligible b WHERE ${conflicting("a", "b")}
       )
     ), groups AS (
       SELECT DISTINCT ${groupKey} FROM participating
        ORDER BY ${groupKey} LIMIT $${params.length}
     )
     SELECT g.*, evidence.claims
       FROM groups g CROSS JOIN LATERAL (
         WITH first_claim AS (
           SELECT a.* FROM participating a WHERE ${sameGroup("a", "g")} ORDER BY a.id LIMIT 1
         ), witness AS (
           SELECT b.id FROM participating b CROSS JOIN first_claim a
            WHERE ${conflicting("a", "b")}
            ORDER BY b.id LIMIT 1
         )
         SELECT jsonb_agg(jsonb_build_object(
           'id', p.id::text, 'fact', p.fact, 'value', p.claim_value::text,
           'valid_from', p.valid_from::text, 'valid_until', p.valid_until::text,
           'source_slug', p.source_slug, 'source_markdown_slug', p.source_markdown_slug
         ) ORDER BY p.witness DESC, p.id) AS claims
         FROM (SELECT a.*, a.id = (SELECT id FROM witness) AS witness
           FROM participating a WHERE ${sameGroup("a", "g")} ORDER BY witness DESC, a.id LIMIT 21) p
       ) evidence ORDER BY ${groupKey.split(", ").map((key) => `g.${key}`).join(", ")}`,
    params,
  );
  return {
    groups: rows.slice(0, limit).map((group) => ({
      ...group, claims: group.claims.slice(0, 20).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1),
      truncated: group.claims.length > 20,
    })),
    truncated: rows.length > limit,
  };
}
