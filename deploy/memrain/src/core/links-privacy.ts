export function linkDiarySql(alias: string, excluded: boolean | undefined, params: unknown[]): string {
  if (!excluded) return "";
  if (!/^[a-z_]\w*$/i.test(alias)) throw new Error("Invalid link SQL alias");
  params.push(" \t\n\r\v\f\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF");
  return ` AND ${alias}.source_slug NOT LIKE 'life/diary/%' AND ${alias}.target_slug NOT LIKE 'life/diary/%'
    AND NOT EXISTS (SELECT 1 FROM pages dp WHERE dp.slug IN (${alias}.source_slug, ${alias}.target_slug)
      AND lower(btrim(dp.type, $${params.length})) IN ('diary', 'journal'))`;
}
