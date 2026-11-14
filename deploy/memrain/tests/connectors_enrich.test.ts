/**
 * Deterministic connector enrichment: links to people the brain already knows,
 * wanted entries for named strangers, one chronicle event per meeting, and
 * nothing at all from bulk mail. No model is called.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { enrichConnectorPage } from "../src/core/connectors/enrich-deterministic.ts";
import { renderCalendarEvent, renderMailThread, type RenderedConnectorPage } from "../src/core/connectors/render.ts";
import type { CalendarEvent, MailThread } from "../src/core/connectors/model.ts";

const OWNER = "owner@example.org";

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "evt-1", iCalUID: "uid-1@example.net", title: "Design review", description: null, location: null,
  start: "2026-11-12T10:00:00.000Z", end: "2026-11-12T11:00:00.000Z", allDay: false, status: "confirmed",
  organizer: { name: "Owner", email: OWNER },
  attendees: [
    { name: "Bob Stone", email: "BOB@example.net", response: "accepted" },
    { name: "Dana Fox", email: "dana@example.net", response: null },
  ],
  recurrence: null, ...over,
});

const mail = (over: Partial<MailThread["messages"][number]> = {}): MailThread => ({
  threadId: "t1",
  messages: [{
    id: "m1", messageIdHeader: null, subject: "Hello", from: { name: "Bob Stone", email: "bob@example.net" },
    to: [{ name: null, email: OWNER }], cc: [], date: "2026-11-01T08:00:00.000Z", bodyText: "hi", bodyHtml: null,
    attachments: [], listUnsubscribe: false, categories: [], ...over,
  }],
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector enrichment (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeEach(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "cal", kind: "calendar", pathPrefix: "calendar/" });
    await registerSource(db.storage.engine(), { id: "inbox", kind: "mailbox", pathPrefix: "mail/" });
    await putPage(db.storage, { slug: "people/bob-stone", markdown_body: "Bob.", compiled_truth: { aliases: ["bob@example.net"] } });
    await putPage(db.storage, { slug: "notes/bob-mail", markdown_body: "not a person", compiled_truth: { aliases: ["dana@example.net"] } });
  });
  afterEach(async () => { await db.close(); });

  const write = async (page: RenderedConnectorPage, source: string) => {
    await putPage(db.storage, { slug: page.slug, type: page.type, allowAdHocType: true, title: page.title, markdown_body: page.body,
      compiled_truth: page.truth, written_by: "connector-test", source_id: source, outsideText: true });
  };
  const enrich = (page: RenderedConnectorPage, source: string) => enrichConnectorPage(db.storage, {
    page, sourceId: source, ownAddresses: [OWNER], peopleSourceIds: ["default", source],
  });
  const links = async (slug: string) => (await db.storage.engine().query<{ target_slug: string; type: string }>(
    "SELECT target_slug, type FROM links WHERE source_slug = $1 ORDER BY target_slug", [slug])).rows;
  const events = async (slug: string) => (await db.storage.engine().query<{ occurred_at: string; event: string }>(
    "SELECT occurred_at::text AS occurred_at, event FROM timeline_events WHERE slug = $1", [slug])).rows;

  it("links a known attendee, records a named stranger as wanted, and creates no person page", async () => {
    const page = renderCalendarEvent({ service: "google_calendar", accountLabel: OWNER }, event());
    await write(page, "cal");
    const result = await enrich(page, "cal");
    expect(result.linked).toEqual(["people/bob-stone"]);
    expect(await links(page.slug)).toEqual([{ target_slug: "people/bob-stone", type: "attended" }]);
    const wanted = (await db.storage.engine().query<{ target_slug: string }>("SELECT target_slug FROM wanted_links WHERE from_slug = $1", [page.slug])).rows;
    expect(wanted).toEqual([{ target_slug: "people/dana-fox" }]);
    expect((await db.storage.engine().query("SELECT 1 FROM pages WHERE slug LIKE 'people/dana%'")).rows).toHaveLength(0);
    expect((await events(page.slug)).map(r => r.event)).toEqual(["Event: Design review"]);
  });

  it("does not duplicate the chronicle event on a re-run, and moves it when the event is rescheduled", async () => {
    const page = renderCalendarEvent({ service: "google_calendar", accountLabel: OWNER }, event());
    await write(page, "cal");
    await enrich(page, "cal");
    await enrich(page, "cal");
    expect(await events(page.slug)).toHaveLength(1);
    const moved = renderCalendarEvent({ service: "google_calendar", accountLabel: OWNER }, event({ start: "2026-11-12T14:00:00.000Z", end: "2026-11-12T15:00:00.000Z" }));
    await enrich(moved, "cal");
    const rows = await events(page.slug);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.occurred_at).toISOString()).toBe("2026-11-12T14:00:00.000Z");
  });

  it("rewrites the chronicle event when the title changes", async () => {
    const page = renderCalendarEvent({ service: "google_calendar", accountLabel: OWNER }, event());
    await write(page, "cal");
    await enrich(page, "cal");
    const renamed = renderCalendarEvent({ service: "google_calendar", accountLabel: OWNER }, event({ title: "Final review" }));
    await enrich(renamed, "cal");
    expect((await events(page.slug)).map(r => r.event)).toEqual(["Event: Final review"]);
  });

  it("drops the chronicle event and the links of an attendee who left", async () => {
    const page = renderCalendarEvent({ service: "google_calendar", accountLabel: OWNER }, event());
    await write(page, "cal");
    await enrich(page, "cal");
    const cancelled = renderCalendarEvent({ service: "google_calendar", accountLabel: OWNER }, event({ status: "cancelled", attendees: [] }));
    await enrich(cancelled, "cal");
    expect(await events(page.slug)).toHaveLength(0);
    expect(await links(page.slug)).toEqual([]);
  });

  it("links a correspondent from mail and never the account's own address", async () => {
    const page = renderMailThread({ service: "gmail", accountLabel: OWNER }, mail());
    await write(page, "inbox");
    const result = await enrich(page, "inbox");
    expect(result.linked).toEqual(["people/bob-stone"]);
    expect(await links(page.slug)).toEqual([{ target_slug: "people/bob-stone", type: "corresponded_with" }]);
    expect(await events(page.slug)).toHaveLength(0);
  });

  it("writes no links, wanted rows or events for bulk mail", async () => {
    const page = renderMailThread({ service: "gmail", accountLabel: OWNER }, mail({ listUnsubscribe: true }));
    await write(page, "inbox");
    const result = await enrich(page, "inbox");
    expect(result).toEqual({ linked: [], wanted: 0, timeline: false });
    expect(await links(page.slug)).toEqual([]);
    expect((await db.storage.engine().query("SELECT 1 FROM wanted_links WHERE from_slug = $1", [page.slug])).rows).toHaveLength(0);
  });

  it("resolves people only inside the scope it is given", async () => {
    const page = renderMailThread({ service: "gmail", accountLabel: OWNER }, mail());
    await write(page, "inbox");
    const result = await enrichConnectorPage(db.storage, { page, sourceId: "inbox", ownAddresses: [OWNER], peopleSourceIds: ["inbox"] });
    expect(result.linked).toEqual([]);
  });

  it("records a stranger as wanted even when a page with that slug exists outside its scope", async () => {
    // A people page in a source the caller may not read must not decide what
    // this source sees: its existence would otherwise show through the wanted list.
    const page = renderMailThread({ service: "gmail", accountLabel: OWNER }, mail());
    await write(page, "inbox");
    const result = await enrichConnectorPage(db.storage, { page, sourceId: "inbox", ownAddresses: [OWNER], peopleSourceIds: ["inbox"] });
    expect(result.linked).toEqual([]);
    const wanted = (await db.storage.engine().query<{ target_slug: string }>("SELECT target_slug FROM wanted_links WHERE from_slug = $1", [page.slug])).rows;
    expect(wanted).toEqual([{ target_slug: "people/bob-stone" }]);
  });

  it("refuses to enrich a page its source does not own", async () => {
    const page = renderMailThread({ service: "gmail", accountLabel: OWNER }, mail());
    await write(page, "inbox");
    await expect(enrichConnectorPage(db.storage, { page, sourceId: "cal", ownAddresses: [], peopleSourceIds: ["default"] })).rejects.toThrow();
  });
});
