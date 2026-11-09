import { assertSqlAlias, quarantineFilterFragment } from "../quarantine.ts";
import { normalizeScope } from "../source-scope.ts";

/** Legacy canonical grades cannot establish which editable claim they judged. */
export function currentTakeGradeSql(grade: string, take: string): string {
  assertSqlAlias(grade);
  assertSqlAlias(take);
  return `(left(${grade}.evidence_signature, 71) = 'claim:' || encode(sha256(convert_to(${take}.claim_text, 'UTF8')), 'hex') || ':'
    OR (${take}.row_num IS NULL AND ${grade}.evidence_signature NOT LIKE 'claim:%'))`;
}

/** A canonical page's existing mirrors may hold it before a subsequent write. */
export function takePageEligibleSql(alias: string, excludeDiary = false): string {
  assertSqlAlias(alias);
  const path = `CASE WHEN ${alias}.source_id = 'default' THEN ${alias}.slug ELSE ${alias}.source_id || '/' || ${alias}.slug END`;
  return `${alias}.deleted_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM documents take_mirror
     WHERE take_mirror.source_id = ${alias}.source_id
       AND take_mirror.source_path IN ('page://' || ${path}, 'page-truth://' || ${path})
       AND (take_mirror.deleted_at IS NOT NULL OR NOT (${quarantineFilterFragment("take_mirror")}))
  )${excludeDiary ? ` AND ${alias}.slug NOT LIKE 'life/diary/%' AND lower(btrim(${alias}.type)) NOT IN ('diary','journal')` : ""}`;
}

/** row_num is the discriminator; a foreign document named like a slug is never its owner. */
export function takeOwnerSourceSql(alias: string, excludeDiary = false): string {
  assertSqlAlias(alias);
  return `(CASE WHEN ${alias}.row_num IS NOT NULL THEN (
    SELECT take_page.source_id FROM pages take_page WHERE take_page.slug = ${alias}.source_ref
      AND ${takePageEligibleSql("take_page", excludeDiary)}
  ) ELSE (
    SELECT take_doc.source_id FROM documents take_doc WHERE take_doc.id = ${alias}.source_ref
      AND take_doc.deleted_at IS NULL AND ${quarantineFilterFragment("take_doc")}
      AND NOT EXISTS (
        SELECT 1 FROM pages take_mirrored_page
         WHERE take_mirrored_page.source_id = take_doc.source_id
           AND take_doc.source_path IN (
             'page://' || CASE WHEN take_doc.source_id = 'default' THEN take_mirrored_page.slug ELSE take_doc.source_id || '/' || take_mirrored_page.slug END,
             'page-truth://' || CASE WHEN take_doc.source_id = 'default' THEN take_mirrored_page.slug ELSE take_doc.source_id || '/' || take_mirrored_page.slug END)
           AND (take_mirrored_page.deleted_at IS NOT NULL
             ${excludeDiary ? "OR take_mirrored_page.slug LIKE 'life/diary/%' OR lower(btrim(take_mirrored_page.type)) IN ('diary','journal')" : ""})
      )
      ${excludeDiary ? `AND take_doc.source_path NOT LIKE '%/life/diary/%'
        AND lower(btrim(COALESCE(take_doc.frontmatter->>'type',''))) NOT IN ('diary','journal')` : ""}
  ) END)`;
}

export function takeOwnerFilterSql(alias: string, params: unknown[], options: {
  sourceIds?: readonly string[]; excludeDiary?: boolean;
} = {}): string {
  const owner = takeOwnerSourceSql(alias, options.excludeDiary);
  const sources = normalizeScope(options.sourceIds);
  if (sources !== undefined) {
    params.push(sources);
    return ` AND ${owner} = ANY($${params.length}::text[])`;
  }
  if (options.excludeDiary) return ` AND ${owner} IS NOT NULL`;
  // Preserve unscoped legacy rows without inventing an owner for grading or scoped reads.
  return ` AND (${owner} IS NOT NULL OR (${alias}.row_num IS NULL AND NOT EXISTS (
    SELECT 1 FROM documents take_origin WHERE take_origin.id = ${alias}.source_ref
      AND (take_origin.source_id IS NOT NULL OR take_origin.deleted_at IS NOT NULL OR NOT (${quarantineFilterFragment("take_origin")})))))`;
}

export function takePrincipalSql(alias: string): string {
  assertSqlAlias(alias);
  return `(CASE WHEN ${alias}.row_num IS NOT NULL THEN (
    SELECT pv.written_by_principal FROM page_versions pv JOIN pages pp ON pp.slug = pv.slug AND pp.source_id = pv.source_id
     WHERE pp.slug = ${alias}.source_ref AND pp.deleted_at IS NULL ORDER BY pv.version_n DESC LIMIT 1
  ) ELSE NULL END)`;
}
