import { assertSqlAlias } from "./quarantine.ts";
import { ownerOnlyLineageSql } from "./owner-only.ts";

/**
 * A remote fact read must not expose a diary through its subject or
 * provenance, nor a fact derived from an owner-only source on a shared brain.
 */
export function factRemoteEligibleSql(alias = "entity_facts"): string {
  assertSqlAlias(alias);
  return `${ownerOnlyLineageSql("fact", `${alias}.id`)} AND NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY[${alias}.entity_slug, ${alias}.source_slug, ${alias}.source_markdown_slug]) AS origin(slug)
     WHERE origin.slug LIKE 'life/diary/%'
        OR EXISTS (SELECT 1 FROM pages diary
                    WHERE diary.slug = origin.slug AND diary.source_id = ${alias}.source_id
                      AND lower(btrim(diary.type)) IN ('diary', 'journal'))
  )`;
}
