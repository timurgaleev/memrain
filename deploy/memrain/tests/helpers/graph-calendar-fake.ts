/**
 * A recorded Microsoft 365 account for the Outlook calendar tests: the
 * identity platform's token endpoint, Graph's /me and /me/calendars, and the
 * calendar view delta, event and instances endpoints the adapter reads, each
 * answering from tests/fixtures/connectors/outlook-calendar.json (shaped after
 * the documented resources). Nothing leaves the process; every request is
 * recorded with its Prefer header so a test can assert what was asked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../../src/core/connectors/client.ts";

type Json = Record<string, unknown>;

export const GRAPH_FIXTURES = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "connectors", "outlook-calendar.json"), "utf8"),
) as Record<string, Json>;

export const GRAPH_ACCESS_TOKEN = String(GRAPH_FIXTURES.token!.access_token);
export const GRAPH_REFRESH_TOKEN = String(GRAPH_FIXTURES.token!.refresh_token);
export const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export interface GraphCall {
  url: URL;
  method: string;
  body: URLSearchParams | null;
  authorization: string | null;
  prefer: string | null;
}

/** A canned answer: a fixture name (status 200) or an explicit status and body. */
export type GraphAnswer = string | { status: number; body: Json | string; retryAfter?: string };

export interface GraphWorld {
  /** Answer for a calendar view delta request: `calendar` is "primary" or the calendar id; `query` the request's query, `prefer` its Prefer header. */
  delta: (calendar: string, query: URLSearchParams, prefer: string | null) => GraphAnswer;
  /** Answer for a plain calendar view of a calendar other than the default one. */
  view?: (calendar: string, query: URLSearchParams) => GraphAnswer;
  /** Answer for GET of one event. */
  event?: (calendar: string, eventId: string) => GraphAnswer;
  /** Answer for a series' instances. */
  instances?: (calendar: string, eventId: string, query: URLSearchParams) => GraphAnswer;
  /** The `scope` the token endpoint grants on a code exchange (the fixture's when unset). */
  grantedScope?: string;
  me?: Json;
  refuseRefresh?: boolean;
  calls: GraphCall[];
}

function answer(a: GraphAnswer): Response {
  if (typeof a === "string") {
    const body = GRAPH_FIXTURES[a];
    if (body === undefined) throw new Error(`no fixture '${a}'`);
    return Response.json(body);
  }
  const headers = a.retryAfter === undefined ? undefined : { "retry-after": a.retryAfter };
  return typeof a.body === "string"
    ? new Response(a.body, { status: a.status, ...(headers ? { headers } : {}) })
    : Response.json(a.body, { status: a.status, ...(headers ? { headers } : {}) });
}

const NOT_FOUND: GraphAnswer = { status: 404, body: GRAPH_FIXTURES.errorItemNotFound! };

export function graphFetch(world: GraphWorld): FetchFn {
  return async (raw, init) => {
    const url = new URL(raw);
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization");
    const body = typeof init.body === "string" ? new URLSearchParams(init.body) : null;
    world.calls.push({ url, method: init.method ?? "GET", body, authorization, prefer: headers.get("prefer") });

    if (url.origin === "https://login.microsoftonline.com" && url.pathname.endsWith("/oauth2/v2.0/token")) {
      if (body?.get("grant_type") === "refresh_token") {
        if (world.refuseRefresh) return answer({ status: 400, body: GRAPH_FIXTURES.tokenRefreshInvalidGrant! });
        return Response.json(GRAPH_FIXTURES.token);
      }
      return Response.json({ ...GRAPH_FIXTURES.token, ...(world.grantedScope === undefined ? {} : { scope: world.grantedScope }) });
    }
    if (url.origin !== "https://graph.microsoft.com") return new Response("not found", { status: 404 });
    if (authorization !== `Bearer ${GRAPH_ACCESS_TOKEN}`) return answer({ status: 401, body: GRAPH_FIXTURES.errorInvalidAuthenticationToken! });
    const p = url.pathname;
    if (p === "/v1.0/me") return Response.json(world.me ?? GRAPH_FIXTURES.me);
    if (p === "/v1.0/me/calendars") return answer("calendars");
    // Graph v1.0 documents the calendar view delta for the default calendar only.
    if (p === "/v1.0/me/calendarView/delta") return answer(world.delta("primary", url.searchParams, headers.get("prefer")));
    const list = /^\/v1\.0\/me\/calendars\/([^/]+)\/calendarView$/.exec(p);
    if (list) return answer(world.view?.(decodeURIComponent(list[1]!), url.searchParams) ?? NOT_FOUND);
    const ev = /^\/v1\.0\/me(?:\/calendars\/([^/]+))?\/events\/([^/]+)(\/instances)?$/.exec(p);
    if (ev) {
      const calendar = ev[1] === undefined ? "primary" : decodeURIComponent(ev[1]);
      const eventId = decodeURIComponent(ev[2]!);
      if (ev[3] !== undefined) return answer(world.instances?.(calendar, eventId, url.searchParams) ?? NOT_FOUND);
      return answer(world.event?.(calendar, eventId) ?? NOT_FOUND);
    }
    return answer(NOT_FOUND);
  };
}

/** The calendar view delta calls of a recorded run, in order. */
export function deltaCalls(world: GraphWorld): GraphCall[] {
  return world.calls.filter(c => /\/calendarView\/delta$/.test(c.url.pathname));
}
