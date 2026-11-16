/**
 * A recorded Outlook mailbox behind Microsoft Graph, for connector tests.
 * Message resources and error bodies come from
 * tests/fixtures/connectors/microsoft-outlook-mail.json (shaped after the
 * documented resources); the endpoints the Outlook mail adapter reads answer
 * from the world's current message set, so a test can add, move or delete mail
 * between runs:
 *
 *   - GET /v1.0/me/mailFolders/{wellKnownName}: the folder's id;
 *   - the per-folder messages delta: an initial round lists the folder (only
 *     `receivedDateTime ge` is honoured, as Graph does) page by page under
 *     `Prefer: odata.maxpagesize`, with `@odata.nextLink`s and a final
 *     `@odata.deltaLink`; a delta round returns every message of the folder
 *     changed since its token and an `@removed` entry for each one that left
 *     it. Only the `$select`ed properties come back;
 *   - GET /v1.0/me/messages/{id} and the conversation listing
 *     `$filter=conversationId eq '…'` with `$expand=attachments(...)`.
 *
 * The Microsoft identity platform token endpoint answers a refresh. Nothing
 * leaves the process; every request is recorded with its Prefer header.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../../src/core/connectors/client.ts";
import type { ConnectorProvider } from "../../src/core/connectors/providers.ts";
import { microsoftProvider } from "../../src/core/connectors/microsoft/provider.ts";

type Json = Record<string, unknown>;

export const OUTLOOK_FIXTURES = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "connectors", "microsoft-outlook-mail.json"), "utf8"),
) as Record<string, unknown>;

export const GRAPH_ACCESS_TOKEN = String((OUTLOOK_FIXTURES.token as Json).access_token);
export const GRAPH_REFRESH_TOKEN = String((OUTLOOK_FIXTURES.token as Json).refresh_token);
export const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const FOLDERS = OUTLOOK_FIXTURES.folders as Record<string, string>;

export interface GraphMessage {
  id: string;
  conversationId: string;
  parentFolderId: string;
  receivedDateTime: string;
  [k: string]: unknown;
}

/** A canned answer: an explicit status and body, with an optional Retry-After. */
export interface GraphAnswer { status: number; body: unknown; retryAfter?: string }

export interface GraphCall {
  url: URL;
  method: string;
  prefer: string | null;
  authorization: string | null;
}

export interface OutlookWorld {
  messages: GraphMessage[];
  /** Bumped by every change; a delta token remembers the epoch it was issued at. */
  epoch: number;
  log: Array<{ epoch: number; folderId: string; id: string }>;
  /** Replaces the answer of a delta request when it returns one. */
  delta?: (url: URL) => GraphAnswer | undefined;
  /** Replaces the answer of a conversation listing when it returns one. */
  conversation?: (conversationId: string) => GraphAnswer | undefined;
  expired?: boolean;
  refuseRefresh?: boolean;
  calls: GraphCall[];
}

export function fixtureMessages(): GraphMessage[] {
  return structuredClone(OUTLOOK_FIXTURES.messages) as GraphMessage[];
}

export function outlookWorld(over: Partial<OutlookWorld> = {}): OutlookWorld {
  return { messages: fixtureMessages(), epoch: 1, log: [], calls: [], ...over };
}

function touch(w: OutlookWorld, folderId: string, id: string): void {
  w.epoch++;
  w.log.push({ epoch: w.epoch, folderId, id });
}

/** New mail lands in its folder. */
export function addMessage(w: OutlookWorld, m: GraphMessage): void {
  w.messages.push(structuredClone(m));
  touch(w, m.parentFolderId, m.id);
}

/** A message moves (to Deleted Items, Junk, ...); with immutable ids its id stays. */
export function moveMessage(w: OutlookWorld, id: string, toFolder: string): void {
  const m = w.messages.find(x => x.id === id)!;
  const from = m.parentFolderId;
  m.parentFolderId = FOLDERS[toFolder]!;
  touch(w, from, id);
  touch(w, m.parentFolderId, id);
}

/** A message is purged: gone from every folder. */
export function purgeMessage(w: OutlookWorld, id: string): void {
  const m = w.messages.find(x => x.id === id)!;
  w.messages = w.messages.filter(x => x.id !== id);
  touch(w, m.parentFolderId, id);
}

