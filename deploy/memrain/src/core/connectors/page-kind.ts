/**
 * Which pages a connector wrote. The paid phases that predate connectors
 * (the facts backfill, on-write extraction, the contextual-LLM tier) leave
 * them alone: mail, calendar, chat and meeting text is outside text, and the
 * connector pipeline extracts from it with its own extractor and caps.
 *
 * A page is a connector page when its type carries the connector prefix
 * (render.ts names every kind `connector-<kind>`) or when a connector item
 * maps onto it, so a renderer that ever emits a plain type stays covered.
 */
import type { Engine } from "../engine/interface.ts";

const CONNECTOR_TYPE_PREFIX = "connector-";

export function isConnectorPageType(type: string | null | undefined): boolean {
  return typeof type === "string" && type.startsWith(CONNECTOR_TYPE_PREFIX);
}

/** SQL true for a connector page; `p` is the alias of a `pages` row. */
export function connectorPageSql(p: string): string {
  return `(${p}.type LIKE '${CONNECTOR_TYPE_PREFIX}%' OR EXISTS (
            SELECT 1 FROM connector_items ci
              JOIN connector_accounts ca ON ca.id = ci.account_id
             WHERE ci.page_slug = ${p}.slug AND ca.source_id = ${p}.source_id))`;
}

/**
 * Whether the page mirrored at `sourcePath` (`page://<slug>` or
 * `page://<source>/<slug>`) is a connector page. A path that names no live
 * page is not one.
 */
export async function isConnectorPageMirror(engine: Engine, sourcePath: string): Promise<boolean> {
  if (!sourcePath.startsWith("page://")) return false;
  const rest = sourcePath.slice("page://".length);
  const slash = rest.indexOf("/");
  const asSourced = slash > 0 ? { source: rest.slice(0, slash), slug: rest.slice(slash + 1) } : null;
  // scope: operator-only the indexer classifies the one page it is mirroring, by its own path
  const r = await engine.query<{ hit: number }>(
    `SELECT 1 AS hit FROM pages p
      WHERE p.deleted_at IS NULL
        AND ((p.source_id = 'default' AND p.slug = $1) OR (p.source_id = $2 AND p.slug = $3))
        AND ${connectorPageSql("p")}
      LIMIT 1`,
    [rest, asSourced?.source ?? null, asSourced?.slug ?? null],
  );
  return r.rows.length > 0;
}
