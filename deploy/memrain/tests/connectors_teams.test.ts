/**
 * The Microsoft Teams services against a fake Microsoft Graph, without a
 * database: the provider's two read-only services and their source kinds;
 * chats listed, each with its own lastModifiedDateTime watermark, rendered as
 * chat days by the shared renderer with meeting credentials removed; an
 * incremental round that re-renders only the days an edit or a new message
 * touched and deletes a day left empty; a run's item budget resumed without
 * losing a day; and meeting transcripts found through the calendar's join
 * links, read as WebVTT, linked to the calendar event page instead of
 * duplicating it, with the tenant's transcript policy reported plainly.
 */
import { describe, expect, it } from "bun:test";
import { ConnectorClient, type FetchFn } from "../src/core/connectors/client.ts";
import { accountRef, shortHash } from "../src/core/connectors/model.ts";
import type { PageResult, RenderedSyncItem, SyncAccount, SyncAdapter, SyncItem } from "../src/core/connectors/sync-engine.ts";
import { microsoftProvider } from "../src/core/connectors/microsoft/provider.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { parseTeamsChatCursor, TEAMS_CHAT_STREAM, teamsChatAdapter, teamsMessageText } from "../src/core/connectors/microsoft/teams-chat.ts";
import { parseVtt, TEAMS_TRANSCRIPTS_STREAM, teamsTranscriptsAdapter } from "../src/core/connectors/microsoft/teams-transcripts.ts";

const GRAPH = ["https://graph", "microsoft", "com"].join(".");
const TOKEN = ["acc", "ess", "-teams-value"].join("");
const OWNER = "owner@example.test";
const SELF = "user-self";
const T0 = Date.parse("2026-11-16T10:00:00Z");
const CHAT_A = "19:chat-a@unq.gbl.spaces";
const CHAT_B = "19:chat-b@thread.v2";
const CHAT_OLD = "19:chat-old@thread.v2";

interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface Call {
  url: URL;
  accept: string | null;
}

/** A fake Graph: `route` answers each request; every request is recorded. */
function graph(route: (url: URL, call: Call) => Reply | null) {
  const calls: Call[] = [];
  const fetch: FetchFn = async (raw, init) => {
    const url = new URL(raw);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call = { url, accept: headers.Accept ?? null };
    calls.push(call);
    const r = route(url, call);
    if (r === null) throw new Error(`unexpected request ${url.pathname}${url.search}`);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    const type = typeof r.body === "string" ? "text/vtt" : "application/json";
    return new Response(text, { status: r.status ?? 200, headers: { "content-type": type, ...r.headers } });
  };
  const client = new ConnectorClient({ origin: GRAPH, token: TOKEN, fetch, now: () => T0, sleep: async () => {}, maxRetries: 0 });
  return { calls, client };
}

function account(service: string, config: Record<string, unknown> = {}): SyncAccount {
  return {
    id: "00000000-0000-4000-8000-0000000000c7", sourceId: "work-teams", provider: "microsoft", enabled: true, status: "active",
    itemCapDaily: 5000, spendCapUsdDaily: 1, accountLabel: OWNER, services: [service], config: { provider_user_id: SELF, ...config },
  };
}

const rendered = (items: SyncItem[]): RenderedSyncItem[] => items.filter((i): i is RenderedSyncItem => i.failure === undefined);

async function page(adapter: SyncAdapter, client: ConnectorClient, stream: string, cursor: string | null, perRun = 500) {
  const res = await adapter.page({ client, account: account("x"), stream, cursor, page: 0, budget: { remaining: perRun, perRun } });
  if (!res.ok) throw new Error(`page failed: ${res.response.error}`);
  return res as Extract<PageResult, { ok: true }>;
}

/** Run a stream to its end the way the engine does, one page at a time. */
async function drain(adapter: SyncAdapter, client: ConnectorClient, stream: string, cursor: string | null, perRun = 500) {
  const items: SyncItem[] = [];
  const deletions: string[] = [];
  let at = cursor;
  for (let i = 0; i < 50; i++) {
    const res = await page(adapter, client, stream, at, perRun);
    items.push(...res.items);
    deletions.push(...(res.deletions ?? []));
    if (res.checkpoint !== null) at = res.checkpoint;
    if (res.done) return { items, deletions, cursor: at };
  }
  throw new Error("stream never finished");
}

const user = (id: string, displayName: string) => ({ user: { id, displayName, userIdentityType: "aadUser" }, application: null, device: null });

function msg(id: string, created: string, opts: { modified?: string; from?: "self" | "ada" | "bob"; text?: string; html?: string; type?: string; deleted?: boolean } = {}) {
  const from = opts.from === "self" ? user(SELF, "Owner") : opts.from === "bob" ? user("user-bob", "Bob") : user("user-ada", "Ada");
  return {
    id, messageType: opts.type ?? "message", createdDateTime: created, lastModifiedDateTime: opts.modified ?? created,
    deletedDateTime: opts.deleted ? opts.modified ?? created : null, replyToId: null, from: opts.type === "systemEventMessage" ? null : from,
    body: opts.html !== undefined ? { contentType: "html", content: opts.html } : { contentType: "text", content: opts.text ?? "" },
  };
}