/** A property flip (read state) on a message, reported by the delta like any change. */
export function markRead(w: OutlookWorld, id: string): void {
  const m = w.messages.find(x => x.id === id)!;
  m.isRead = true;
  touch(w, m.parentFolderId, id);
}

const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const dec = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString()) as Json;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function answer(a: GraphAnswer): Response {
  return json(a.status, a.body, a.retryAfter ? { "retry-after": a.retryAfter } : {});
}

function project(m: Json, select: string[], expand: string | null): Json {
  const out: Json = { "@odata.type": m["@odata.type"] ?? "#microsoft.graph.message", "@odata.etag": `W/"${String(m.changeKey ?? "")}"`, id: m.id };
  for (const k of select) if (k in m && k !== "attachments") out[k] = structuredClone(m[k]);
  if (expand !== null) {
    const inner = /^attachments\(\$select=([^)]*)\)$/.exec(expand);
    const fields = inner ? inner[1]!.split(",") : null;
    out.attachments = ((m.attachments ?? []) as Json[]).map((a) => {
      if (fields === null) return { ...a, contentBytes: "QUJD" };
      const p: Json = { "@odata.type": a["@odata.type"] };
      for (const f of fields) if (f in a) p[f] = a[f];
      return p;
    });
  }
  return out;
}

function pageSize(prefer: string | null): number {
  const m = /odata\.maxpagesize=(\d+)/.exec(prefer ?? "");
  return m ? Number(m[1]) : 10;
}

function folderIdOf(segment: string): string | null {
  const quoted = /^mailFolders\('([^']+)'\)$/.exec(segment);
  if (quoted) return quoted[1]!;
  const plain = /^mailFolders\/([^/]+)$/.exec(segment);
  if (!plain) return null;
  return FOLDERS[plain[1]!] ?? plain[1]!;
}

function deltaResponse(w: OutlookWorld, url: URL, prefer: string | null): Response {
  const seg = /^\/v1\.0\/me\/(mailFolders\('[^']+'\)|mailFolders\/[^/]+)\/messages\/delta$/.exec(url.pathname);
  const folderId = seg ? folderIdOf(seg[1]!) : null;
  if (folderId === null) return json(404, OUTLOOK_FIXTURES.error404Item);
  const size = pageSize(prefer);
  const link = (kind: "skiptoken" | "deltatoken", state: Json) =>
    `https://graph.microsoft.com/v1.0/me/mailFolders('${folderId}')/messages/delta?$${kind}=${enc(state)}`;

  const skip = url.searchParams.get("$skiptoken");
  const deltaToken = url.searchParams.get("$deltatoken");
  let state: Json;
  if (skip !== null) state = dec(skip);
  else if (deltaToken !== null) {
    const t = dec(deltaToken);
    state = { mode: "delta", since: t.epoch, upto: w.epoch, offset: 0, select: t.select };
  } else {
    const filter = url.searchParams.get("$filter") ?? "";
    const f = /^receivedDateTime ge (\S+)$/.exec(filter);
    if (filter !== "" && !f) return json(400, { error: { code: "ErrorInvalidUrlQueryFilter", message: "unsupported filter" } });
    state = { mode: "initial", snap: w.epoch, offset: 0, filterMs: f ? Date.parse(f[1]!) : null, select: (url.searchParams.get("$select") ?? "").split(",").filter(Boolean) };
  }
  const select = state.select as string[];
  const offset = Number(state.offset);
  let rows: Json[];
  if (state.mode === "initial") {
    rows = w.messages
      .filter(m => m.parentFolderId === folderId && (state.filterMs === null || Date.parse(m.receivedDateTime) >= Number(state.filterMs)))
      .sort((a, b) => Date.parse(b.receivedDateTime) - Date.parse(a.receivedDateTime))
      .map(m => project(m, select, null));
  } else {
    const ids: string[] = [];
    for (const e of w.log) if (e.epoch > Number(state.since) && e.epoch <= Number(state.upto) && e.folderId === folderId && !ids.includes(e.id)) ids.push(e.id);
    rows = ids.map((id) => {
      const m = w.messages.find(x => x.id === id && x.parentFolderId === folderId);
      return m ? project(m, select, null) : { "@odata.type": "#microsoft.graph.message", id, "@removed": { reason: "deleted" } };
    });
  }
  const slice = rows.slice(offset, offset + size);
  const more = offset + size < rows.length;
  const body: Json = { "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#Collection(message)", value: slice };
  if (more) body["@odata.nextLink"] = link("skiptoken", { ...state, offset: offset + size });
  else body["@odata.deltaLink"] = link("deltatoken", { epoch: state.mode === "initial" ? state.snap : state.upto, select });
  return json(200, body);
}

function conversationResponse(w: OutlookWorld, url: URL): Response {
  const filter = url.searchParams.get("$filter") ?? "";
  const m = /^conversationId eq '((?:[^']|'')*)'$/.exec(filter);
  if (!m) return json(400, { error: { code: "ErrorInvalidUrlQueryFilter", message: "unsupported filter" } });
  const conv = m[1]!.replace(/''/g, "'");
  const override = w.conversation?.(conv);
  if (override !== undefined) return answer(override);
  const select = (url.searchParams.get("$select") ?? "").split(",").filter(Boolean);
  const top = Number(url.searchParams.get("$top") ?? "10");
  const skip = Number(url.searchParams.get("$skip") ?? "0");
  const all = w.messages.filter(x => x.conversationId === conv).map(x => project(x, select, url.searchParams.get("$expand")));
  const slice = all.slice(skip, skip + top);
  const body: Json = { value: slice };
  if (skip + top < all.length) {
    const next = new URL(url.toString());
    next.searchParams.set("$skip", String(skip + top));
    body["@odata.nextLink"] = next.toString();
  }
  return json(200, body);
}

