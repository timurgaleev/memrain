/**
 * A recorded Google account for connector tests: the OAuth token, userinfo
 * and revoke endpoints and the Calendar v3 endpoints the adapter reads, each
 * answering from tests/fixtures/connectors/google-calendar.json (shaped after
 * the documented resources). Nothing leaves the process; every request is
 * recorded so a test can assert what was asked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../../src/core/connectors/client.ts";

type Json = Record<string, unknown>;

export const GOOGLE_FIXTURES = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "connectors", "google-calendar.json"), "utf8"),
) as Record<string, Json>;

export const GOOGLE_ACCESS_TOKEN = String(GOOGLE_FIXTURES.token!.access_token);
export const GOOGLE_REFRESH_TOKEN = String(GOOGLE_FIXTURES.token!.refresh_token);

export interface GoogleCall {
  url: URL;
  method: string;
  body: URLSearchParams | null;
  authorization: string | null;
}

/** A canned answer: a fixture name (status 200) or an explicit status and body. */
export type Answer = string | { status: number; body: Json | string; retryAfter?: string };

export interface GoogleWorld {
  /** Answer for `events.list` on a calendar, given its query. */
  events: (calendarId: string, query: URLSearchParams) => Answer;
  /** Answer for `events.instances` of a series. */
  instances?: (calendarId: string, eventId: string, query: URLSearchParams) => Answer;
  /** Answer for `events.get`. */
  event?: (calendarId: string, eventId: string) => Answer;
  /** The `scope` the token endpoint grants on a code exchange. */
  grantedScope?: string;
  userinfo?: Json;
  refuseRefresh?: boolean;
  calls: GoogleCall[];
}

function answer(a: Answer): Response {
  if (typeof a === "string") {
    const body = GOOGLE_FIXTURES[a];
    if (body === undefined) throw new Error(`no fixture '${a}'`);
    return Response.json(body);
  }
  const headers = a.retryAfter === undefined ? undefined : { "retry-after": a.retryAfter };
  return typeof a.body === "string"
    ? new Response(a.body, { status: a.status, ...(headers ? { headers } : {}) })
    : Response.json(a.body, { status: a.status, ...(headers ? { headers } : {}) });
}

const NOT_FOUND = { status: 404, body: { error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } } };

export function googleFetch(world: GoogleWorld): FetchFn {
  return async (raw, init) => {
    const url = new URL(raw);
    const authorization = new Headers(init.headers).get("authorization");
    const body = typeof init.body === "string" ? new URLSearchParams(init.body) : null;
    world.calls.push({ url, method: init.method ?? "GET", body, authorization });

    if (raw === "https://oauth2.googleapis.com/token") {
      if (body?.get("grant_type") === "refresh_token") {
        if (world.refuseRefresh) return answer({ status: 400, body: GOOGLE_FIXTURES.tokenRefreshInvalidGrant! });
        const { refresh_token: _drop, ...rest } = GOOGLE_FIXTURES.token!;
        return Response.json(rest);
      }
      return Response.json({ ...GOOGLE_FIXTURES.token, ...(world.grantedScope === undefined ? {} : { scope: world.grantedScope }) });
    }
    if (raw === "https://oauth2.googleapis.com/revoke") return new Response("{}", { status: 200 });
    if (raw === "https://openidconnect.googleapis.com/v1/userinfo") {
      if (authorization !== `Bearer ${GOOGLE_ACCESS_TOKEN}`) return new Response("{}", { status: 401 });
      return Response.json(world.userinfo ?? GOOGLE_FIXTURES.userinfo);
    }
    if (url.origin === "https://www.googleapis.com") {
      if (authorization !== `Bearer ${GOOGLE_ACCESS_TOKEN}`) return answer({ status: 401, body: { error: { code: 401, message: "Invalid Credentials" } } });
      if (url.pathname === "/calendar/v3/users/me/calendarList") return answer("calendarList");
      const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+)(\/instances)?)?$/.exec(url.pathname);
      if (m) {
        const calendarId = decodeURIComponent(m[1]!);
        if (m[2] === undefined) return answer(world.events(calendarId, url.searchParams));
        const eventId = decodeURIComponent(m[2]);
        if (m[3] !== undefined) return answer(world.instances?.(calendarId, eventId, url.searchParams) ?? NOT_FOUND);
        return answer(world.event?.(calendarId, eventId) ?? NOT_FOUND);
      }
    }
    return new Response("not found", { status: 404 });
  };
}

/** The `events.list` calls of a recorded run, in order. */
export function eventListCalls(world: GoogleWorld): URLSearchParams[] {
  return world.calls
    .filter(c => /^\/calendar\/v3\/calendars\/[^/]+\/events$/.test(c.url.pathname))
    .map(c => c.url.searchParams);
}