const chat = (id: string, chatType: string, topic: string | null, preview: string) => ({
  id, chatType, topic, lastUpdatedDateTime: preview, lastMessagePreview: { id: "p", createdDateTime: preview, isDeleted: false },
});

const JOIN_LINK = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d";

/** Messages of chat A, newest first, as Graph lists them by createdDateTime. */
const chatAMessages = [
  msg("a4", "2026-11-16T09:00:00.000Z", { html: `<p>Join here ${JOIN_LINK}</p><p>Passcode: 482913</p>` }),
  msg("a3", "2026-11-16T08:00:00.000Z", { from: "self", html: "<p>Sure, <at id=\"0\">Ada</at>, I will send it <attachment id=\"x1\"></attachment></p>" }),
  msg("a2", "2026-11-15T17:00:00.000Z", { type: "systemEventMessage" }),
  msg("a1", "2026-11-15T16:00:00.000Z", { text: "Can you share the deck?" }),
];
const chatBMessages = [msg("b1", "2026-11-15T12:00:00.000Z", { from: "bob", text: "Launch moves to Friday." })];

function messagesRoute(byChat: Record<string, Array<ReturnType<typeof msg>>>, opts: { split?: boolean } = {}) {
  return (url: URL): Reply | null => {
    const m = /^\/v1\.0\/chats\/([^/]+)\/messages$/.exec(url.pathname);
    if (m === null) return null;
    const all = byChat[decodeURIComponent(m[1]!)] ?? [];
    const orderby = url.searchParams.get("$orderby");
    const filter = url.searchParams.get("$filter") ?? "";
    const top = Number(url.searchParams.get("$top") ?? "50");
    if (orderby === "lastModifiedDateTime desc") {
      const gt = /^lastModifiedDateTime gt (\S+)$/.exec(filter);
      const changed = all.filter(x => gt === null || Date.parse(x.lastModifiedDateTime) > Date.parse(gt[1]!))
        .sort((x, y) => Date.parse(y.lastModifiedDateTime) - Date.parse(x.lastModifiedDateTime));
      return { body: { value: changed.slice(0, top) } };
    }
    if (orderby === "createdDateTime desc") {
      const lt = /^createdDateTime lt (\S+)$/.exec(filter);
      const list = all.filter(x => lt === null || Date.parse(x.createdDateTime) < Date.parse(lt[1]!));
      const skip = Number(url.searchParams.get("$skiptoken") ?? "0");
      const size = opts.split ? 2 : 50;
      const chunk = list.slice(skip, skip + size);
      const nextSkip = skip + size;
      const nextUrl = new URL(url.toString());
      nextUrl.searchParams.set("$skiptoken", String(nextSkip));
      const next = nextSkip < list.length ? nextUrl.toString() : undefined;
      return { body: { value: chunk, ...(next ? { "@odata.nextLink": next } : {}) } };
    }
    return null;
  };
}

describe("microsoft provider: Teams services", () => {
  it("declares Teams chats and meeting transcripts as read-only services of their own source kinds", () => {
    const ms = microsoftProvider();
    expect(ms.services.teams_chat).toEqual({ scopes: ["Chat.Read"], sourceKinds: ["chat"] });
    expect(ms.services.teams_transcripts).toEqual({
      scopes: ["Calendars.Read", "OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"],
      sourceKinds: ["meeting"],
    });
    for (const s of Object.values(ms.services).flatMap(x => x.scopes)) expect(/write/i.test(s)).toBe(false);
    expect(ms.normalizeScope!("https://graph.microsoft.com/chat.read")).toBe("Chat.Read");
    expect(ms.normalizeScope!("https://graph.microsoft.com/OnlineMeetingTranscript.Read.All")).toBe("OnlineMeetingTranscript.Read.All");
    expect(ms.normalizeScope!("onlinemeetings.read")).toBe("OnlineMeetings.Read");
  });

  it("hands each Teams account the adapter of its service", () => {
    const ms = microsoftProvider();
    expect(ms.sync!.adapter(account("teams_chat"), { env: {} }).streams(account("teams_chat"))).toEqual([TEAMS_CHAT_STREAM]);
    expect(ms.sync!.adapter(account("teams_transcripts"), { env: {} }).streams(account("teams_transcripts"))).toEqual([TEAMS_TRANSCRIPTS_STREAM]);
  });
});

describe("teams chat message text", () => {
  it("turns a message's HTML into text: mentions keep the name, attachments become a marker, emoji keep their alt", () => {
    expect(teamsMessageText({ contentType: "html", content: "<p>Hi <at id=\"0\">Ada</at> <emoji id=\"smile\" alt=\"🙂\" title=\"Smile\"></emoji></p><attachment id=\"1\"></attachment>" }))
      .toBe("Hi Ada 🙂\n[attachment]");
    expect(teamsMessageText({ contentType: "text", content: "plain <b>stays</b>" })).toBe("plain <b>stays</b>");
    expect(teamsMessageText(null)).toBe("");
  });
});

