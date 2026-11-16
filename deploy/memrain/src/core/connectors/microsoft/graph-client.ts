/**
 * The little the Outlook mail and calendar adapters share about Microsoft
 * Graph, on top of the fixed-origin connector client (client.ts): the origin,
 * the Prefer header, how a paging or delta link becomes a request path, and
 * how a lost sync state reads.
 *
 *   - Graph pages a collection with an absolute `@odata.nextLink`, and ends a
 *     delta round with an `@odata.deltaLink` the next round starts from. Both
 *     carry their state in the query string. A link is only followed when it
 *     names the Graph origin and the v1.0 root; anything else is dropped, so a
 *     crafted link cannot walk the token to another host or API version.
 *   - A delta token Graph no longer holds comes back as `410 Gone` or as a
 *     4xx with the code `syncStateNotFound` (learn.microsoft.com/graph/
 *     delta-query-overview, "Synchronization reset" and "Token duration"):
 *     the caller starts the round over.
 *   - Throttling is a 429 (sometimes a 503) with Retry-After; the connector
 *     client waits that out up to its cap (learn.microsoft.com/graph/throttling).
 */
import type { ConnectorClient, ConnectorResponse } from "../client.ts";

export const GRAPH_API_ORIGIN = "https://graph.microsoft.com";
export const GRAPH_ROOT = "/v1.0";
/** A link longer than this is not stored in a cursor or followed. */
export const MAX_GRAPH_LINK_CHARS = 8192;

const LOST_STATE_CODES = new Set(["syncstatenotfound", "syncstateinvalid", "resyncrequired"]);

export interface PreferOptions {
  /** `odata.maxpagesize`: items per page of a list or delta response. */
  maxPageSize?: number;
  /** Bodies as plain text (`outlook.body-content-type="text"`). */
  textBody?: boolean;
  /** Ids that stay the same when an item moves between folders. */
  immutableIds?: boolean;
}

export function preferHeader(opts: PreferOptions): string {
  const parts: string[] = [];
  if (opts.maxPageSize !== undefined) parts.push(`odata.maxpagesize=${Math.max(1, Math.trunc(opts.maxPageSize))}`);
  if (opts.textBody) parts.push('outlook.body-content-type="text"');
  if (opts.immutableIds) parts.push('IdType="ImmutableId"');
  return parts.join(", ");
}

export function graphGet(client: ConnectorClient, path: string, opts: { prefer?: string; maxBytes?: number } = {}): Promise<ConnectorResponse> {
  return client.get(path, {
    ...(opts.prefer ? { headers: { Prefer: opts.prefer } } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });
}

/** An `@odata.nextLink` / `@odata.deltaLink` as a path on the Graph origin, or null when it may not be followed. */
export function graphLinkPath(link: unknown): string | null {
  if (typeof link !== "string" || link.length === 0 || link.length > MAX_GRAPH_LINK_CHARS) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.origin !== GRAPH_API_ORIGIN || url.username || url.password || url.hash) return null;
  if (!url.pathname.startsWith(`${GRAPH_ROOT}/`)) return null;
  return `${url.pathname}${url.search}`;
}

/** The `error.code` of a Graph error body, when it carries one. */
export function graphErrorCode(res: ConnectorResponse): string | null {
  const body = res.errorBody;
  if (body === null || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (err === null || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Graph no longer has the delta state the request named: start the round over. */
export function isSyncStateLost(res: ConnectorResponse): boolean {
  if (res.class === "ok") return false;
  if (res.status === 410) return true;
  const code = graphErrorCode(res);
  return res.status >= 400 && res.status < 500 && code !== null && LOST_STATE_CODES.has(code.toLowerCase());
}
