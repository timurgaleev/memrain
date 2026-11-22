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
import { closeLoop, listLoops, muteLoop, recordLoopThread, sweepLoops, syncFreshness, type OpenLoopRow } from "../src/core/loops/store.ts";
import type { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
const H = 3_600_000;
const ME = "me@example.com";
const CTX: ConnectorContext = { service: "gmail", accountLabel: ME };
const SRC = "mail";
const OTHER = "mail2";

let seq = 0;
function m(from: string, to: string[], ageHours: number, body: string, subject = "Budget"): MailMessage {
  seq++;
  return {
    id: `s${seq}`, messageIdHeader: null, subject, from: { name: null, email: from }, to: to.map(email => ({ name: null, email })), cc: [],
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

/** Store one conversation's reply state under a page slug of the test's choosing (a chat day page, say). */
async function storeThreadAt(storage: Storage, source: string, slug: string, threadId: string, messages: MailMessage[]): Promise<void> {
  const page = renderMailThread(CTX, { threadId, messages });
  await putPage(storage, { slug, title: page.title, markdown_body: page.body, source_id: source });
  await recordLoopThread(storage.engine(), { sourceId: source, slug, signals: page.loop! });
}

/** An invitation from `organizer` I have not answered, for a meeting two days ahead. */
async function storeInvite(storage: Storage, source: string, id: string, organizer: string): Promise<void> {
  const page = renderCalendarEvent({ service: "google_calendar", accountLabel: ME }, {
    id, iCalUID: `${id}@x`, title: "Review", description: null, location: null, start: new Date(NOW.getTime() + 48 * H).toISOString(), end: null,
    allDay: false, status: "confirmed", organizer: { name: null, email: organizer }, attendees: [{ name: null, email: ME, response: "needsAction" }], recurrence: null,
  });
  await putPage(storage, { slug: `${source}/${page.slug}`, markdown_body: page.body, source_id: source });
  await recordLoopThread(storage.engine(), { sourceId: source, slug: `${source}/${page.slug}`, signals: page.loop! });
}

const snapshot = async (e: Engine) => ({
  loops: (await e.query(`SELECT id, status, closed_by, closed_at, updated_at FROM open_loops ORDER BY id`)).rows,
  suppressions: (await e.query(`SELECT source_id, kind, value_hash FROM loop_suppressions ORDER BY kind, value_hash`)).rows,
});

/** The loop whose thread subject is `subject`. */
const bySubject = (loops: OpenLoopRow[], subject: string) => loops.find(l => l.summary.endsWith(`"${subject}"`))!;

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

  // Value: protects=a sender mute closes exactly that sender's reply-owed loops in its source;
  // fails_when=it closes other loop types or another source's loops, or leaves the owed ones open.
  it("a sender mute stops new loops and closes only that sender's reply-owed loops in its source", async () => {
    const { db, e } = await setup();
    try {
      await storeThread(db.storage, SRC, "t3", [m("bob@example.com", [ME], 48, "Can you call?")]);
      await storeThread(db.storage, SRC, "t3b", [m("bob@example.com", [ME], 40, "And the budget?")]);
      await storeThread(db.storage, SRC, "t3c", [m(ME, ["bob@example.com"], 48, "I'll send the deck tomorrow.")]);
      await storeThread(db.storage, SRC, "t3d", [m("carol@example.com", [ME], 48, "Lunch?")]);
      await storeInvite(db.storage, SRC, "inv1", "bob@example.com");
      await storeThread(db.storage, OTHER, "t3e", [m("bob@example.com", [ME], 48, "Other mailbox?")]);
      await sweepLoops(e, SRC, NOW);
      await sweepLoops(e, OTHER, NOW);
      const all = await openLoops(e);
      expect(all.map(l => `${l.source_id}:${l.loop_type}`).sort()).toEqual([
        `${OTHER}:unanswered_inbound`, `${SRC}:commitment_owed_by_me`, `${SRC}:rsvp_owed`,
        `${SRC}:unanswered_inbound`, `${SRC}:unanswered_inbound`, `${SRC}:unanswered_inbound`,
      ]);
      const owed = all.filter(l => l.loop_type === "unanswered_inbound" && l.source_id === SRC && l.counterparty === "bob@example.com")
        .map(l => l.id).sort((a, b) => a - b);
      expect(owed).toHaveLength(2);

      const r = await muteLoop(e, undefined, owed[0]!, "sender", true, { now: NOW });
      expect(r).toEqual({ source_id: SRC, kind: "sender", changed: true, closed: owed });
      const after = await listLoops(e, undefined, { status: "all" });
      for (const l of after) {
        const muted = owed.includes(l.id);
        expect({ id: l.id, status: l.status, closed_by: l.closed_by }).toEqual({ id: l.id, status: muted ? "dropped" : "open", closed_by: muted ? "muted" : null });
      }
      expect(after.find(l => l.loop_type === "rsvp_owed")!.status).toBe("open");
      expect(after.find(l => l.loop_type === "commitment_owed_by_me")!.status).toBe("open");
      expect(after.find(l => l.source_id === OTHER)!.status).toBe("open");
      // A new thread from the muted sender opens nothing; muting again closes nothing more.
      await storeThread(db.storage, SRC, "t4", [m("bob@example.com", [ME], 30, "And another thing?")]);
      expect((await sweepLoops(e, SRC, NOW)).opened).toBe(0);
      expect(await muteLoop(e, undefined, owed[0]!, "sender", true, { now: NOW })).toEqual({ source_id: SRC, kind: "sender", changed: false, closed: [] });
    } finally { await db.close(); }
  });

  // Value: protects=a mute preview is honest and side-effect free; fails_when=dry_run writes or lists a different set.
  it("a mute dry run lists what it would close and changes nothing", async () => {
    const { db, e } = await setup();
    try {
      await storeThread(db.storage, SRC, "t9", [m("bob@example.com", [ME], 48, "Can you call?")]);
      await storeThread(db.storage, SRC, "t9b", [m("bob@example.com", [ME], 40, "Ping?")]);
      await sweepLoops(e, SRC, NOW);
      const before = await snapshot(e);
      const [first] = await openLoops(e);
      const preview = await muteLoop(e, undefined, first!.id, "sender", true, { dryRun: true, now: NOW });
      expect(await snapshot(e)).toEqual(before);
      const applied = await muteLoop(e, undefined, first!.id, "sender", true, { now: NOW });
      expect(preview).toEqual({ source_id: SRC, kind: "sender", changed: true, dry_run: true, would_close: applied!.closed });
      expect(applied!.closed).toHaveLength(2);
    } finally { await db.close(); }
  });

  // Value: protects=an unmute touches only what the mute closed and respects other mutes;
  // fails_when=an owner close is reopened or a loop still under a thread mute comes back.
  it("an unmute never touches owner closes and keeps loops another mute still covers closed", async () => {
    const { db, e } = await setup();
    try {
      await storeThread(db.storage, SRC, "ta", [m("bob@example.com", [ME], 48, "A?", "A")]);
      await storeThread(db.storage, SRC, "tb", [m("bob@example.com", [ME], 47, "B?", "B")]);
      await storeThread(db.storage, SRC, "tc", [m("bob@example.com", [ME], 46, "C?", "C")]);
      await sweepLoops(e, SRC, NOW);
      const bySummary = async () => {
        const all = await listLoops(e, undefined, { status: "all" });
        return { "A?": bySubject(all, "A"), "B?": bySubject(all, "B"), "C?": bySubject(all, "C") };
      };
      let s = await bySummary();
      const [a, b, c] = [s["A?"].id, s["B?"].id, s["C?"].id];
      await closeLoop(e, undefined, c, "dropped");
      expect((await muteLoop(e, undefined, b, "thread", true, { now: NOW }))!.closed).toEqual([b]);
      expect((await muteLoop(e, undefined, a, "sender", true, { now: NOW }))!.closed).toEqual([a]);
      const r = await muteLoop(e, undefined, a, "sender", false, { now: NOW });
      expect(r).toEqual({ source_id: SRC, kind: "sender", changed: true, reopened: [a], answered: [], stayed_muted: [b], unverifiable: [] });
      s = await bySummary();
      expect([s["A?"].status, s["A?"].closed_by]).toEqual(["open", null]);
      expect([s["B?"].status, s["B?"].closed_by]).toEqual(["dropped", "muted"]);
      expect([s["C?"].status, s["C?"].closed_by]).toEqual(["dropped", "owner"]);
      // Lifting the thread mute brings the last one back.
      expect((await muteLoop(e, undefined, b, "thread", false, { now: NOW }))!.reopened).toEqual([b]);
    } finally { await db.close(); }
  });

  // Value: protects=an unmute re-judges from stored replies with the sweep's page rules, sweep off;
  // fails_when=it reopens a loop I answered after the mute, or calls a merged thread with one deleted day page unverifiable.
  it("an unmute closes loops answered since the mute and reopens the rest, judging whole threads on live pages", async () => {
    const { db, e } = await setup();
    try {
      const ask = m("bob@example.com", [ME], 48, "Can you sign?", "sign");
      await storeThread(db.storage, SRC, "r1", [ask]);
      await storeThread(db.storage, SRC, "r2", [m("bob@example.com", [ME], 47, "Still owed?", "Still")]);
      const gone = await storeThread(db.storage, SRC, "r3", [m("bob@example.com", [ME], 46, "Gone?", "Gone")]);
      // One conversation over two day pages: the loop rests on the newer page.
      const day1 = m("bob@example.com", [ME], 60, "Day one?", "Day");
      const day2 = m("bob@example.com", [ME], 45, "Day two?", "Day");
      await storeThreadAt(db.storage, SRC, `${SRC}/split-day-1`, "r4", [day1]);
      await storeThreadAt(db.storage, SRC, `${SRC}/split-day-2`, "r4", [day1, day2]);
      await sweepLoops(e, SRC, NOW);
      const open = await openLoops(e);
      expect(open).toHaveLength(4);
      const id = (subject: string) => bySubject(open, subject).id;
      expect(bySubject(open, "Day").page_slug).toBe(`${SRC}/split-day-2`);
      const muted = await muteLoop(e, undefined, id("sign"), "sender", true, { now: NOW });
      expect(muted!.closed).toHaveLength(4);

      // After the mute I answer r1, r3's page is deleted, and so is the r4 day page the loop rested on.
      await storeThread(db.storage, SRC, "r1", [ask, m(ME, ["bob@example.com"], 2, "Signed.", "sign")]);
      await deletePage(db.storage, gone, undefined, SRC);
      await deletePage(db.storage, `${SRC}/split-day-2`, undefined, SRC);

      const later = new Date(NOW.getTime() + H);
      const preview = await muteLoop(e, undefined, id("sign"), "sender", false, { now: later, dryRun: true });
      const r = await muteLoop(e, undefined, id("sign"), "sender", false, { now: later });
      const expected = { source_id: SRC, kind: "sender" as const, changed: true, reopened: [id("Still"), id("Day")].sort((a, b) => a - b), answered: [id("sign")], stayed_muted: [], unverifiable: [id("Gone")] };
      expect(r).toEqual(expected);
      expect(preview).toEqual({ ...expected, dry_run: true });
      const rows = Object.fromEntries((await e.query<{ id: number; status: string; closed_by: string | null; page_slug: string }>(
        `SELECT id, status, closed_by, page_slug FROM open_loops`)).rows.map(x => [Number(x.id), x]));
      expect([rows[id("sign")]!.status, rows[id("sign")]!.closed_by]).toEqual(["done", "reply"]);
      expect([rows[id("Still")]!.status, rows[id("Still")]!.closed_by]).toEqual(["open", null]);
      expect([rows[id("Gone")]!.status, rows[id("Gone")]!.closed_by]).toEqual(["dropped", "unmuted"]);
      // Judged from the day page still alive, not called unverifiable for the one deleted.
      expect([rows[id("Day")]!.status, rows[id("Day")]!.page_slug]).toEqual(["open", `${SRC}/split-day-1`]);
    } finally { await db.close(); }
  });

  // Value: protects=an unmute never reopens a loop now owed to another muted sender, and that sender's
  // unmute brings it back; fails_when=the loop reopens on the old counterparty or is stranded closed.
  it("an unmute keeps a loop closed when the reply is now owed to another muted sender", async () => {
    const { db, e } = await setup();
    try {
      const bobAsk = m("bob@example.com", [ME], 48, "Can you sign?", "Shared");
      await storeThread(db.storage, SRC, "o1", [bobAsk]);
      await storeThread(db.storage, SRC, "o2", [m("carol@example.com", [ME], 47, "Lunch?", "Carol")]);
      await sweepLoops(e, SRC, NOW);
      const open = await openLoops(e);
      const shared = bySubject(open, "Shared").id;
      const carols = bySubject(open, "Carol").id;
      await muteLoop(e, undefined, shared, "sender", true, { now: NOW });
      await muteLoop(e, undefined, carols, "sender", true, { now: NOW });
      // After both mutes Carol writes last on the shared thread.
      await storeThread(db.storage, SRC, "o1", [bobAsk, m("carol@example.com", [ME], 30, "Me too?", "Shared")]);
      const r = await muteLoop(e, undefined, shared, "sender", false, { now: NOW });
      expect(r).toMatchObject({ reopened: [], stayed_muted: [shared] });
      const row = (await listLoops(e, undefined, { status: "all" })).find(l => l.id === shared)!;
      expect([row.status, row.closed_by, row.counterparty]).toEqual(["dropped", "muted", "carol@example.com"]);
      // Lifting Carol's mute re-judges both loops now keyed to her.
      expect((await muteLoop(e, undefined, carols, "sender", false, { now: NOW }))!.reopened).toEqual([shared, carols].sort((a, b) => a - b));
    } finally { await db.close(); }
  });

  // Value: protects=a mute that lands while an unmute re-keys the loop acts on the loop's current sender;
  // fails_when=the key read before the lock is used, so the second unmute lifts the old sender and strands the loop.
  it("two racing unmutes of one loop follow the sender it was re-keyed to", async () => {
    const { db, e } = await setup();
    try {
      const bobAsk = m("bob@example.com", [ME], 48, "Can you sign?", "Shared");
      await storeThread(db.storage, SRC, "k1", [bobAsk]);
      await storeThread(db.storage, SRC, "k2", [m("carol@example.com", [ME], 47, "Lunch?", "Carol")]);
      await sweepLoops(e, SRC, NOW);
      const open = await openLoops(e);
      const shared = bySubject(open, "Shared").id;
      await muteLoop(e, undefined, shared, "sender", true, { now: NOW });
      await muteLoop(e, undefined, bySubject(open, "Carol").id, "sender", true, { now: NOW });
      await storeThread(db.storage, SRC, "k1", [bobAsk, m("carol@example.com", [ME], 30, "Me too?", "Shared")]);
      await Promise.all([
        muteLoop(e, undefined, shared, "sender", false, { now: NOW }),
        muteLoop(e, undefined, shared, "sender", false, { now: NOW }),
      ]);
      expect((await e.query(`SELECT kind FROM loop_suppressions`)).rows).toEqual([]);
      expect((await openLoops(e)).map(l => l.id).sort((a, b) => a - b)).toEqual(open.map(l => l.id).sort((a, b) => a - b));
    } finally { await db.close(); }
  });

  // Value: protects=a sweep that read its suppressions before a mute committed never reopens the muted loop;
  // fails_when=the upsert trusts the sweep's stale suppression set.
  it("a sweep does not reopen a loop muted after it read the suppressions", async () => {
    const { db, e } = await setup();
    try {
      const ask = m("bob@example.com", [ME], 48, "Can you sign?");
      await storeThread(db.storage, SRC, "w1", [ask]);
      await sweepLoops(e, SRC, NOW);
      const [loop] = await openLoops(e);
      const key = (await e.query<{ counterparty_key: string }>(`SELECT counterparty_key FROM open_loops`)).rows[0]!.counterparty_key;
      // Bob nudges, so the next sweep has newer activity that would reopen a closed loop.
      await storeThread(db.storage, SRC, "w1", [ask, m("bob@example.com", [ME], 30, "Any news?")]);
      // A mute that commits mid-sweep: after the two leading closes and the suppression read,
      // the sweep's third UPDATE statement is this thread's close of the other side.
      await e.exec(`CREATE TABLE loops_race_test (n INT NOT NULL);
        INSERT INTO loops_race_test VALUES (0);
        CREATE FUNCTION loops_race_test_fn() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE loops_race_test SET n = n + 1;
          IF (SELECT n FROM loops_race_test) = 3 THEN
            INSERT INTO loop_suppressions (source_id, kind, value_hash) VALUES ('${SRC}', 'sender', '${key}');
            UPDATE open_loops SET status = 'dropped', closed_at = NOW(), closed_by = 'muted' WHERE id = ${loop!.id};
          END IF;
          RETURN NULL;
        END $$;
        CREATE TRIGGER loops_race_test_trg AFTER UPDATE ON open_loops FOR EACH STATEMENT EXECUTE FUNCTION loops_race_test_fn();`);
      await sweepLoops(e, SRC, NOW);
      expect((await e.query<{ n: number }>(`SELECT n FROM loops_race_test`)).rows[0]!.n).toBeGreaterThanOrEqual(3);
      expect((await e.query(`SELECT status, closed_by FROM open_loops`)).rows).toEqual([{ status: "dropped", closed_by: "muted" }]);
      await e.exec(`DROP TRIGGER loops_race_test_trg ON open_loops; DROP FUNCTION loops_race_test_fn(); DROP TABLE loops_race_test;`);
    } finally { await db.close(); }
  });

  // Value: protects=a mute-closed loop stays closed when a racing sweep's suppression check misses the
  // mute (Postgres: the mute is still committing); fails_when=the conflict update reopens it on newer activity.
  // Runs on Postgres too when MEMRAIN_TEST_POSTGRES_URL is set (storageEngines).
  it("a sweep never reopens a mute-closed loop, even when it cannot see the suppression yet", async () => {
    const { db, e } = await setup();
    try {
      const ask = m("bob@example.com", [ME], 48, "Can you sign?");
      await storeThread(db.storage, SRC, "v1", [ask]);
      await sweepLoops(e, SRC, NOW);
      const [loop] = await openLoops(e);
      await storeThread(db.storage, SRC, "v1", [ask, m("bob@example.com", [ME], 30, "Any news?")]);
      // The mute's close lands mid-sweep, but its suppression row is not visible to the sweep.
      await e.exec(`CREATE TABLE loops_snap_test (n INT NOT NULL);
        INSERT INTO loops_snap_test VALUES (0);
        CREATE FUNCTION loops_snap_test_fn() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE loops_snap_test SET n = n + 1;
          IF (SELECT n FROM loops_snap_test) = 3 THEN
            UPDATE open_loops SET status = 'dropped', closed_at = NOW(), closed_by = 'muted' WHERE id = ${loop!.id};
          END IF;
          RETURN NULL;
        END $$;
        CREATE TRIGGER loops_snap_test_trg AFTER UPDATE ON open_loops FOR EACH STATEMENT EXECUTE FUNCTION loops_snap_test_fn();`);
      await sweepLoops(e, SRC, NOW);
      expect((await e.query<{ n: number }>(`SELECT n FROM loops_snap_test`)).rows[0]!.n).toBeGreaterThanOrEqual(3);
      expect((await e.query(`SELECT status, closed_by FROM open_loops`)).rows).toEqual([{ status: "dropped", closed_by: "muted" }]);
      await e.exec(`DROP TRIGGER loops_snap_test_trg ON open_loops; DROP FUNCTION loops_snap_test_fn(); DROP TABLE loops_snap_test;`);
    } finally { await db.close(); }
  });

  // Value: protects=the suppression and the loops it closes change together; fails_when=a failure
  // between the two writes leaves a mute with open loops, or an unmute with loops still closed.
  it("a failure between the suppression and the loop change rolls both back", async () => {
    const { db, e } = await setup();
    try {
      await storeThread(db.storage, SRC, "f1", [m("bob@example.com", [ME], 48, "Can you call?")]);
      await sweepLoops(e, SRC, NOW);
      const [loop] = await openLoops(e);
      await e.exec(`CREATE FUNCTION loops_fail_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
      await e.exec(`CREATE TRIGGER loops_fail_mute BEFORE UPDATE ON open_loops FOR EACH ROW
        WHEN (NEW.closed_by = 'muted') EXECUTE FUNCTION loops_fail_test()`);
      await expect(muteLoop(e, undefined, loop!.id, "sender", true, { now: NOW })).rejects.toThrow(/injected failure/);
      expect((await e.query(`SELECT 1 FROM loop_suppressions`)).rows).toEqual([]);
      expect((await openLoops(e)).map(l => l.id)).toEqual([loop!.id]);

      await e.exec(`DROP TRIGGER loops_fail_mute ON open_loops`);
      await muteLoop(e, undefined, loop!.id, "sender", true, { now: NOW });
      await e.exec(`CREATE TRIGGER loops_fail_unmute BEFORE UPDATE ON open_loops FOR EACH ROW
        WHEN (NEW.status = 'open') EXECUTE FUNCTION loops_fail_test()`);
      await expect(muteLoop(e, undefined, loop!.id, "sender", false, { now: NOW })).rejects.toThrow(/injected failure/);
      expect((await e.query(`SELECT kind FROM loop_suppressions`)).rows).toEqual([{ kind: "sender" }]);
      expect((await e.query(`SELECT status, closed_by FROM open_loops`)).rows).toEqual([{ status: "dropped", closed_by: "muted" }]);
      await e.exec(`DROP TRIGGER loops_fail_unmute ON open_loops; DROP FUNCTION loops_fail_test()`);
    } finally { await db.close(); }
  });

  // Value: protects=racing mute and unmute end consistent; fails_when=the suppression and the loop state disagree.
  it("concurrent mutes and unmutes of one sender leave the suppression and the loop in agreement", async () => {
    const { db, e } = await setup();
    try {
      await storeThread(db.storage, SRC, "c1", [m("bob@example.com", [ME], 48, "Can you call?")]);
      await sweepLoops(e, SRC, NOW);
      const [loop] = await openLoops(e);
      for (let round = 0; round < 4; round++) {
        await Promise.all([
          muteLoop(e, undefined, loop!.id, "sender", round % 2 === 0, { now: NOW }),
          muteLoop(e, undefined, loop!.id, "sender", round % 2 !== 0, { now: NOW }),
        ]);
        const suppressed = (await e.query(`SELECT 1 FROM loop_suppressions`)).rows.length > 0;
        const [row] = (await e.query<{ status: string; closed_by: string | null }>(`SELECT status, closed_by FROM open_loops`)).rows;
        expect({ suppressed, row }).toEqual(suppressed
          ? { suppressed, row: { status: "dropped", closed_by: "muted" } }
          : { suppressed, row: { status: "open", closed_by: null } });
      }
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
