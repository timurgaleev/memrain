/**
 * The loop store on both engines: thread states recorded from rendered
 * connector pages, the sweep opening and closing loops from them, the owner's
 * closes and mutes, source scoping, and sync freshness.
 */
import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { deletePage, putPage } from "../src/core/pages.ts";
import { renderCalendarEvent, renderMailThread } from "../src/core/connectors/render.ts";
import type { ConnectorContext, MailMessage } from "../src/core/connectors/model.ts";
import { closeLoop, listLoops, muteLoop, recordLoopThread, sweepLoops, syncFreshness } from "../src/core/loops/store.ts";
import type { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
const H = 3_600_000;
const ME = "me@example.com";
const CTX: ConnectorContext = { service: "gmail", accountLabel: ME };
const SRC = "mail";
const OTHER = "mail2";

let seq = 0;
function m(from: string, to: string[], ageHours: number, body: string): MailMessage {
  seq++;
  return {
    id: `s${seq}`, messageIdHeader: null, subject: "Budget", from: { name: null, email: from }, to: to.map(email => ({ name: null, email })), cc: [],
    date: new Date(NOW.getTime() - ageHours * H).toISOString(), bodyText: body, bodyHtml: null, attachments: [], listUnsubscribe: false, categories: [],
  };
}

/** Store a mail thread's page and its reply state, as the sync does. */
async function storeThread(storage: Storage, source: string, threadId: string, messages: MailMessage[]): Promise<string> {
  const page = renderMailThread(CTX, { threadId, messages });
  const slug = `${source}/${page.slug}`;
  await putPage(storage, { slug, title: page.title, markdown_body: page.body, source_id: source });
  await recordLoopThread(storage.engine(), { sourceId: source, slug, signals: page.loop! });
  return slug;
}

const openLoops = (e: Engine, scope?: string[]) => listLoops(e, scope);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`loop store (${name})`, () => {
  async function setup() {
    const db = await open();
    const e = db.storage.engine();
    await registerSource(e, { id: SRC, kind: "mailbox", pathPrefix: `${SRC}/` });
    await registerSource(e, { id: OTHER, kind: "mailbox", pathPrefix: `${OTHER}/` });
    return { db, e };
  }

  it("opens a loop from a recorded thread and closes it with closed_by=reply when I answer", async () => {
    const { db, e } = await setup();
    try {
      await storeThread(db.storage, SRC, "t1", [m("bob@example.com", [ME], 48, "Can you approve the budget?")]);
      expect(await sweepLoops(e, SRC, NOW)).toMatchObject({ threads: 1, opened: 1, closed: 0 });
      const [loop] = await openLoops(e);
      expect(loop).toMatchObject({ loop_type: "unanswered_inbound", status: "open", source_id: SRC, counterparty: "bob@example.com" });
      expect(loop!.summary).toBe(`Reply owed to bob@example.com: "Budget"`);
      // A second sweep over the same state changes nothing.
      expect(await sweepLoops(e, SRC, NOW)).toMatchObject({ opened: 0, closed: 0 });

      await storeThread(db.storage, SRC, "t1", [m("bob@example.com", [ME], 48, "Can you approve the budget?"), m(ME, ["bob@example.com"], 1, "Approved.")]);
      expect(await sweepLoops(e, SRC, NOW)).toMatchObject({ closed: 1 });
      expect(await openLoops(e)).toEqual([]);
      const [closed] = await listLoops(e, undefined, { status: "all" });
      expect(closed).toMatchObject({ status: "done", closed_by: "reply" });
    } finally { await db.close(); }
  });

  it("an open loop with no activity for 90 days goes stale and leaves the list; a younger one stays", async () => {
    const { db, e } = await setup();
    try {
      await storeThread(db.storage, SRC, "t-old", [m("bob@example.com", [ME], 48, "Can you approve the budget?")]);
      await storeThread(db.storage, SRC, "t-young", [m("carol@example.com", [ME], 30, "Can you call me?")]);
      expect(await sweepLoops(e, SRC, NOW)).toMatchObject({ opened: 2 });
      // Nobody answered either thread. Twenty days on the younger one is still owed.
      const later = new Date(NOW.getTime() + 20 * 24 * H);
      expect((await sweepLoops(e, SRC, later)).closed).toBe(0);
      expect(await openLoops(e)).toHaveLength(2);
      // Ninety days after the last message the loop is stale, not answered.
      const muchLater = new Date(NOW.getTime() - 48 * H + 90 * 24 * H + H);
      expect((await sweepLoops(e, SRC, muchLater)).closed).toBe(1);
      expect((await openLoops(e)).map(l => l.counterparty)).toEqual(["carol@example.com"]);
      const stale = (await listLoops(e, undefined, { status: "stale" }));
      expect(stale).toMatchObject([{ counterparty: "bob@example.com", closed_by: "staleness" }]);
      // A later sweep does not reopen it from the same old thread.
      expect((await sweepLoops(e, SRC, muchLater)).opened).toBe(0);
    } finally { await db.close(); }
  });

  it("keeps the owner's done until the thread has newer activity", async () => {
    const { db, e } = await setup();
    try {
      await storeThread(db.storage, SRC, "t2", [m("bob@example.com", [ME], 48, "Can you sign?")]);
      await sweepLoops(e, SRC, NOW);
      const [loop] = await openLoops(e);
      expect((await closeLoop(e, undefined, loop!.id, "done"))!.closed_by).toBe("owner");
      await sweepLoops(e, SRC, NOW);
      expect(await openLoops(e)).toEqual([]);
      // Their nudge is newer activity: the loop is theirs to reopen.
      await storeThread(db.storage, SRC, "t2", [m("bob@example.com", [ME], 48, "Can you sign?"), m("bob@example.com", [ME], 30, "Any news?")]);
      expect(await sweepLoops(e, SRC, NOW)).toMatchObject({ opened: 1 });
      expect((await openLoops(e)).map(l => l.id)).toEqual([loop!.id]);
    } finally { await db.close(); }
  });

  it("a mute stops new loops and leaves existing ones alone", async () => {
    const { db, e } = await setup();
    try {
      await storeThread(db.storage, SRC, "t3", [m("bob@example.com", [ME], 48, "Can you call?")]);
      await sweepLoops(e, SRC, NOW);
      const [loop] = await openLoops(e);
      expect(await muteLoop(e, undefined, loop!.id, "sender", true)).toEqual({ source_id: SRC, kind: "sender", changed: true });
      await storeThread(db.storage, SRC, "t4", [m("bob@example.com", [ME], 48, "And another thing?")]);
      await sweepLoops(e, SRC, NOW);
      // The old loop stays open; the new thread from the muted sender opens nothing.
      expect((await openLoops(e)).map(l => l.id)).toEqual([loop!.id]);
      expect(await muteLoop(e, undefined, loop!.id, "sender", false)).toMatchObject({ changed: true });
      await sweepLoops(e, SRC, NOW);
      expect(await openLoops(e)).toHaveLength(2);
    } finally { await db.close(); }
  });

  it("a deleted page drops its loops and they leave the list at once", async () => {
    const { db, e } = await setup();
    try {
      const slug = await storeThread(db.storage, SRC, "t5", [m("bob@example.com", [ME], 48, "Can you?")]);
      await sweepLoops(e, SRC, NOW);
      await deletePage(db.storage, slug, undefined, SRC);
      expect(await openLoops(e)).toEqual([]);
      expect(await sweepLoops(e, SRC, NOW)).toMatchObject({ closed: 1 });
      expect((await e.query(`SELECT status, closed_by FROM open_loops`)).rows).toEqual([{ status: "dropped", closed_by: "page_deleted" }]);
    } finally { await db.close(); }
  });

  it("reads only the caller's sources; an empty grant reads nothing", async () => {
    const { db, e } = await setup();
    try {
      await storeThread(db.storage, SRC, "t6", [m("bob@example.com", [ME], 48, "Can you?")]);
      await storeThread(db.storage, OTHER, "t7", [m("carol@example.com", [ME], 48, "Can you?")]);
      await sweepLoops(e, SRC, NOW);
      await sweepLoops(e, OTHER, NOW);
      expect((await openLoops(e, [SRC])).map(l => l.source_id)).toEqual([SRC]);
      expect(await openLoops(e, [])).toEqual([]);
      expect(await openLoops(e)).toHaveLength(2);
      // The owner's controls are scoped too.
      const theirs = (await openLoops(e, [OTHER]))[0]!;
      expect(await closeLoop(e, [SRC], theirs.id, "done")).toBeNull();
      expect(await muteLoop(e, [SRC], theirs.id, "thread", true)).toBeNull();
    } finally { await db.close(); }
  });

  it("does not record a state for a page in another source", async () => {
    const { db, e } = await setup();
    try {
      const page = renderMailThread(CTX, { threadId: "t8", messages: [m("bob@example.com", [ME], 48, "Hi?")] });
      await putPage(db.storage, { slug: `${OTHER}/x`, markdown_body: "x", source_id: OTHER });
      expect(await recordLoopThread(e, { sourceId: SRC, slug: `${OTHER}/x`, signals: page.loop! })).toBe(false);
      expect(await recordLoopThread(e, { sourceId: SRC, slug: `${SRC}/missing`, signals: page.loop! })).toBe(false);
    } finally { await db.close(); }
  });

  it("judges every thread of a source larger than one batch, keeping each thread whole", async () => {
    const { db, e } = await setup();
    try {
      for (let i = 0; i < 5; i++) await storeThread(db.storage, SRC, `big-${i}`, [m(`p${i}@example.com`, [ME], 48, "Can you?")]);
      expect(await sweepLoops(e, SRC, NOW, { batchSize: 2 })).toMatchObject({ threads: 5, opened: 5 });
      expect(await openLoops(e)).toHaveLength(5);
    } finally { await db.close(); }
  });

  it("a weekly invitation stays owed until its last listed occurrence has started", async () => {
    const { db, e } = await setup();
    try {
      await registerSource(e, { id: "cal", kind: "calendar", pathPrefix: "cal/" });
      const at = (h: number) => new Date(NOW.getTime() + h * H).toISOString();
      const page = renderCalendarEvent({ service: "google_calendar", accountLabel: ME }, {
        id: "s1", iCalUID: "s1@x", title: "Weekly", description: null, location: null, start: at(-24 * 7), end: null, allDay: false, status: "confirmed",
        organizer: { name: "Bob", email: "bob@example.com" }, attendees: [{ name: null, email: ME, response: "needsAction" }],
        recurrence: ["RRULE:FREQ=WEEKLY"],
        occurrences: [
          { start: at(-24 * 7), end: null, status: "confirmed" },
          { start: at(24), end: null, status: "cancelled" },
          { start: at(48), end: null, status: "confirmed" },
        ],
      });
      await putPage(db.storage, { slug: `cal/${page.slug}`, markdown_body: page.body, source_id: "cal" });
      await recordLoopThread(e, { sourceId: "cal", slug: `cal/${page.slug}`, signals: page.loop! });
      await sweepLoops(e, "cal", NOW);
      // The cancelled occurrence is skipped: due at the next one that happens.
      expect((await openLoops(e, ["cal"]))[0]).toMatchObject({ loop_type: "rsvp_owed", due_at: at(48) });
      await sweepLoops(e, "cal", new Date(NOW.getTime() + 49 * H));
      expect((await listLoops(e, ["cal"], { status: "all" }))[0]).toMatchObject({ status: "stale", closed_by: "expired" });
    } finally { await db.close(); }
  });

  it("an invitation sent months ahead stays owed past the 90-day staleness, until the meeting", async () => {
    const { db, e } = await setup();
    try {
      await registerSource(e, { id: "cal", kind: "calendar", pathPrefix: "cal/" });
      const start = new Date(NOW.getTime() + 120 * 24 * H).toISOString();
      const page = renderCalendarEvent({ service: "google_calendar", accountLabel: ME }, {
        id: "far1", iCalUID: "far1@x", title: "Offsite", description: null, location: null, start, end: null, allDay: false, status: "confirmed",
        organizer: { name: "Bob", email: "bob@example.com" }, attendees: [{ name: null, email: ME, response: "needsAction" }], recurrence: null,
      });
      await putPage(db.storage, { slug: `cal/${page.slug}`, markdown_body: page.body, source_id: "cal" });
      await recordLoopThread(e, { sourceId: "cal", slug: `cal/${page.slug}`, signals: page.loop! });
      await sweepLoops(e, "cal", NOW);
      expect(await sweepLoops(e, "cal", new Date(NOW.getTime() + 100 * 24 * H))).toMatchObject({ closed: 0 });
      expect((await openLoops(e, ["cal"]))[0]).toMatchObject({ loop_type: "rsvp_owed", due_at: start });
    } finally { await db.close(); }
  });

  it("an RSVP loop expires when the meeting starts", async () => {
    const { db, e } = await setup();
    try {
      await registerSource(e, { id: "cal", kind: "calendar", pathPrefix: "cal/" });
      const start = new Date(NOW.getTime() + 2 * H).toISOString();
      const page = renderCalendarEvent({ service: "google_calendar", accountLabel: ME }, {
        id: "e1", iCalUID: "e1@x", title: "Review", description: null, location: null, start, end: null, allDay: false, status: "confirmed",
        organizer: { name: "Bob", email: "bob@example.com" }, attendees: [{ name: null, email: ME, response: "needsAction" }], recurrence: null,
      });
      await putPage(db.storage, { slug: `cal/${page.slug}`, markdown_body: page.body, source_id: "cal" });
      await recordLoopThread(e, { sourceId: "cal", slug: `cal/${page.slug}`, signals: page.loop! });
      await sweepLoops(e, "cal", NOW);
      expect((await openLoops(e, ["cal"]))[0]).toMatchObject({ loop_type: "rsvp_owed", due_at: start });
      // Re-sweeping an unchanged event does not move its activity, so an owner close holds.
      const before = (await openLoops(e, ["cal"]))[0]!.last_activity_at;
      await sweepLoops(e, "cal", new Date(NOW.getTime() + 60_000));
      expect((await openLoops(e, ["cal"]))[0]!.last_activity_at).toBe(before);
      await sweepLoops(e, "cal", new Date(NOW.getTime() + 3 * H));
      expect((await listLoops(e, ["cal"], { status: "all" }))[0]).toMatchObject({ status: "stale", closed_by: "expired" });
    } finally { await db.close(); }
  });

  it("reports how fresh the mail, chat and calendar syncs are", async () => {
    const { db, e } = await setup();
    try {
      expect(await syncFreshness(e, undefined, NOW, 24)).toEqual({ newest: null, accounts: 0, stale: [] });
      const insert = `INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label, enabled, last_success_at)
        VALUES ($1, $2, $3, 'admin:operator', $4, TRUE, $5)`;
      await e.query(insert, ["00000000-0000-4000-8000-00000000000a", SRC, "google", "a@example.com", new Date(NOW.getTime() - 30 * H).toISOString()]);
      await e.query(insert, ["00000000-0000-4000-8000-00000000000b", OTHER, "google", "b@example.com", new Date(NOW.getTime() - 2 * H).toISOString()]);
      const all = await syncFreshness(e, undefined, NOW, 24);
      expect(all.newest).toBe(new Date(NOW.getTime() - 2 * H).toISOString());
      expect(all.stale.map(s => s.source_id)).toEqual([SRC]);
      expect((await syncFreshness(e, [SRC], NOW, 24)).newest).toBe(new Date(NOW.getTime() - 30 * H).toISOString());
      // A meeting-transcript account says nothing about mail freshness.
      await registerSource(e, { id: "meet", kind: "meeting", pathPrefix: "meet/" });
      await e.query(insert, ["00000000-0000-4000-8000-00000000000c", "meet", "fireflies", "c@example.com", NOW.toISOString()]);
      expect((await syncFreshness(e, undefined, NOW, 24)).newest).toBe(new Date(NOW.getTime() - 2 * H).toISOString());
    } finally { await db.close(); }
  });
});
