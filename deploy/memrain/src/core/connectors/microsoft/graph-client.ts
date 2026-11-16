/**
 * What every Microsoft Graph adapter shares on top of the connector client:
 * the one origin it talks to, Graph's paging links read as paths on that
 * origin, Graph's error codes, and Graph's date-times.
 *
 * Graph pages with absolute `@odata.nextLink` / `@odata.deltaLink` URLs. A
 * link is followed only as a path on https://graph.microsoft.com, so a crafted
 * link cannot walk the bearer token to another host (the connector client
 * refuses anything else as well).
 *
 * A delta state token Graph no longer holds is answered 410 Gone (a reset) or
 * a 4xx whose error code is syncStateNotFound and friends; either means start
 * the round again (learn.microsoft.com/graph/delta-query-overview,
 * "Synchronization reset" and "Token duration").
 */
import type { ConnectorResponse } from "../client.ts";

export const GRAPH_ORIGIN = "https://graph.microsoft.com";
/** Largest Graph response body read; past it the page fails instead of filling memory. */
export const GRAPH_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Longest paging link kept in a cursor. */
export const MAX_GRAPH_LINK = 16 * 1024;

const SYNC_RESET_CODES = new Set(["syncstatenotfound", "syncstateinvalid", "resyncrequired"]);

/**
 * A Graph paging link as a path on the Graph origin; null when it is not a
 * string, is too long, or points anywhere else.
 */
export function graphLinkPath(link: unknown): string | null {
  if (typeof link !== "string" || link === "" || link.length > MAX_GRAPH_LINK) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.origin !== GRAPH_ORIGIN || url.username !== "" || url.password !== "" || url.hash !== "") return null;
  return `${url.pathname}${url.search}`;
}

/** Whether a stored path is one this client would request: on the Graph origin, under /v1.0/. */
export function isGraphPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/v1.0/") && !path.includes("\\") && path.length <= MAX_GRAPH_LINK
    && graphLinkPath(`${GRAPH_ORIGIN}${path}`) === path;
}

/** Graph's `error.code` of a failed response, when it sent one. */
export function graphErrorCode(res: ConnectorResponse): string | null {
  const body = res.errorBody;
  if (body === null || typeof body !== "object") return null;
  const error = (body as Record<string, unknown>).error;
  if (error === null || typeof error !== "object") return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

/** Graph no longer holds the delta round's state: the round starts over. */
export function isSyncReset(res: ConnectorResponse): boolean {
  if (res.status === 410) return true;
  if (res.status < 400 || res.status >= 500) return false;
  const code = graphErrorCode(res);
  return code !== null && SYNC_RESET_CODES.has(code.toLowerCase());
}

const GRAPH_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?$/;
const UTC_ZONES = new Set(["utc", "etc/utc", "coordinated universal time"]);

/**
 * A Graph dateTimeTimeZone as ISO-8601 UTC (`...Z`), or, for an all-day
 * event, its date. Requests carry `Prefer: outlook.timezone="UTC"`, so any
 * other zone is a response this adapter did not ask for: null, not a guess.
 */
export function graphTime(v: unknown, allDay: boolean): string | null {
  if (v === null || typeof v !== "object") return null;
  const { dateTime, timeZone } = v as Record<string, unknown>;
  if (typeof dateTime !== "string" || typeof timeZone !== "string" || !UTC_ZONES.has(timeZone.trim().toLowerCase())) return null;
  const m = GRAPH_DATETIME.exec(dateTime);
  if (m === null) return null;
  if (allDay) return m[1]!;
  const at = `${m[1]}T${m[2]}.${(m[3] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  return Number.isFinite(Date.parse(at)) ? new Date(Date.parse(at)).toISOString() : null;
}
