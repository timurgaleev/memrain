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
  const groupKey = "entity_slug, source_id, attributed_to, metric, unit, period, month";
  const sameGroup = (a: string, b: string) => groupKey.split(", ")
    .map((key) => `${a}.${key} IS NOT DISTINCT FROM ${b}.${key}`).join(" AND ");
  const { rows } = await engine.query<Omit<TypedConflictGroup, "truncated">>(
    `WITH eligible AS MATERIALIZED (
       SELECT f.id, f.fact, f.source_id, f.entity_slug, f.attributed_to,
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
          ${opts.remote ? `AND f.visibility = 'world' AND ${factRemoteEligibleSql("f")}` : ""}
     ), participating AS MATERIALIZED (
       SELECT a.* FROM eligible a WHERE a.metric <> '' AND EXISTS (
         SELECT 1 FROM eligible b WHERE ${sameGroup("a", "b")}
           AND a.claim_value <> b.claim_value
           AND (a.valid_until IS NULL OR b.valid_from < a.valid_until)
           AND (b.valid_until IS NULL OR a.valid_from < b.valid_until)
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
            WHERE ${sameGroup("a", "b")} AND a.claim_value <> b.claim_value
              AND (a.valid_until IS NULL OR b.valid_from < a.valid_until)
              AND (b.valid_until IS NULL OR a.valid_from < b.valid_until)
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
