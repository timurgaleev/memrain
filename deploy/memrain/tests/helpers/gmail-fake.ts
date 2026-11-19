/**
 * A recorded Gmail mailbox for connector tests. Message resources, history
 * pages and error bodies come from tests/fixtures/connectors/google-gmail.json
 * (shaped after the documented resources); `messages.list` and `threads.get`
 * answer from the world's current message set, so a test can trash, delete or
 * add mail between runs. The OAuth token, userinfo and revoke endpoints answer
 * as the calendar fake does. Nothing leaves the process; every request is
 * recorded.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../../src/core/connectors/client.ts";
import { GOOGLE_ACCESS_TOKEN, GOOGLE_FIXTURES } from "./google-calendar-fake.ts";

type Json = Record<string, unknown>;

export const GMAIL_FIXTURES = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "connectors", "google-gmail.json"), "utf8"),
) as Record<string, unknown>;

export interface RawMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: string;
  payload: Json;
  [k: string]: unknown;
}

/** A canned answer: a fixture name (status 200) or an explicit status and body. */
export type GmailAnswer = string | { status: number; body: unknown };

export interface GmailCall {
  url: URL;
  method: string;
  authorization: string | null;
}

export interface GmailWorld {
  messages: RawMessage[];
  /** Answer for `users.getProfile`. */
  profile: GmailAnswer;
  /** Answer for `history.list`. */
  history: (startHistoryId: string, pageToken: string | null) => GmailAnswer;
  /** Answer that replaces `threads.get` for one thread, when it returns one. */
  thread?: (threadId: string) => GmailAnswer | undefined;
  /** Answer that replaces `messages.list`, when it returns one. */
  list?: (query: URLSearchParams) => GmailAnswer | undefined;
  /** Largest page `messages.list` answers, whatever maxResults asks. */
  pageSize?: number;
  /** The Gmail API refuses the access token (401). */
  expired?: boolean;
  refuseRefresh?: boolean;
  grantedScope?: string;
  calls: GmailCall[];
}

export function fixtureMessages(): RawMessage[] {
  return structuredClone(GMAIL_FIXTURES.messages) as RawMessage[];
}

function answer(a: GmailAnswer): Response {
  if (typeof a === "string") {
    const body = GMAIL_FIXTURES[a];
    if (body === undefined) throw new Error(`no gmail fixture '${a}'`);
    return Response.json(body);
  }
  return typeof a.body === "string" ? new Response(a.body, { status: a.status }) : Response.json(a.body, { status: a.status });
}

/** Gmail's search, as far as the connector uses it: after:/before: epoch seconds and the exclusions. */
function matches(m: RawMessage, q: string): boolean {
  const secs = Number(m.internalDate) / 1000;
  for (const term of q.split(/\s+/).filter(Boolean)) {
    const [k, v] = term.split(":") as [string, string];
    if (k === "after" && !(secs >= Number(v))) return false;
    if (k === "before" && !(secs < Number(v))) return false;
    if (k === "-in" && m.labelIds.includes(v.toUpperCase())) return false;
    if (k === "-category" && m.labelIds.includes(`CATEGORY_${v.toUpperCase()}`)) return false;
  }
  // messages.list leaves spam and trash out unless asked.
  return !m.labelIds.includes("SPAM") && !m.labelIds.includes("TRASH");
}

const pageToken = (offset: number) => Buffer.from(`offset:${offset}`).toString("base64url");
const offsetOf = (token: string | null) => (token === null ? 0 : Number(Buffer.from(token, "base64url").toString().split(":")[1]));

/** A thread's history id: changes whenever any of its messages or labels does. */
export function threadHistoryId(messages: readonly RawMessage[]): string {
  return String(BigInt(`0x${createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 12)}`));
}

export function gmailFetch(world: GmailWorld): FetchFn {
  return async (raw, init) => {
    const url = new URL(raw);
    const authorization = new Headers(init.headers).get("authorization");
    world.calls.push({ url, method: init.method ?? "GET", authorization });
    const body = typeof init.body === "string" ? new URLSearchParams(init.body) : null;

    if (raw === "https://oauth2.googleapis.com/token") {
      if (body?.get("grant_type") === "refresh_token") {
        if (world.refuseRefresh) return Response.json(GOOGLE_FIXTURES.tokenRefreshInvalidGrant, { status: 400 });
        const { refresh_token: _drop, ...rest } = GOOGLE_FIXTURES.token!;
        return Response.json(rest);
      }
      return Response.json({ ...GOOGLE_FIXTURES.token, ...(world.grantedScope === undefined ? {} : { scope: world.grantedScope }) });
    }
    if (raw === "https://oauth2.googleapis.com/revoke") return new Response("{}", { status: 200 });
    if (raw === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json(GOOGLE_FIXTURES.userinfo);
    if (url.origin !== "https://gmail.googleapis.com") return new Response("not found", { status: 404 });
    if (world.expired || authorization !== `Bearer ${GOOGLE_ACCESS_TOKEN}`) return answer({ status: 401, body: GMAIL_FIXTURES.error401 });

    const p = url.pathname;
    if (p === "/gmail/v1/users/me/profile") return answer(world.profile);
    if (p === "/gmail/v1/users/me/history") {
      return answer(world.history(url.searchParams.get("startHistoryId") ?? "", url.searchParams.get("pageToken")));
    }
    if (p === "/gmail/v1/users/me/messages") {
      const override = world.list?.(url.searchParams);
      if (override !== undefined) return answer(override);
      const q = url.searchParams.get("q") ?? "";
      const size = Math.min(Number(url.searchParams.get("maxResults") ?? "100"), world.pageSize ?? Number.POSITIVE_INFINITY);
      const hits = world.messages.filter(m => matches(m, q)).sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
      const from = offsetOf(url.searchParams.get("pageToken"));
      const slice = hits.slice(from, from + size).map(m => ({ id: m.id, threadId: m.threadId }));
      return Response.json({
        ...(slice.length > 0 ? { messages: slice } : {}),
        ...(from + size < hits.length ? { nextPageToken: pageToken(from + size) } : {}),
        resultSizeEstimate: hits.length,
      });
    }
    const t = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(p);
    if (t) {
      const id = decodeURIComponent(t[1]!);
      const override = world.thread?.(id);
      if (override !== undefined) return answer(override);
      const msgs = world.messages.filter(m => m.threadId === id).sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
      if (msgs.length === 0) return answer({ status: 404, body: GMAIL_FIXTURES.error404Thread });
      return Response.json({ id, historyId: threadHistoryId(msgs), messages: msgs });
    }
    return new Response("not found", { status: 404 });
  };
}

/** The `messages.list` queries of a recorded run, in order. */
export function listCalls(world: GmailWorld): URLSearchParams[] {
  return world.calls.filter(c => c.url.pathname === "/gmail/v1/users/me/messages").map(c => c.url.searchParams);
}

/** The thread ids a recorded run fetched, in order. */
export function threadCalls(world: GmailWorld): string[] {
  return world.calls.map(c => /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(c.url.pathname)?.[1]).filter((x): x is string => x !== undefined);
}

/** A plain-text message, for tests that add mail of their own. */
export function plainMessage(id: string, threadId: string, at: number, headers: Record<string, string>, text: string, labels: string[] = ["INBOX"]): RawMessage {
  return {
    id, threadId, labelIds: labels, internalDate: String(at),
    payload: {
      partId: "", mimeType: "text/plain", filename: "",
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: { size: text.length, data: Buffer.from(text).toString("base64url") },
    },
  };
}