export function outlookFetch(w: OutlookWorld): FetchFn {
  return async (raw, init) => {
    const url = new URL(raw);
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization");
    w.calls.push({ url, method: init.method ?? "GET", prefer: headers.get("prefer"), authorization });

    if (raw === MS_TOKEN_URL) {
      const form = typeof init.body === "string" ? new URLSearchParams(init.body) : null;
      if (form?.get("grant_type") === "refresh_token" && w.refuseRefresh) return json(400, OUTLOOK_FIXTURES.tokenRefreshInvalidGrant);
      return json(200, OUTLOOK_FIXTURES.token);
    }
    if (url.origin !== "https://graph.microsoft.com") return new Response("not found", { status: 404 });
    if (w.expired || authorization !== `Bearer ${GRAPH_ACCESS_TOKEN}`) return json(401, OUTLOOK_FIXTURES.error401);

    const p = url.pathname;
    if (p.endsWith("/messages/delta")) {
      const override = w.delta?.(url);
      if (override !== undefined) return answer(override);
      return deltaResponse(w, url, headers.get("prefer"));
    }
    const folder = /^\/v1\.0\/me\/mailFolders\/([^/]+)$/.exec(p);
    if (folder) {
      const id = FOLDERS[decodeURIComponent(folder[1]!)];
      return id ? json(200, { id, displayName: folder[1] }) : json(404, OUTLOOK_FIXTURES.error404Item);
    }
    if (p === "/v1.0/me/messages") return conversationResponse(w, url);
    const one = /^\/v1\.0\/me\/messages\/([^/]+)$/.exec(p);
    if (one) {
      const m = w.messages.find(x => x.id === decodeURIComponent(one[1]!));
      if (!m) return json(404, OUTLOOK_FIXTURES.error404Item);
      return json(200, project(m, (url.searchParams.get("$select") ?? "").split(",").filter(Boolean), null));
    }
    return json(404, OUTLOOK_FIXTURES.error404Item);
  };
}

/** The delta requests of a recorded run, in order. */
export function deltaCalls(w: OutlookWorld): URL[] {
  return w.calls.filter(c => c.url.pathname.endsWith("/messages/delta")).map(c => c.url);
}

/** The shipped Microsoft provider, so a mail sync runs through its own routing to the mail adapter. */
export function outlookTestProvider(): ConnectorProvider {
  return microsoftProvider();
}

/** The conversation ids a recorded run listed, in order. */
export function conversationCalls(w: OutlookWorld): string[] {
  return w.calls
    .filter(c => c.url.pathname === "/v1.0/me/messages")
    .map(c => /^conversationId eq '(.*)'$/.exec(c.url.searchParams.get("$filter") ?? "")?.[1])
    .filter((x): x is string => x !== undefined);
}