describe("teams chat adapter", () => {
  const listRoute = (chats: unknown[]) => (url: URL): Reply | null =>
    url.pathname === "/v1.0/me/chats" ? { body: { value: chats } } : null;

  function world(chats: unknown[], byChat: Record<string, Array<ReturnType<typeof msg>>>, opts: { split?: boolean } = {}) {
    const list = listRoute(chats);
    const messages = messagesRoute(byChat, opts);
    return graph(url => list(url) ?? messages(url));
  }

  it("renders each recent chat as chat days on the first sync, credentials and system messages left out", async () => {
    const g = world([
      chat(CHAT_A, "oneOnOne", null, "2026-11-16T09:00:00.000Z"),
      chat(CHAT_B, "group", "Launch plan", "2026-11-15T12:00:00.000Z"),
      chat(CHAT_OLD, "group", "Old", "2026-09-01T12:00:00.000Z"),
    ], { [CHAT_A]: chatAMessages, [CHAT_B]: chatBMessages }, { split: true });
    const adapter = teamsChatAdapter(account("teams_chat"), { now: () => T0, env: {} });
    const out = await drain(adapter, g.client, TEAMS_CHAT_STREAM, null);

    const items = rendered(out.items);
    expect(items.map(i => i.externalId).sort()).toEqual([`${CHAT_A}:2026-11-15`, `${CHAT_A}:2026-11-16`, `${CHAT_B}:2026-11-15`]);
    const today = items.find(i => i.externalId === `${CHAT_A}:2026-11-16`)!;
    expect(today.type).toBe("connector-chat");
    expect(today.slug.startsWith(`chat/${accountRef(OWNER, "microsoft")}/`)).toBe(true);
    expect(today.body).not.toContain("482913");
    expect(today.body).not.toContain("meetup-join");
    expect(today.body).toContain("Sure, Ada, I will send it");
    expect(today.title).toBe("#Ada · 2026-11-16");
    // A direct chat with the owner's own messages tells replies apart for the loop detector.
    expect(today.enrich?.loop?.kind).toBe("chat");
    const launch = items.find(i => i.externalId === `${CHAT_B}:2026-11-15`)!;
    expect(launch.title).toBe("#Launch plan · 2026-11-15");
    expect(items.find(i => i.externalId === `${CHAT_A}:2026-11-15`)!.body).not.toContain("systemEvent");
    // The chat whose last message is older than the history window is never read.
    expect(g.calls.some(c => c.url.pathname.includes(encodeURIComponent(CHAT_OLD)))).toBe(false);

    const state = parseTeamsChatCursor(out.cursor)!;
    expect(state.queue).toEqual([]);
    expect(state.marks[shortHash(`tchat:${CHAT_A}`)]).toBe("2026-11-16T09:00:00.000Z");
    expect(state.marks[shortHash(`tchat:${CHAT_B}`)]).toBe("2026-11-15T12:00:00.000Z");
  });

  it("re-renders only the days a change touched, and deletes a day left without messages", async () => {
    const first = world([
      chat(CHAT_A, "oneOnOne", null, "2026-11-16T09:00:00.000Z"),
      chat(CHAT_B, "group", "Launch plan", "2026-11-15T12:00:00.000Z"),
    ], { [CHAT_A]: chatAMessages, [CHAT_B]: chatBMessages });
    const run1 = await drain(teamsChatAdapter(account("teams_chat"), { now: () => T0, env: {} }), first.client, TEAMS_CHAT_STREAM, null);

    const later = T0 + 3_600_000;
    const edited = msg("a1", "2026-11-15T16:00:00.000Z", { modified: "2026-11-16T10:20:00.000Z", text: "Can you share the final deck?" });
    const g = world([
      chat(CHAT_A, "oneOnOne", null, "2026-11-16T10:30:00.000Z"),
      chat(CHAT_B, "group", "Launch plan", "2026-11-16T10:40:00.000Z"),
    ], {
      [CHAT_A]: [msg("a5", "2026-11-16T10:30:00.000Z", { text: "Thanks!" }), ...chatAMessages.slice(0, 3), edited],
      [CHAT_B]: [
        msg("b2", "2026-11-16T10:40:00.000Z", { from: "bob", text: "New date is set." }),
        msg("b1", "2026-11-15T12:00:00.000Z", { from: "bob", modified: "2026-11-16T10:41:00.000Z", deleted: true }),
      ],
    });
    const out = await drain(teamsChatAdapter(account("teams_chat"), { now: () => later, env: {} }), g.client, TEAMS_CHAT_STREAM, run1.cursor);

    const ids = rendered(out.items).map(i => i.externalId).sort();
    expect(ids).toEqual([`${CHAT_A}:2026-11-15`, `${CHAT_A}:2026-11-16`, `${CHAT_B}:2026-11-16`]);
    expect(rendered(out.items).find(i => i.externalId === `${CHAT_A}:2026-11-15`)!.body).toContain("final deck");
    expect(out.deletions).toEqual([`${CHAT_B}:2026-11-15`]);
    const detect = g.calls.find(c => c.url.pathname.includes(encodeURIComponent(CHAT_A)) && c.url.searchParams.get("$orderby") === "lastModifiedDateTime desc")!;
    expect(detect.url.searchParams.get("$filter")).toBe("lastModifiedDateTime gt 2026-11-16T09:00:00.000Z");
    const marks = parseTeamsChatCursor(out.cursor)!.marks;
    expect(marks[shortHash(`tchat:${CHAT_A}`)]).toBe("2026-11-16T10:30:00.000Z");
    expect(marks[shortHash(`tchat:${CHAT_B}`)]).toBe("2026-11-16T10:41:00.000Z");
  });

  it("leaves a chat alone when nothing was posted since its watermark", async () => {
    const first = world([chat(CHAT_B, "group", "Launch plan", "2026-11-15T12:00:00.000Z")], { [CHAT_B]: chatBMessages });
    const run1 = await drain(teamsChatAdapter(account("teams_chat"), { now: () => T0, env: {} }), first.client, TEAMS_CHAT_STREAM, null);
    const g = world([chat(CHAT_B, "group", "Launch plan", "2026-11-15T12:00:00.000Z")], { [CHAT_B]: chatBMessages });
    const out = await drain(teamsChatAdapter(account("teams_chat"), { now: () => T0 + 60_000, env: {} }), g.client, TEAMS_CHAT_STREAM, run1.cursor);
    expect(out.items).toEqual([]);
    expect(g.calls.map(c => c.url.pathname)).toEqual(["/v1.0/me/chats"]);
  });

  it("picks up an edit in a recently active chat with no new message, once the hourly edit check comes round", async () => {
    const first = world([chat(CHAT_A, "oneOnOne", null, "2026-11-16T09:00:00.000Z")], { [CHAT_A]: chatAMessages });
    const run1 = await drain(teamsChatAdapter(account("teams_chat"), { now: () => T0, env: {} }), first.client, TEAMS_CHAT_STREAM, null);
    // A cursor written before the edit check still reads.
    expect(parseTeamsChatCursor(JSON.stringify({ ...JSON.parse(run1.cursor!), editsAt: undefined }))).not.toBeNull();
    const edited = msg("a1", "2026-11-15T16:00:00.000Z", { modified: "2026-11-16T10:05:00.000Z", text: "Can you share the final deck?" });
    const messages = [...chatAMessages.slice(0, 3), edited];
    // The chat list still shows 09:00 as the last message: an edit does not move it.
    const listed = [chat(CHAT_A, "oneOnOne", null, "2026-11-16T09:00:00.000Z")];

    const soon = world(listed, { [CHAT_A]: messages });
    const quiet = await drain(teamsChatAdapter(account("teams_chat"), { now: () => T0 + 10 * 60_000, env: {} }), soon.client, TEAMS_CHAT_STREAM, run1.cursor);
    expect(quiet.items).toEqual([]);
    expect(soon.calls.map(c => c.url.pathname)).toEqual(["/v1.0/me/chats"]);

    const g = world(listed, { [CHAT_A]: messages });
    const out = await drain(teamsChatAdapter(account("teams_chat"), { now: () => T0 + 3_600_000, env: {} }), g.client, TEAMS_CHAT_STREAM, quiet.cursor);
    const items = rendered(out.items);
    expect(items.map(i => i.externalId)).toEqual([`${CHAT_A}:2026-11-15`]);
    expect(items[0]!.body).toContain("final deck");
    expect(parseTeamsChatCursor(out.cursor)!.marks[shortHash(`tchat:${CHAT_A}`)]).toBe("2026-11-16T10:05:00.000Z");
  });

  it("an edit round over more recent chats than one queue holds checks every one of them", async () => {
    const ids = Array.from({ length: 520 }, (_, i) => `19:chat-${String(i).padStart(3, "0")}@thread.v2`);
    const last = "2026-11-16T09:00:00.000Z";
    const chats = ids.map(id => chat(id, "group", "Busy", last));
    const lastId = ids.at(-1)!;
    const byChat: Record<string, Array<ReturnType<typeof msg>>> = {};
    for (const id of ids) byChat[id] = [msg(`${id}-1`, last)];
    byChat[lastId] = [msg(`${lastId}-1`, last, { modified: "2026-11-16T10:30:00.000Z", text: "edited at the end of the list" })];
    // Graph lists chats 50 a page.
    const g = graph((url) => {
      if (url.pathname === "/v1.0/me/chats") {
        const skip = Number(url.searchParams.get("$skiptoken") ?? "0");
        const next = new URL(url.toString());
        next.searchParams.set("$skiptoken", String(skip + 50));
        return { body: { value: chats.slice(skip, skip + 50), ...(skip + 50 < chats.length ? { "@odata.nextLink": next.toString() } : {}) } };
      }
      return messagesRoute(byChat)(url);
    });
    const state = {
      v: 1, floor: "2026-10-17T10:00:00.000Z", marks: Object.fromEntries(ids.map(id => [shortHash(`tchat:${id}`), last])),
      queue: [], listing: null, editsAt: new Date(T0 - 2 * 3_600_000).toISOString(),
    };
    const adapter = teamsChatAdapter(account("teams_chat"), { now: () => T0 + 3_600_000, env: {} });
    let at: string | null = JSON.stringify(state);
    const items: SyncItem[] = [];
    for (let i = 0; ; i++) {
      if (i > 2000) throw new Error("stream never finished");
      const res = await page(adapter, g.client, TEAMS_CHAT_STREAM, at);
      items.push(...res.items);
      if (res.checkpoint !== null) at = res.checkpoint;
      if (res.done) break;
    }
    expect(rendered(items).map(i => i.externalId)).toEqual([`${lastId}:2026-11-16`]);
  });

  it("stores one day per page when the run's budget allows one, and resumes below it", async () => {
    const g = world([chat(CHAT_A, "oneOnOne", null, "2026-11-16T09:00:00.000Z")], { [CHAT_A]: chatAMessages });
    const adapter = teamsChatAdapter(account("teams_chat"), { now: () => T0, env: {} });
    const listed = await page(adapter, g.client, TEAMS_CHAT_STREAM, null, 1);
    const first = await page(adapter, g.client, TEAMS_CHAT_STREAM, listed.checkpoint, 1);
    expect(rendered(first.items).map(i => i.externalId)).toEqual([`${CHAT_A}:2026-11-16`]);
    expect(first.done).toBe(false);
    expect(parseTeamsChatCursor(first.checkpoint)!.queue[0]!.hi).toBe("2026-11-16T00:00:00.000Z");
    const second = await page(adapter, g.client, TEAMS_CHAT_STREAM, first.checkpoint, 1);
    expect(rendered(second.items).map(i => i.externalId)).toEqual([`${CHAT_A}:2026-11-15`]);
    expect(second.done).toBe(true);
    const resumed = g.calls.filter(c => c.url.searchParams.get("$orderby") === "createdDateTime desc").at(-1)!;
    expect(resumed.url.searchParams.get("$filter")).toBe("createdDateTime lt 2026-11-16T00:00:00.000Z");
  });

  it("reports a refused chat list as forbidden, naming the permission", async () => {
    const g = graph(url => (url.pathname === "/v1.0/me/chats" ? { status: 403, body: { error: { code: "Forbidden", message: "Missing scope permissions" } } } : null));
    const res = await teamsChatAdapter(account("teams_chat"), { now: () => T0, env: {} })
      .page({ client: g.client, account: account("teams_chat"), stream: TEAMS_CHAT_STREAM, cursor: null, page: 0 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.response.class).toBe("forbidden");
    expect(res.response.error).toContain("Chat.Read");
    expect(g.calls).toHaveLength(1);
  });

  it("holds a chat Graph no longer shows instead of stopping the others", async () => {
    const list = listRoute([chat(CHAT_A, "oneOnOne", null, "2026-11-16T09:00:00.000Z"), chat(CHAT_B, "group", "Launch plan", "2026-11-15T12:00:00.000Z")]);
    const messages = messagesRoute({ [CHAT_B]: chatBMessages });
    const g = graph(url => list(url)
      ?? (url.pathname.includes(encodeURIComponent(CHAT_A)) ? { status: 404, body: { error: { code: "NotFound" } } } : messages(url)));
    const out = await drain(teamsChatAdapter(account("teams_chat"), { now: () => T0, env: {} }), g.client, TEAMS_CHAT_STREAM, null);
    const failed = out.items.filter(i => i.failure !== undefined);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.failure).toMatchObject({ code: "chat_unavailable", holdNow: true });
    expect(rendered(out.items).map(i => i.externalId)).toEqual([`${CHAT_B}:2026-11-15`]);
  });

  it("reads a day longer than one walk to its end instead of storing part of it", async () => {
    const busy = Array.from({ length: 1001 }, (_, i) => msg(`busy-${i}`, new Date(Date.parse("2026-11-15T23:00:00.000Z") - i * 60_000).toISOString(), { text: `line ${i}` }));
    const older = msg("older", "2026-11-14T08:00:00.000Z", { text: "yesterday" });
    const g = world([chat(CHAT_B, "group", "Launch plan", "2026-11-15T23:00:00.000Z")], { [CHAT_B]: [...busy, older] });
    const out = await drain(teamsChatAdapter(account("teams_chat"), { now: () => T0, env: {} }), g.client, TEAMS_CHAT_STREAM, null);
    const day = rendered(out.items).find(i => i.externalId === `${CHAT_B}:2026-11-15`)!;
    expect(day.body).toContain("1001 messages");
    expect(rendered(out.items).map(i => i.externalId)).toContain(`${CHAT_B}:2026-11-14`);
  });

  it("removes meeting credentials from a chat's topic and its people's names too", async () => {
    const named = { ...msg("n1", "2026-11-15T12:00:00.000Z", { text: "hello" }), from: user("user-x", "Dial-in Passcode: 551234") };
    const g = world([chat(CHAT_B, "group", "Standup Passcode: 482913", "2026-11-15T12:00:00.000Z")], { [CHAT_B]: [named] });
    const out = await drain(teamsChatAdapter(account("teams_chat"), { now: () => T0, env: {} }), g.client, TEAMS_CHAT_STREAM, null);
    const page = rendered(out.items)[0]!;
    expect(`${page.title}\n${page.body}`).not.toContain("482913");
    expect(page.body).not.toContain("551234");
  });

  it("keeps listing chats past one page cap, across pages of the stream", async () => {
    const chats = Array.from({ length: 22 }, (_, i) => chat(`19:many-${i}@thread.v2`, "group", `Chat ${i}`, "2026-11-15T12:00:00.000Z"));
    const byChat = Object.fromEntries(chats.map(c => [c.id, [msg(`m-${c.id}`, "2026-11-15T12:00:00.000Z", { text: "hi" })]]));
    const messages = messagesRoute(byChat);
    const g = graph((url) => {
      if (url.pathname !== "/v1.0/me/chats") return messages(url);
      const at = Number(url.searchParams.get("$skiptoken") ?? "0");
      const next = new URL(url.toString());
      next.searchParams.set("$skiptoken", String(at + 1));
      return { body: { value: [chats[at]], ...(at + 1 < chats.length ? { "@odata.nextLink": next.toString() } : {}) } };
    });
    const out = await drain(teamsChatAdapter(account("teams_chat"), { now: () => T0, env: {} }), g.client, TEAMS_CHAT_STREAM, null);
    expect(rendered(out.items)).toHaveLength(22);
  });
});

