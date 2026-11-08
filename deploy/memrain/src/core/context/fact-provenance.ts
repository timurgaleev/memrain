import type { Engine } from "../engine/interface.ts";
import { andSourceScope } from "../source-scope.ts";
import { packFactText } from "../fact-text.ts";

type Origin = "operator" | "agent" | "extractor" | "ingest";

/** Read only a category, never the credential carried in the audit column. */
export async function factProvenance(engine: Engine, ids: readonly number[], sourceIds?: readonly string[]): Promise<Map<number, Origin>> {
  if (ids.length === 0) return new Map();
  const params: unknown[] = [ids];
  const scope = andSourceScope("source_id", sourceIds, params);
  const { rows } = await engine.query<{ id: number | string; origin: Origin | null }>(
    `SELECT id, CASE
       WHEN written_by IN ('facts-extract', 'extract-facts', 'extract-conversation-facts') THEN 'extractor'
       WHEN written_by IN ('memrain:facts-fence', 'memex:facts-fence', 'ingest') OR written_by LIKE 'ingest:%' THEN 'ingest'
       WHEN written_by_principal LIKE 'client:%' OR written_by LIKE 'client:%' OR written_by = 'public' THEN 'agent'
       WHEN written_by_principal = 'operator' OR written_by = 'operator' THEN 'operator'
       ELSE NULL END AS origin
       FROM entity_facts WHERE id = ANY($1::bigint[])${scope}`, params);
  return new Map(rows.filter(r => r.origin !== null).map(r => [Number(r.id), r.origin!]));
}

export function contextFactText(f: { id: number; fact: string; attributed_to: string | null }, origins: ReadonlyMap<number, Origin>): string {
  const origin = origins.get(f.id);
  return `${origin ? `[${origin}] ` : ""}${packFactText(f)}`;
}
