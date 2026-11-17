/**
 * `memrain connectors redact-meetings`: connector pages stored before the
 * renderers stripped meeting credentials are cleaned through the versioned
 * write path. A dry run counts per source and writes nothing; `--apply --yes`
 * writes one new version per changed page (no principal, so retention still
 * ages the page out), keeps the outside-text marker, replaces the page's
 * search chunks and logs counts only; a second run finds nothing. Pages that
 * are not connector mail or calendar pages are never touched. Every id and
 * passcode is made up.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { mirrorPage } from "../src/core/page-index.ts";
import { registerSource } from "../src/core/sources.ts";
import { OUTSIDE_NEUTRALIZED } from "../src/core/fence-carry.ts";
import { parseFactsFence, renderFactsFence } from "../src/core/facts-fence.ts";
import { parseTakesFence, renderTakesFence } from "../src/core/synthesis/takes-fence.ts";
import { accountRef, type CalendarEvent, type MailThread } from "../src/core/connectors/model.ts";
import { renderCalendarEvent, renderMailThread, type RenderedConnectorPage } from "../src/core/connectors/render.ts";
import { MEETING_REDACT_REASON, MEETING_REDACT_WRITER, sweepMeetingCredentials } from "../src/core/connectors/meeting-redact-sweep.ts";
import { sweepRetention } from "../src/core/connectors/retention.ts";
import { runConnectors } from "../src/commands/connectors.ts";
import { deterministicEmbed } from "./det-embed.ts";

const OWNER = "owner@example.org";
const embedFn = async (t: string) => deterministicEmbed(t);
const NO_ACCOUNT = "0a0b0c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";

const ZOOM = [
  "Join Zoom Meeting",
  "https://us02web.zoom.us/j/81234567890?pwd=Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56.1",
  "Meeting ID: 812 3456 7890",
  "Passcode: 482913",
].join("\n");
const TEAMS = "Microsoft Teams\nJoin the meeting now\nBesprechungs-ID:\n\n311 222 333 444 55\n\nPasscode:\n\nQw7er9Ty\n";
const SECRETS = ["81234567890", "Ab12Cd34", "812 3456 7890", "482913", "311 222 333 444 55", "Qw7er9Ty"];

const thread: MailThread = {
  threadId: "thr-meet",
  messages: [{
    id: "m1", messageIdHeader: null, subject: "Weekly sync", from: { name: "Bob Stone", email: "bob@example.net" },
    to: [{ name: null, email: OWNER }], cc: [], date: "2025-01-01T08:00:00.000Z", bodyText: "See you there.", bodyHtml: null,
    attachments: [], listUnsubscribe: false, categories: [],
  }],
};
const event: CalendarEvent = {
  id: "evt-meet", iCalUID: "uid-meet@example.net", title: "Design review", description: "Agenda", location: null,
  start: "2026-11-12T10:00:00.000Z", end: "2026-11-12T11:00:00.000Z", allDay: false, status: "confirmed",
  organizer: { name: "Bob Stone", email: "bob@example.net" }, attendees: [], recurrence: null,
};

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector meeting-credential sweep (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const mail = renderMailThread({ service: "gmail", accountLabel: OWNER }, thread);
  const cal = renderCalendarEvent({ service: "outlook_calendar", accountLabel: OWNER }, event);

  /** Store a page the way a sync did before the renderers stripped credentials. */
  const legacy = async (page: RenderedConnectorPage, source: string, extra: string, over: Partial<RenderedConnectorPage> = {}) => {
    const p = { ...page, ...over };
    const body = `${p.body}\n${extra}\n`;
    const put = await putPage(db.storage, { slug: p.slug, type: p.type, allowAdHocType: true, title: p.title, markdown_body: body,
      compiled_truth: p.truth, written_by: "connector-google", source_id: source, outsideText: true });
    expect(await mirrorPage(db.storage, { slug: p.slug, title: p.title, markdown_body: put.outside_body!, content_hash: put.content_hash, source_id: source },
      { remote: true, embedFn })).toBe(true);
    return p;
  };
  const scalar = async (sql: string, params: unknown[] = []) => (await db.storage.engine().query<{ v: unknown }>(sql, params)).rows[0]?.v;
  const chunksHolding = async (secret: string) => Number(await scalar("SELECT count(*)::int AS v FROM chunks WHERE content LIKE $1", [`%${secret}%`]));
  const versions = async (slug: string) => (await db.storage.engine().query<{ version_n: number; written_by: string; written_by_principal: string | null; change_reason: string | null }>(
    "SELECT version_n, written_by, written_by_principal, change_reason FROM page_versions WHERE slug = $1 ORDER BY version_n", [slug])).rows;

  beforeEach(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "inbox", kind: "mailbox", pathPrefix: "mail/" });
    await registerSource(db.storage.engine(), { id: "cal", kind: "calendar", pathPrefix: "calendar/" });
  });
  afterEach(async () => { await db.close(); });

  it("counts per source on a dry run, then writes one clean version per page and finds nothing the second time", async () => {
    await legacy(mail, "inbox", ZOOM);
    await legacy(mail, "inbox", "Passcode: 482913", { slug: `${mail.slug}/part-001`, truth: { ...mail.truth, part_of: mail.slug, part: 1 } });
    await legacy(cal, "cal", TEAMS, { title: "Review https://teams.microsoft.com/meet/311222333444555?p=Qw7er9Ty" });
    const clean = await legacy(renderMailThread({ service: "gmail", accountLabel: OWNER }, { ...thread, threadId: "thr-clean" }), "inbox", "Nothing to hide.");
    // A person's own note is not connector text: the sweep never reads it.
    await putPage(db.storage, { slug: "notes/zoom", markdown_body: "Meeting ID: 812 3456 7890\n" });

    const dry = await sweepMeetingCredentials(db.storage, { mirror: { embedFn } });
    expect(dry).toMatchObject({ applied: false, pages_scanned: 4, pages_changed: 3, rewritten: 0, errors: [] });
    expect(dry.by_source.inbox).toMatchObject({ pages_scanned: 3, pages_changed: 2 });
    expect(dry.by_source.cal).toMatchObject({ pages_scanned: 1, pages_changed: 1 });
    expect(dry.removals).toBe(dry.by_source.inbox!.removals + dry.by_source.cal!.removals);
    expect(dry.removals).toBe(7);
    expect((await versions(mail.slug)).length).toBe(1);
    expect(await chunksHolding("482913")).toBeGreaterThan(0);
    expect(JSON.stringify(dry)).not.toContain("482913");

    const only = await sweepMeetingCredentials(db.storage, { sourceId: "cal" });
    expect(only).toMatchObject({ pages_scanned: 1, pages_changed: 1 });
    expect(Object.keys(only.by_source)).toEqual(["cal"]);

    const applied = await sweepMeetingCredentials(db.storage, { apply: true, mirror: { embedFn } });
    expect(applied).toMatchObject({ applied: true, pages_changed: 3, rewritten: 3, mirror_failed: 0, moved: 0, errors: [], removals: dry.removals });
    for (const slug of [mail.slug, `${mail.slug}/part-001`, cal.slug]) {
      const page = (await db.storage.engine().query<{ title: string; markdown_body: string; compiled_truth: unknown }>(
        "SELECT title, markdown_body, compiled_truth FROM pages WHERE slug = $1", [slug])).rows[0]!;
      for (const s of SECRETS) {
        expect([slug, s, page.markdown_body.includes(s) || page.title.includes(s)]).toEqual([slug, s, false]);
      }
      const truth = typeof page.compiled_truth === "string" ? JSON.parse(page.compiled_truth) : page.compiled_truth;
      expect(truth).toMatchObject({ origin: "connector", [OUTSIDE_NEUTRALIZED]: 1 });
      expect((await versions(slug)).at(-1)).toEqual({ version_n: 2, written_by: MEETING_REDACT_WRITER, written_by_principal: null, change_reason: MEETING_REDACT_REASON });
    }
    expect(await scalar("SELECT markdown_body AS v FROM pages WHERE slug = $1", [cal.slug])).toContain("Join the meeting now");
    expect(await scalar("SELECT title AS v FROM pages WHERE slug = $1", [cal.slug])).toBe("Review [meeting link removed]");
    for (const s of SECRETS) expect([s, await chunksHolding(s)]).toEqual([s, 0]);
    expect(await scalar("SELECT markdown_body AS v FROM pages WHERE slug = 'notes/zoom'")).toBe("Meeting ID: 812 3456 7890\n");
    expect((await versions(clean.slug)).length).toBe(1);

    const logs = (await db.storage.engine().query<{ source_id: string; summary: string; pages_updated: unknown }>(
      "SELECT source_id, summary, pages_updated FROM ingest_log WHERE source_type = 'connector-meeting-redact' ORDER BY source_id")).rows;
    expect(logs.map(l => l.source_id)).toEqual(["cal", "inbox"]);
    expect(logs[1]!.summary).toBe(`2 page(s), ${applied.by_source.inbox!.removals} meeting credential(s) removed`);
    for (const s of SECRETS) expect(JSON.stringify(logs)).not.toContain(s);

    const again = await sweepMeetingCredentials(db.storage, { apply: true, mirror: { embedFn } });
    expect(again).toMatchObject({ pages_scanned: 4, pages_changed: 0, removals: 0, rewritten: 0 });
    expect((await versions(mail.slug)).length).toBe(2);
  });

  it("changes only the credentials: the brain's fences and the rendered page stay byte for byte", async () => {
    const series = renderCalendarEvent({ service: "outlook_calendar", accountLabel: OWNER }, {
      ...event, recurrence: ["RRULE:FREQ=WEEKLY"],
      occurrences: [{ start: "2026-11-12T10:00:00.000Z", end: "2026-11-12T11:00:00.000Z", status: "confirmed" },
        { start: "2026-11-19T10:00:00.000Z", end: "2026-11-19T11:00:00.000Z", status: "confirmed" }],
    });
    await legacy(series, "cal", "Meeting ID: 812 3456 7890\nPasscode: 482913");
    // The brain appends its fences after the rendered page, as the fence writers do.
    const facts = renderFactsFence([{ rowNum: 1, claim: "The review repeats weekly.", confidence: 1, active: true }]);
    const takes = renderTakesFence([{ rowNum: 1, claim: "The review runs long.", kind: "take", holder: "brain", weight: 0.6, active: true }]);
    const cur = (await getPage(db.storage, series.slug))!;
    await putPage(db.storage, { slug: series.slug, type: cur.type, allowAdHocType: true, title: cur.title!, compiled_truth: cur.compiled_truth,
      markdown_body: `${cur.markdown_body}\n## Facts\n\n${facts}\n\n## Takes\n\n${takes}\n`, written_by: "agent", source_id: "cal" });
    const before = (await getPage(db.storage, series.slug))!;
    expect(parseFactsFence(before.markdown_body).map(f => f.claim)).toEqual(["The review repeats weekly."]);

    const r = await sweepMeetingCredentials(db.storage, { apply: true, mirror: { embedFn } });
    expect(r).toMatchObject({ rewritten: 1, removals: 2, errors: [] });
    const after = (await getPage(db.storage, series.slug))!;
    expect(after.markdown_body).toBe(before.markdown_body.replace("812 3456 7890", "[removed]").replace("482913", "[removed]"));
    expect(parseFactsFence(after.markdown_body).map(f => f.claim)).toEqual(["The review repeats weekly."]);
    expect(parseTakesFence(after.markdown_body).takes.map(t => t.claim)).toEqual(["The review runs long."]);
  });

  it("holds a connector page not marked as neutralized outside text, on a dry run and on apply", async () => {
    const p = await legacy(mail, "inbox", ZOOM);
    await db.storage.engine().query(`UPDATE pages SET compiled_truth = compiled_truth - '${OUTSIDE_NEUTRALIZED}' WHERE slug = $1`, [p.slug]);
    const held = `${p.slug}: held (not_neutralized)`;
    expect(await sweepMeetingCredentials(db.storage, { mirror: { embedFn } })).toMatchObject({ pages_changed: 0, errors: [held] });
    expect(await sweepMeetingCredentials(db.storage, { apply: true, mirror: { embedFn } })).toMatchObject({ rewritten: 0, errors: [held] });
    expect((await versions(p.slug)).length).toBe(1);
  });

  it("leaves the page to connector retention: the rewrite is not a person's edit", async () => {
    await legacy(mail, "inbox", ZOOM);
    expect((await sweepMeetingCredentials(db.storage, { apply: true, mirror: { embedFn } })).rewritten).toBe(1);
    const scope = { sourceId: "inbox", accountRef: accountRef(OWNER, "google") };
    const r = await sweepRetention(db.storage, scope, { accountId: NO_ACCOUNT, kinds: ["mail"], env: {}, now: () => Date.parse("2026-11-14T00:00:00.000Z") });
    expect(r.detached).toEqual([]);
    expect(r.deleted).toEqual([mail.slug]);
  });

  it("refuses --apply without --yes, and reports counts only", async () => {
    await legacy(mail, "inbox", ZOOM);
    expect(await runConnectors({ sub: "redact-meetings", apply: true, storage: db.storage })).toBe(2);
    expect((await versions(mail.slug)).length).toBe(1);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runConnectors({ sub: "redact-meetings", json: true, storage: db.storage })).toBe(0);
      const out = JSON.parse(String(log.mock.calls.at(-1)![0])) as Record<string, unknown>;
      expect(out).toMatchObject({ ok: true, applied: false, pages_changed: 1 });
      for (const s of SECRETS) expect(JSON.stringify(out)).not.toContain(s);
    } finally {
      log.mockRestore();
    }
    expect((await versions(mail.slug)).length).toBe(1);
  });
});
