/**
 * Newer mentions — what links to an entity and is dated after the entity's own
 * page, newest first. A context-pack card carries them, so a note that
 * corrects or extends what the page says is in front of the reader on the
 * first call instead of after a backlinks lookup.
 *
 * Two referrer kinds: live pages with an edge to the entity (dated by
 * `updated_at`), and, for the operator only, indexed documents whose chunks
 * mention the entity as a `[[wikilink]]` (dated by content date, else
 * `updated_at`) — vault notes carry their links that way, not as edges. A
 * remote caller gets page referrers only, each through the caller's fence.
 * Hidden pages and hidden documents never count.
 *
 * On by default; MEMRAIN_CONTEXT_NEWER_MENTIONS=0 turns it off.
 */
import type { Storage } from "../storage.ts";
import { entityId } from "../entities.ts";
import { liveEndpointSql } from "../links.ts";
import { andSourceScope } from "../source-scope.ts";
import { visibilityClause } from "../visibility.ts";

export const NEWER_MENTIONS_CAP = 8;

export interface NewerMention {
  date: string;
  slug: string;
  title: string | null;
}

export function newerMentionsEnabled(
  env: string | undefined = process.env.MEMRAIN_CONTEXT_NEWER_MENTIONS,
): boolean {
  return env?.trim() !== "0";
}

export interface NewerMentionsOptions {
  /** Tenant read scope. Omitted -> whole brain; `[]` -> nothing. */
  sourceIds?: string[];
  /** True when the caller must not see this page. */
  isFenced?: ((slug: string) => Promise<boolean>) | null;
  /** Add document referrers (operator only). */
  includeDocuments?: boolean;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

export async function readNewerMentions(
  storage: Storage,
  slug: string,
  opts: NewerMentionsOptions = {},
): Promise<NewerMention[]> {
  const engine = storage.engine();
  const pageParams: unknown[] = [slug];
  const pageScope = andSourceScope("e.source_id", opts.sourceIds, pageParams);
  const page = await engine.query<{ since: string; title: string | null }>(
    `SELECT to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since, e.title
       FROM pages e WHERE e.slug = $1 AND e.deleted_at IS NULL${pageScope}`,
    pageParams,
  );
  const entity = page.rows[0];
  if (!entity) return [];
  // Over-fetch so referrers the fence removes leave the cap filled.
  const fetch = NEWER_MENTIONS_CAP * 3;

  const params: unknown[] = [slug, fetch];
  const linkScope = andSourceScope("l.source_id", opts.sourceIds, params);
  const refScope = andSourceScope("p.source_id", opts.sourceIds, params);
  const pages = await engine.query<{ slug: string; title: string | null; date: string }>(
    `SELECT p.slug, p.title, to_char(p.updated_at AT TIME ZONE 'UTC', ${ISO}) AS date
       FROM pages e
       JOIN links l ON l.target_slug = e.slug
       JOIN pages p ON p.slug = l.source_slug AND p.deleted_at IS NULL
      WHERE e.slug = $1
        AND p.slug <> e.slug
        AND p.updated_at > e.updated_at
        AND ${liveEndpointSql("p.slug")}${linkScope}${refScope}
      GROUP BY p.slug, p.title, p.updated_at
      ORDER BY p.updated_at DESC, p.slug
      LIMIT $2`,
    params,
  );
  const out: NewerMention[] = [];
  for (const r of pages.rows) {
    if (opts.isFenced && (await opts.isFenced(r.slug))) continue;
    out.push({ date: r.date, slug: r.slug, title: r.title });
  }

  // entityId() folds non-ASCII names together and truncates long ones, so
  // only a short ASCII name gives a mention id that is this entity's alone.
  const names = [slug.slice(slug.lastIndexOf("/") + 1), entity.title ?? ""]
    .filter((n) => n.length > 0 && n.length <= 60 && /^[\x20-\x7E]*$/.test(n));
  if (opts.includeDocuments && names.length > 0) {
    const ids = [...new Set(names.map((n) => entityId("wikilink", n)))];
    const docParams: unknown[] = [ids, entity.since, fetch];
    const docScope = andSourceScope("d.source_id", opts.sourceIds, docParams);
    const docs = await engine.query<{ slug: string; title: string | null; date: string }>(
      `SELECT d.source_path AS slug, d.title,
              to_char(COALESCE(d.effective_date, d.updated_at) AT TIME ZONE 'UTC', ${ISO}) AS date
         FROM entity_mentions em
         JOIN chunks c ON c.id = em.chunk_id
         JOIN documents d ON d.id = c.document_id
        WHERE em.entity_id = ANY($1::text[])
          AND d.source_path NOT LIKE 'page://%' AND d.source_path NOT LIKE 'page-truth://%'
          AND COALESCE(d.effective_date, d.updated_at) > $2::timestamptz
          AND ${visibilityClause("d")}${docScope}
        GROUP BY d.source_path, d.title, d.effective_date, d.updated_at
        ORDER BY COALESCE(d.effective_date, d.updated_at) DESC, d.source_path
        LIMIT $3`,
      docParams,
    );
    for (const r of docs.rows) out.push({ date: r.date, slug: r.slug, title: r.title });
  }

  const seen = new Set<string>();
  return out
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug))
    .filter((m) => !seen.has(m.slug) && seen.add(m.slug))
    .slice(0, NEWER_MENTIONS_CAP);
}
