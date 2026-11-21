/**
 * Chronicle event identity (same-day twins) and the ended-invite projection
 * that stands in for the paid judge.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { getTimelineForDate } from "../src/core/chronicle.ts";
import { isChronicleEligible } from "../src/core/chronicle/eligibility.ts";
import { chronicleJudgeKey, runChronicleExtract, type ChronicleEventProposal, type ChronicleJudge } from "../src/core/chronicle/extract-events.ts";
import { assignChronicleEventSlugs, eventDiscriminator, suffixedEventSlug } from "../src/core/chronicle/event-identity.ts";
import { readAutoEvents } from "../src/core/chronicle/retire-events.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-chron-identity-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const LONG_BODY = "x".repeat(120);

function stubJudge(events: ChronicleEventProposal[]): ChronicleJudge {
  return async () => ({ events });
}

const throwingJudge: ChronicleJudge = async () => {
  throw new Error("the paid judge must not be called");
};

async function eventSlugs(): Promise<string[]> {
  const r = await storage.engine().query<{ slug: string }>(
    "SELECT slug FROM pages WHERE type = 'event' AND deleted_at IS NULL ORDER BY slug",
  );
  return r.rows.map((row) => row.slug);
}

async function seedMeeting(slug = "meetings/2026-01-10"): Promise<string> {
  await putPage(storage, {
    slug, type: "meeting", title: "Day",
    compiled_truth: { date: "2026-01-10", attendees: ["people/alice"] },
    markdown_body: LONG_BODY,
  });
  return slug;
}

describe("same-day event identity", () => {
  // Value: protects=two same-day calls with one person stay two events; fails_when=the slug ignores the time again.
  it("keeps two calls with the same person on one day as two events", async () => {
    const slug = await seedMeeting();
    const twins = stubJudge([
      { when: "2026-01-10T10:00:00Z", who: ["people/alice"], what: "Call with Alice", kind: "call" },
      { when: "2026-01-10T15:00:00Z", who: ["people/alice"], what: "Call with Alice", kind: "call" },
    ]);
    const res = await runChronicleExtract(storage, { slug, judge: twins, now: new Date("2026-01-11T00:00:00Z") });
    expect(res.events_written).toBe(2);
    const slugs = await eventSlugs();
    expect(slugs).toHaveLength(2);
    const rows = await getTimelineForDate(storage, "2026-01-10", { sourceIds: ["default"] });
    expect(rows).toHaveLength(2);

    // A re-run, even with the judge's order flipped, lands on the same pages.
    const flipped = stubJudge([
      { when: "2026-01-10T15:00:00Z", who: ["people/alice"], what: "Call with Alice", kind: "call" },
      { when: "2026-01-10T10:00:00Z", who: ["people/alice"], what: "Call with Alice", kind: "call" },
    ]);
    await runChronicleExtract(storage, { slug, judge: flipped, now: new Date("2026-01-11T00:00:00Z") });
    expect(await eventSlugs()).toEqual(slugs);
    const ten = await getPage(storage, slugs.find((s) => !/-[0-9a-f]{6}$/.test(s))!, ["default"]);
    expect((ten!.compiled_truth as { event: { when: string } }).event.when).toBe("2026-01-10T10:00:00Z");
  });

  // Value: protects=an event written before twins existed keeps its slug; fails_when=the earliest twin steals the base page.
  it("leaves an existing event on its slug when a twin appears", async () => {
    const slug = await seedMeeting();
    const late = { when: "2026-01-10T15:00:00Z", who: ["people/alice"], what: "Call with Alice", kind: "call" };
    await runChronicleExtract(storage, { slug, judge: stubJudge([late]), now: new Date("2026-01-11T00:00:00Z") });
    const [base] = await eventSlugs();
    await runChronicleExtract(storage, {
      slug,
      judge: stubJudge([{ ...late, when: "2026-01-10T09:00:00Z" }, late]),
      now: new Date("2026-01-11T00:00:00Z"),
    });
    const after = await eventSlugs();
    expect(after).toHaveLength(2);
    const kept = await getPage(storage, base!, ["default"]);
    expect((kept!.compiled_truth as { event: { when: string } }).event.when).toBe("2026-01-10T15:00:00Z");
  });

  it("numbers identical copies after the first", () => {
    const fields = { when: "2026-01-10", where: null, kind: "call" };
    const base = "life/events/2026-01-10-abcdef12";
    expect(assignChronicleEventSlugs([{ slug: base, fields }, { slug: base, fields }], new Map()))
      .toEqual([base, `${base}-2`]);
  });

  it("keeps a twin on the suffixed slug it already holds", () => {
    const base = "life/events/2026-01-10-abcdef12";
    const a = { when: "2026-01-10T09:00:00Z", where: null, kind: "call" };
    const b = { when: "2026-01-10T15:00:00Z", where: null, kind: "call" };
    const existing = new Map([[base, eventDiscriminator(a)], [suffixedEventSlug(base, eventDiscriminator(b)), eventDiscriminator(b)]]);
    expect(assignChronicleEventSlugs([{ slug: base, fields: b }, { slug: base, fields: a }], existing))
      .toEqual([suffixedEventSlug(base, eventDiscriminator(b)), base]);
  });
});

describe("ended calendar invites", () => {
  async function seedInvite(truth: Record<string, unknown>, slug = "calendar/work/standup"): Promise<string> {
    await putPage(storage, {
      slug, type: "calendar-event", allowAdHocType: true, title: "Weekly standup",
      compiled_truth: { attendees: ["people/alice", "people/bob"], ...truth },
      markdown_body: LONG_BODY,
    });
    return slug;
  }

  // Value: protects=an ended invite costs no paid call; fails_when=calendar pages reach the judge again.
  it("projects an ended invite into one event without calling the judge", async () => {
    const slug = await seedInvite({ start: "2026-01-10T10:00:00Z", end: "2026-01-10T10:30:00Z", location: "Room 4" });
    const res = await runChronicleExtract(storage, { slug, judge: throwingJudge, now: new Date("2026-01-11T00:00:00Z") });
    expect(res.status).toBe("extracted");
    expect(res.events_written).toBe(1);
    const [eventSlug] = await eventSlugs();
    const ev = await getPage(storage, eventSlug!, ["default"]);
    const truth = ev!.compiled_truth as { captured_via: string; event: { when: string; who: string[]; where: string; kind: string; what: string } };
    expect(truth.captured_via).toBe("life-chronicle:invite");
    expect(truth.event).toMatchObject({ when: "2026-01-10T10:00:00Z", who: ["people/alice", "people/bob"], where: "Room 4", kind: "meeting", what: "Scheduled: Weekly standup" });
    // Retirement still sees the projected event.
    expect((await readAutoEvents(storage, slug, "default")).events.map((e) => e.slug)).toEqual([eventSlug!]);
  });

  // Value: protects=a future invite is not paid for; fails_when=the judge is called for a meeting that has not happened.
  it("skips an invite that has not ended without calling the judge", async () => {
    const slug = await seedInvite({ start: "2026-02-10T10:00:00Z", end: "2026-02-10T10:30:00Z" });
    const res = await runChronicleExtract(storage, { slug, judge: throwingJudge, now: new Date("2026-01-11T00:00:00Z") });
    expect(res).toMatchObject({ status: "skipped", reason: "invite_not_ended", events_written: 0 });
    expect(await eventSlugs()).toEqual([]);
  });

  it("gives an invite a new job key once it has ended", async () => {
    const page = { slug: "calendar/work/x", type: "calendar-event", title: "X", markdown_body: LONG_BODY,
      compiled_truth: { start: "2026-02-10T10:00:00Z", end: "2026-02-10T10:30:00Z" } };
    expect(chronicleJudgeKey(page, new Date("2026-01-01T00:00:00Z")))
      .not.toBe(chronicleJudgeKey(page, new Date("2026-03-01T00:00:00Z")));
    const meeting = { slug: "meetings/a", type: "meeting", title: "A", markdown_body: LONG_BODY, compiled_truth: {} };
    expect(chronicleJudgeKey(meeting, new Date("2026-01-01T00:00:00Z")))
      .toBe(chronicleJudgeKey(meeting, new Date("2026-03-01T00:00:00Z")));
  });

  it("keeps the judged path for a cancelled or unstructured calendar page", async () => {
    let calls = 0;
    const judge: ChronicleJudge = async () => { calls += 1; return { events: [] }; };
    const cancelled = await seedInvite({ start: "2026-01-10T10:00:00Z", end: "2026-01-10T10:30:00Z", status: "cancelled" });
    await runChronicleExtract(storage, { slug: cancelled, judge, now: new Date("2026-01-11T00:00:00Z") });
    const bare = await seedInvite({}, "calendar/work/notes");
    await runChronicleExtract(storage, { slug: bare, judge, now: new Date("2026-01-11T00:00:00Z") });
    expect(calls).toBe(2);
  });

  it("leaves connector calendar pages to the sync's own chronicle row", () => {
    expect(isChronicleEligible({ type: "connector-calendar", slug: "calendar/acct/abc", body: LONG_BODY }))
      .toEqual({ ok: false, reason: "connector_page" });
    expect(isChronicleEligible({ type: "calendar-event", slug: "calendar/work/standup", body: LONG_BODY }).ok).toBe(true);
  });
});
