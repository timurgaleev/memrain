import { OperationError } from "./operation-error.ts";
import { assertSqlAlias, factSourceEligibleSql } from "./quarantine.ts";

export function readLimit(limit: number | undefined): number {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new OperationError("invalid_params", "limit must be an integer from 1 to 100");
  }
  return limit ?? 20;
}

export function nonDiaryPageSql(alias: string): string {
  assertSqlAlias(alias);
  const whitespace = " \t\n\r\v\f\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";
  return `${alias}.slug NOT LIKE 'life/diary/%' AND lower(btrim(COALESCE(${alias}.type, ''), '${whitespace}')) NOT IN ('diary', 'journal')`;
}

export function eligiblePageSql(alias: string, remote: boolean): string {
  assertSqlAlias(alias);
  const owner = `COALESCE(${alias}.source_id, 'default')`;
  const path = `CASE WHEN ${owner} = 'default' THEN ${alias}.slug ELSE ${owner} || '/' || ${alias}.slug END`;
  return `${alias}.deleted_at IS NULL ${remote ? `AND ${nonDiaryPageSql(alias)}` : ""}
    AND NOT EXISTS (SELECT 1 FROM documents held WHERE COALESCE(held.source_id, 'default') = ${owner}
      AND held.source_path IN ('page://' || ${path}, 'page-truth://' || ${path})
      AND (held.deleted_at IS NOT NULL OR COALESCE(held.frontmatter, '{}'::jsonb) ? 'quarantine'))`;
}

export function eligibleFactSql(alias: string, remote: boolean): string {
  assertSqlAlias(alias);
  return `${alias}.forgotten_at IS NULL AND ${alias}.superseded_by IS NULL AND ${alias}.consolidated_into IS NULL
    AND ${alias}.dimension IS NULL AND ${factSourceEligibleSql(alias)}
    ${remote ? `AND ${alias}.visibility = 'world' AND NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY[${alias}.entity_slug, ${alias}.source_slug, ${alias}.source_markdown_slug]) origin(slug)
      WHERE origin.slug LIKE 'life/diary/%' OR EXISTS (SELECT 1 FROM pages diary
        WHERE diary.slug = origin.slug AND diary.source_id = ${alias}.source_id AND NOT (${nonDiaryPageSql("diary")})))` : ""}`;
}
