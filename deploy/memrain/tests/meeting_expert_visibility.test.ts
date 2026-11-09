import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { extractMeetingTimelinePhase } from "../src/core/timeline-meetings.ts";
import { addLink } from "../src/core/links.ts";
import { findExperts } from "../src/core/insights.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`meeting/expert visibility ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  const previous = process.env.MEMRAIN_MEETING_TIMELINE;
  beforeAll(async () => {
    db = await engine.open();
    process.env.MEMRAIN_MEETING_TIMELINE = "1";
    for (const id of ["team", "other"]) await registerSource(db.storage.engine(), { id, kind: "other", pathPrefix: `/${id}` });
  });
  afterAll(async () => { await db.close(); if (previous === undefined) delete process.env.MEMRAIN_MEETING_TIMELINE; else process.env.MEMRAIN_MEETING_TIMELINE = previous; });
  it("stamps meeting ownership, removes only own/legacy projections, and excludes future meetings", async () => {
    for (const [slug, source] of [["people/alice", "team"], ["people/foreign", "other"]]) await putPage(db.storage, { slug: slug!, type: "person", source_id: source! });
    await putPage(db.storage, { slug: "meetings/owned", type: "meeting", source_id: "team", compiled_truth: { date: "2026-01-01", attendees: ["people/alice", "people/foreign"] } });
    await putPage(db.storage, { slug: "meetings/future", type: "meeting", source_id: "team", compiled_truth: { date: "2099-01-01" } });
    await addTimelineEvent(db.storage, { slug: "meetings/owned", event: "Legacy", occurred_at: "2026-01-01", source_chunk_id: "meeting-timeline:meetings/owned" });
    await addTimelineEvent(db.storage, { slug: "people/foreign", event: "Other source", occurred_at: "2026-01-01", source_id: "other", source_chunk_id: "meeting-timeline:meetings/owned" });
    const result = await extractMeetingTimelinePhase(db.storage);
    expect(result.entries_written).toBe(2);
    const rows = (await db.storage.engine().query<{ slug: string; source_id: string; event: string }>(`SELECT slug, source_id, event FROM timeline_events ORDER BY slug`)).rows;
    expect(rows).toHaveLength(3);
    expect(rows.filter(r => r.source_id === "team").map(r => r.slug)).toEqual(["meetings/owned", "people/alice"]);
    expect(rows.find(r => r.source_id === "other")!.event).toBe("Other source");
    expect(rows.some(r => r.source_id === "default")).toBe(false);
  });
  it("counts only visible expert neighbours and excludes self loops", async () => {
    for (const slug of ["people/hub", "notes/clean"]) await putPage(db.storage, { slug, type: slug.startsWith("people/") ? "person" : "note" });
    await dispatchTool(db.storage, { name: "page_put", arguments: { slug: "notes/held", type: "note", markdown_body: "Checking your browser before accessing example.com. Cloudflare Ray ID: 8badf00d" } }, {});
    for (const target of ["people/hub", "notes/clean", "notes/held"]) await addLink(db.storage, { source_slug: "people/hub", target_slug: target, type: "knows" });
    const rows = await findExperts(db.storage, { sourceIds: ["default"] });
    expect(rows.find(r => r.slug === "people/hub")!.degree).toBe(1);
    expect(rows.some(r => r.slug === "notes/held")).toBe(false);
  });
});
