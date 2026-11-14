import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { PAGE_MIRROR_PATH_SQL, PAGE_TRUTH_PATH_SQL } from "./page-index.ts";

export interface ExternalTrust { trust?: "external" }

/** Escaping also covers forged closing tags and pre-escaped entities. */
export function frameExternal(text: string): string {
  return `<external_content trust="external">\n${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n</external_content>`;
}

const EXTERNAL_KINDS = "('github', 'mailbox', 'calendar', 'webhook', 'chat', 'meeting')";
const externalPrincipal = (column: string): string => `${column} IS NOT NULL AND ${column} NOT IN ('', 'operator')`;

// A manual edit does not certify every earlier contributor's text as trusted.
const EXTERNAL_PAGE = `(EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.kind IN ${EXTERNAL_KINDS})
  OR p.compiled_truth->>'provider' = 'github'
  OR EXISTS (SELECT 1 FROM page_versions v WHERE v.slug = p.slug AND v.source_id = p.source_id
    AND ((${externalPrincipal("v.written_by_principal")}) OR v.written_by = 'connector-github')))`;

const EXTERNAL_DOCUMENT = `(EXISTS (SELECT 1 FROM sources s WHERE s.id = d.source_id AND s.kind IN ${EXTERNAL_KINDS})
  OR EXISTS (SELECT 1 FROM pages p WHERE p.source_id = COALESCE(d.source_id, 'default')
    AND d.source_path IN (${PAGE_MIRROR_PATH_SQL}, ${PAGE_TRUTH_PATH_SQL}, p.slug, p.slug || '.md', p.slug || '.markdown')
    AND ${EXTERNAL_PAGE}))`;

export interface TrustSelection {
  chunks?: readonly string[];
  pages?: readonly string[];
  facts?: readonly (number | string)[];
  events?: readonly number[];
}

/** Only IDs already selected by an authorized read enter this lookup. Re-scope
 *  here too; neither principals nor source identities leave this module. */
export async function readExternalTrust(engine: Engine, selected: TrustSelection, sourceIds?: readonly string[]): Promise<{
  chunks: Set<string>; pages: Set<string>; facts: Set<number>; events: Set<number>;
}> {
  const params: unknown[] = [];
  const arms: string[] = [];
  const add = (ids: readonly unknown[] | undefined, kind: string, table: string, key: string, scope: string, condition: string, numeric = false) => {
    if (!ids?.length) return;
    params.push(ids);
    const idParam = `$${params.length}::${numeric ? "bigint" : "text"}[]`;
    const filter = andSourceScope(scope, sourceIds, params);
    arms.push(`SELECT '${kind}' AS kind, ${key}::text AS id FROM ${table}
      WHERE ${key} = ANY(${idParam})${filter} AND (${condition})`);
  };
  add(selected.chunks, "chunks", "chunks c JOIN documents d ON d.id = c.document_id", "c.id", "d.source_id", EXTERNAL_DOCUMENT);
  add(selected.pages, "pages", "pages p", "p.slug", "p.source_id", EXTERNAL_PAGE);
  for (const kind of ["facts", "events"] as const) {
    const origin = kind === "facts" ? "p.slug IN (r.source_slug, r.source_markdown_slug)" : "p.slug = r.slug";
    add(selected[kind], kind, `${kind === "facts" ? "entity_facts" : "timeline_events"} r`, "r.id", "r.source_id", `
      (${externalPrincipal("r.written_by_principal")})
      OR EXISTS (SELECT 1 FROM sources s WHERE s.id = r.source_id AND s.kind IN ${EXTERNAL_KINDS})
      OR EXISTS (SELECT 1 FROM pages p WHERE p.source_id = r.source_id AND ${origin} AND ${EXTERNAL_PAGE})
      OR EXISTS (SELECT 1 FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.id = r.source_chunk_id AND d.source_id = r.source_id AND ${EXTERNAL_DOCUMENT})`, true);
  }
  const rows = arms.length ? (await engine.query<{ kind: string; id: string }>(arms.join(" UNION ALL "), params)).rows : [];
  return {
    chunks: new Set(rows.filter(r => r.kind === "chunks").map(r => r.id)),
    pages: new Set(rows.filter(r => r.kind === "pages").map(r => r.id)),
    facts: new Set(rows.filter(r => r.kind === "facts").map(r => Number(r.id))),
    events: new Set(rows.filter(r => r.kind === "events").map(r => Number(r.id))),
  };
}

export async function markExternalChunks<T extends { chunkId: string }>(engine: Engine, hits: readonly T[], sourceIds?: readonly string[]): Promise<Array<T & ExternalTrust>> {
  const external = await readExternalTrust(engine, { chunks: hits.map(h => h.chunkId) }, sourceIds);
  return hits.map(h => external.chunks.has(h.chunkId) ? { ...h, trust: "external" } : h);
}

export function frameMarkedContent<T extends { content: string } & ExternalTrust>(hit: T): T {
  return hit.trust === "external" ? { ...hit, content: frameExternal(hit.content) } : hit;
}
