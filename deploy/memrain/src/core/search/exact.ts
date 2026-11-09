import type { Storage } from "../storage.ts";
import { OperationError } from "../operation-error.ts";
import { andSourceScope } from "../source-scope.ts";
import { PAGE_MIRROR_PATH_SQL, PAGE_TRUTH_PATH_SQL } from "../page-index.ts";
import { quarantineFilterFragment } from "../quarantine.ts";
import { isStatementTimeoutError } from "../retry.ts";
import { pageRowFilterClauses, validatePageFilters } from "./filters.ts";

export interface ExactSearchOptions {
  caseSensitive?: boolean;
  slugPrefix?: string;
  type?: string;
  limit?: number;
  sourceIds?: string[];
  excludeDiary?: boolean;
}

export interface ExactSearchHit {
  slug: string;
  title: string | null;
  source_id: string;
  snippet: string;
}

export interface ExactSearchResult {
  hits: ExactSearchHit[];
  complete: boolean;
  /** Eligible pages examined; unknown when the statement was interrupted. */
  scanned: number | null;
  reason?: "limit" | "timeout";
}

export async function searchExact(storage: Storage, phrase: string, opts: ExactSearchOptions = {}): Promise<ExactSearchResult> {
  if (typeof phrase !== "string" || !phrase.trim() || phrase.length > 500) {
    throw new OperationError("invalid_params", "search_exact: phrase must contain 1 to 500 characters");
  }
  const limit = opts.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new OperationError("invalid_params", "search_exact: limit must be an integer from 1 to 200");
  }
  const filters = { types: opts.type ? [opts.type] : undefined, slugPrefix: opts.slugPrefix };
  validatePageFilters(filters);
  const params: unknown[] = [phrase, limit + 1];
  const scope = andSourceScope("p.source_id", opts.sourceIds, params);
  const filtered = pageRowFilterClauses(params, filters);
  let diary = "";
  if (opts.excludeDiary) {
    params.push(" \t\n\r\v\f\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF");
    diary = ` AND p.slug NOT LIKE 'life/diary/%' AND lower(btrim(p.type, $${params.length})) NOT IN ('diary', 'journal')`;
  }
  const body = "COALESCE(p.markdown_body, '')";
  const truth = "COALESCE(p.compiled_truth::text, '')";
  const position = (field: string) => opts.caseSensitive ? `strpos(${field}, $1)` : `strpos(lower(${field}), lower($1))`;
  const bodyPos = position(body);
  const truthPos = position(truth);
  // ponytail: this deliberately scans every eligible page (no text index).
  // The 2s statement deadline bounds Postgres work; the materialized rows hold
  // only metadata and a <=400-character snippet, never the full page bodies.
  try {
    return await storage.engine().transaction(async tx => {
      await tx.exec("SET LOCAL statement_timeout = '2000ms'");
      const result = await tx.query<{ scanned: number; hits: ExactSearchHit[] }>(
        `WITH scanned AS MATERIALIZED (
           SELECT p.slug, p.title, p.source_id,
             CASE WHEN ${bodyPos} > 0 THEN substring(${body} FROM greatest(1, ${bodyPos} - 100) FOR 400)
                  WHEN ${truthPos} > 0 THEN substring(${truth} FROM greatest(1, ${truthPos} - 100) FOR 400)
                  ELSE NULL END AS snippet
             FROM pages p WHERE p.deleted_at IS NULL${scope}${filtered}${diary}
              AND NOT EXISTS (SELECT 1 FROM documents d
                WHERE COALESCE(d.source_id, 'default') = p.source_id
                  AND d.source_path IN ((${PAGE_MIRROR_PATH_SQL}), (${PAGE_TRUTH_PATH_SQL}))
                  AND (d.archived OR NOT ${quarantineFilterFragment("d")}))
         ), matched AS (
           SELECT * FROM scanned WHERE snippet IS NOT NULL ORDER BY slug COLLATE "C" LIMIT $2
         ) SELECT (SELECT count(*)::int FROM scanned) AS scanned,
           COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.slug COLLATE "C") FROM matched m), '[]'::jsonb) AS hits`,
        params,
      );
      const row = result.rows[0];
      if (!row) throw new Error("search_exact: scan returned no result");
      const complete = row.hits.length <= limit;
      return { hits: row.hits.slice(0, limit), scanned: Number(row.scanned), complete,
        ...(!complete ? { reason: "limit" as const } : {}),
      };
    });
  } catch (error) {
    if (!isStatementTimeoutError(error)) throw error;
    return { hits: [], complete: false, scanned: null, reason: "timeout" };
  }
}
