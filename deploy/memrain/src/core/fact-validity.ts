/** Close a known validity interval without inventing dates or extending its end. */
export function supersededValidUntilSql(newDateParam: number): string {
  if (!Number.isSafeInteger(newDateParam) || newDateParam < 1) throw new Error("invalid date parameter");
  const date = `$${newDateParam}::date`;
  return `CASE WHEN ${date} > valid_from AND (valid_until IS NULL OR ${date} < valid_until)
               THEN ${date} ELSE valid_until END`;
}