describe("webvtt transcripts", () => {
  it("reads speakers from voice tags, joins a speaker's consecutive cues, and drops cue ids and inline tags", () => {
    const vtt = [
      "WEBVTT",
      "",
      "3a7c1d/12-0",
      "00:00:01.000 --> 00:00:02.500",
      "<v Ada Lovelace>Good morning,</v>",
      "",
      "00:00:02.500 --> 00:00:04.000",
      "<v Ada Lovelace>let us <c.loud>start</c>.</v>",
      "",
      "00:00:04.000 --> 00:00:05.000",
      "<v Bob>Agreed.</v>",
      "",
      "00:00:05.000 --> 00:00:06.000",
      "No speaker here",
    ].join("\r\n");
    expect(parseVtt(vtt)).toEqual([
      { speaker: "Ada Lovelace", text: "Good morning, let us start." },
      { speaker: "Bob", text: "Agreed." },
      { speaker: "", text: "No speaker here" },
    ]);
    expect(parseVtt("not a transcript")).toEqual([]);
  });

  it("reads the unattributed format, which has cues but no WEBVTT header", () => {
    expect(parseVtt("00:00:16.246 --> 00:00:17.726\nThis is a transcript test.\n\n00:00:18.000 --> 00:00:19.000\nSecond line.\n"))
      .toEqual([{ speaker: "", text: "This is a transcript test. Second line." }]);
  });

  it("reads cues whose offsets are negative, as Graph may write them", () => {
    const mixed = ["WEBVTT", "", "-00:00:01.500 --> 00:00:00.500", "<v Ada>Before zero.</v>", "", "00:00:00.500 --> 00:00:02.000", "<v Bob>After zero.</v>", ""].join("\n");
    expect(parseVtt(mixed)).toEqual([{ speaker: "Ada", text: "Before zero." }, { speaker: "Bob", text: "After zero." }]);
    const allNegative = "-00:00:03.000 --> -00:00:02.000\nFirst.\n\n-00:00:02.000 --> -00:00:01.000\nSecond.\n";
    expect(parseVtt(allNegative)).toEqual([{ speaker: "", text: "First. Second." }]);
  });
});

describe("teams transcripts adapter", () => {
  const joinOne = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_one%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d";
  const joinTwo = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_two%40thread.v2/0?context=%7b%7d";
  const event = (id: string, iCalUId: string, subject: string, start: string, end: string, join: string | null, extra: Record<string, unknown> = {}) => ({
    id, iCalUId, subject, type: "singleInstance", isCancelled: false,
    start: { dateTime: start, timeZone: "UTC" }, end: { dateTime: end, timeZone: "UTC" },
    isOnlineMeeting: join !== null, onlineMeeting: join === null ? null : { joinUrl: join },
    organizer: { emailAddress: { name: "Ada", address: "ada@example.test" } },
    attendees: [{ type: "required", emailAddress: { name: "Bob", address: "bob@example.test" }, status: { response: "accepted" } }],
    ...extra,
  });
  const events = [
    event("ev-1", "ical-e1", "Weekly sync", "2026-11-15T14:00:00.0000000", "2026-11-15T15:00:00.0000000", joinOne),
    event("ev-2", "ical-occ", "Standup", "2026-11-16T08:00:00.0000000", "2026-11-16T08:30:00.0000000", joinTwo, { type: "occurrence", seriesMasterId: "series-1" }),
    event("ev-3", "ical-e3", "Lunch", "2026-11-15T12:00:00.0000000", "2026-11-15T13:00:00.0000000", null),
  ];
  const vttOne = [
    "WEBVTT", "",
    "00:00:01.000 --> 00:00:02.000", "<v Ada>First point.</v>", "",
    "00:00:02.000 --> 00:00:03.000", "<v Ada>Second point.</v>", "",
    "00:00:03.000 --> 00:00:04.000", "<v Bob>Dial in again, Passcode: 551234</v>", "",
  ].join("\n");

  function transcriptWorld(opts: { disabled?: boolean; masterDown?: boolean; contentDenied?: boolean } = {}) {
    return graph((url, call): Reply | null => {
      const p = url.pathname;
      if (p === "/v1.0/me/calendarView") return { body: { value: events } };
      if (p === "/v1.0/me/events/series-1") return opts.masterDown ? { status: 503, body: { error: { code: "ServiceUnavailable" } } } : { body: { id: "series-1", iCalUId: "ical-series" } };
      if (p === "/v1.0/me/onlineMeetings") {
        const filter = url.searchParams.get("$filter");
        if (filter === `JoinWebUrl eq '${encodeURIComponent(joinOne)}'`) return { body: { value: [{ id: "meeting-one" }] } };
        if (filter === `JoinWebUrl eq '${encodeURIComponent(joinTwo)}'`) return { body: { value: [{ id: "meeting-two" }] } };
        return { body: { value: [] } };
      }
      if (opts.disabled && p.endsWith("/transcripts")) {
        return { status: 403, body: { error: { code: "Forbidden", message: "disabled", innerError: { code: "GraphAccessToTranscriptsDisabled" } } } };
      }
      if (p === "/v1.0/me/onlineMeetings/meeting-one/transcripts") {
        return { body: { value: [{ id: "tr-1", meetingId: "meeting-one", createdDateTime: "2026-11-15T14:02:00Z", endDateTime: "2026-11-15T14:58:00Z" }] } };
      }
      if (p === "/v1.0/me/onlineMeetings/meeting-two/transcripts") {
        return {
          body: {
            value: [
              { id: "tr-2", meetingId: "meeting-two", createdDateTime: "2026-11-16T08:01:00Z", endDateTime: "2026-11-16T08:29:00Z" },
              { id: "tr-3", meetingId: "meeting-two", createdDateTime: "2026-11-16T09:55:00Z", endDateTime: null },
            ],
          },
        };
      }
      if (p === "/v1.0/me/onlineMeetings/meeting-one/transcripts/tr-1/content") return opts.contentDenied ? { status: 403, body: { error: { code: "Forbidden" } } } : { body: vttOne };
      if (p === "/v1.0/me/onlineMeetings/meeting-two/transcripts/tr-2/content") {
        if (call.accept === "application/vnd.microsoft.graph.transcript+text") return { body: "00:00:01.000 --> 00:00:03.000\nHello all\n" };
        return { status: 403, body: { error: { code: "Forbidden", innerError: { code: "SpeakerAttributionNotAllowed" } } } };
      }
      return null;
    });
  }

  it("stores each finished transcript as a meeting page linked to its calendar event page", async () => {
    const g = transcriptWorld();
    const adapter = teamsTranscriptsAdapter(account("teams_transcripts"), { now: () => T0, env: {} });
    const out = await drain(adapter, g.client, TEAMS_TRANSCRIPTS_STREAM, null);
    const items = rendered(out.items);
    expect(items).toHaveLength(2);

    const ref = accountRef(OWNER, "microsoft");
    const weekly = items.find(i => i.title === "Weekly sync")!;
    expect(weekly.type).toBe("connector-meeting");
    expect(weekly.body).toContain("Ada: First point. Second point.");
    expect(weekly.body).not.toContain("551234");
    const eventSlug = `calendar/${ref}/${shortHash("ical:ical-e1")}`;
    expect(weekly.body).toContain(`Calendar event: [[${eventSlug}]]`);
    expect(weekly.truth!.calendar_event).toBe(eventSlug);
    expect(weekly.truth!.event_dedupe_key).toBe(shortHash("ical:ical-e1"));
    // The meeting page is its own page, never a second copy of the event.
    expect(weekly.dedupeKey ?? null).toBeNull();
    expect(weekly.slug.startsWith(`meeting/${ref}/2026-11-15-`)).toBe(true);
    expect(weekly.enrich?.participants.map(p => p.name)).toEqual(expect.arrayContaining(["Ada", "Bob"]));

    // An occurrence links to its series' page, whose key is the master's iCalUID.
    const standup = items.find(i => i.title === "Standup")!;
    expect(standup.body).toContain(`[[calendar/${ref}/${shortHash("ical:ical-series")}]]`);
    // The tenant keeps speakers out: the unattributed text is read instead.
    expect(standup.body).toContain("Speaker: Hello all");

    const encoded = g.calls.find(c => c.url.pathname === "/v1.0/me/onlineMeetings")!;
    expect(encoded.url.search).toContain(encodeURIComponent(encodeURIComponent(joinOne).slice(0, 20)));
    // A transcript still being written is left for a later run.
    expect(g.calls.some(c => c.url.pathname.includes("tr-3"))).toBe(false);
    expect(JSON.parse(out.cursor!)).toEqual({ v: 1, scannedTo: new Date(T0).toISOString(), pos: null });
    // The window is read one day at a time (with the day before, for meetings that ran late), so no listing cap can skip a meeting.
    const views = g.calls.filter(c => c.url.pathname === "/v1.0/me/calendarView");
    expect(views.length).toBeGreaterThanOrEqual(30);
    for (const v of views) expect(Date.parse(v.url.searchParams.get("endDateTime")!) - Date.parse(v.url.searchParams.get("startDateTime")!)).toBeLessThanOrEqual(2 * 86_400_000);
  });

  /** Pages of the stream until one fails or the stream is done; the last result. */
  async function firstFailure(g: ReturnType<typeof transcriptWorld>) {
    const adapter = teamsTranscriptsAdapter(account("teams_transcripts"), { now: () => T0, env: {} });
    let cursor: string | null = null;
    for (let i = 0; i < 60; i++) {
      const res = await adapter.page({ client: g.client, account: account("teams_transcripts"), stream: TEAMS_TRANSCRIPTS_STREAM, cursor, page: i });
      if (!res.ok || res.done) return res;
      if (res.checkpoint !== null) cursor = res.checkpoint;
    }
    throw new Error("stream never finished");
  }

  it("reports transcripts turned off for the organization as forbidden, by its code", async () => {
    const res = await firstFailure(transcriptWorld({ disabled: true }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.response.class).toBe("forbidden");
    expect(res.response.error).toContain("GraphAccessToTranscriptsDisabled");
  });

  it("holds a transcript Graph will not show at its own version, so the held check can skip it later", async () => {
    const out = await drain(teamsTranscriptsAdapter(account("teams_transcripts"), { now: () => T0, env: {} }), transcriptWorld({ contentDenied: true }).client, TEAMS_TRANSCRIPTS_STREAM, null);
    const failed = out.items.filter(i => i.failure !== undefined);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ version: "2026-11-15T14:02:00.000Z|2026-11-15T14:58:00.000Z", failure: { code: "transcript_unavailable", holdNow: true } });
    expect(rendered(out.items).map(i => i.title)).toEqual(["Standup"]);
  });

  it("does not spend the run's budget on a transcript the engine holds", async () => {
    const heldId = `transcript:${shortHash("meeting-one:tr-1")}`;
    const engine = {
      query: async (sql: string, params: unknown[]) => (sql.includes("FROM connector_items WHERE account_id = $1 AND external_id = $2") && params[1] === heldId
        ? {
            rows: [{
              external_id: heldId, external_version: "2026-11-15T14:02:00.000Z|2026-11-15T14:58:00.000Z", page_slug: null, dedupe_key: null, content_hash: null,
              deleted_upstream_at: null, fail_count: 3, held_reason: "repeated_failure", held_until: new Date(T0 + 86_400_000).toISOString(),
            }],
          }
        : { rows: [] }),
    } as unknown as Engine;
    const g = transcriptWorld();
    const adapter = teamsTranscriptsAdapter(account("teams_transcripts"), { now: () => T0, env: {}, engine });
    const res = await adapter.page({
      client: g.client, account: account("teams_transcripts"), stream: TEAMS_TRANSCRIPTS_STREAM,
      cursor: JSON.stringify({ v: 1, scannedTo: null, pos: "2026-11-15T10:00:00.000Z" }), page: 0, budget: { remaining: 1, perRun: 1 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(rendered(res.items).map(i => i.title)).toEqual(["Standup"]);
    expect(res.done).toBe(true);
    expect(g.calls.some(c => c.url.pathname.endsWith("/tr-1/content"))).toBe(false);
  });

  it("finds meetings on every selected calendar, not only the default one", async () => {
    const joinThree = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_three%40thread.v2/0?context=%7b%7d";
    const board = event("ev-9", "ical-board", "Board review", "2026-11-15T16:00:00.0000000", "2026-11-15T17:00:00.0000000", joinThree);
    const g = graph((url): Reply | null => {
      const p = url.pathname;
      if (p === "/v1.0/me/calendarView") return { body: { value: [] } };
      if (p === "/v1.0/me/calendars/cal-2/calendarView") return { body: { value: [board] } };
      // A selected calendar that was deleted does not stop the others.
      if (p === "/v1.0/me/calendars/cal-gone/calendarView") return { status: 404, body: { error: { code: "ErrorItemNotFound" } } };
      if (p === "/v1.0/me/onlineMeetings") return { body: { value: [{ id: "meeting-three" }] } };
      if (p === "/v1.0/me/onlineMeetings/meeting-three/transcripts") {
        return { body: { value: [{ id: "tr-9", createdDateTime: "2026-11-15T16:01:00Z", endDateTime: "2026-11-15T16:59:00Z" }] } };
      }
      if (p === "/v1.0/me/onlineMeetings/meeting-three/transcripts/tr-9/content") return { body: vttOne };
      return null;
    });
    const acct = account("teams_transcripts", { calendars: ["cal-gone", "cal-2"] });
    const out = await drain(teamsTranscriptsAdapter(acct, { now: () => T0, env: {} }), g.client, TEAMS_TRANSCRIPTS_STREAM, null);
    const items = rendered(out.items);
    expect(items.map(i => i.title)).toEqual(["Board review"]);
    expect(items[0]!.body).toContain(`[[calendar/${accountRef(OWNER, "microsoft")}/${shortHash("ical:ical-board")}]]`);
    expect(out.items.filter(i => i.failure !== undefined)).toEqual([]);
  });

  it("stops rather than store a transcript without its calendar link when the series cannot be read", async () => {
    const res = await firstFailure(transcriptWorld({ masterDown: true }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.response.class).toBe("server_error");
  });
});
