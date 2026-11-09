import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { deletePage, getPage, putPage, restorePage } from "../src/core/pages.ts";
import { runChronicleExtract } from "../src/core/chronicle/extract-events.ts";
import { getEntityTimeline } from "../src/core/timeline.ts";
import { getTimelineForDate } from "../src/core/chronicle.ts";
import { findTrajectory } from "../src/core/insights.ts";
import { mirrorPagesPhase } from "../src/core/cycle/mirror-pages.ts";
import { collectChronicle } from "../src/core/advisor/collectors.ts";
import { registerSource } from "../src/core/sources.ts";
import { runInPhaseContext } from "../src/core/cycle/phase-context.ts";

const event = (what: string) => ({ when: "2026-01-01", who: [], what, kind: "meeting" });
for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`chronicle retirement ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => {
    db = await engine.open();
    await registerSource(db.storage.engine(), { id: "other", kind: "other", pathPrefix: "/other" });
  });
  afterAll(async () => { await db.close(); });
  async function seed(slug: string) {
    await putPage(db.storage, { slug, type: "meeting", markdown_body: "Meeting source" });
    await runChronicleExtract(db.storage, { slug, judge: async () => ({ events: ["A", "B", "C", "D"].map(event) }) });
    return (await db.storage.engine().query<{ slug: string; title: string }>(`SELECT slug, title FROM pages WHERE compiled_truth #>> '{event,depth}' = $1 ORDER BY title`, [slug])).rows;
  }
  it("retires missing untouched events, preserves manual edits and restores timeline visibility", async () => {
    const slug = "meetings/retire";
    const rows = await seed(slug);
    const edited = (await getPage(db.storage, rows[3]!.slug))!;
    await putPage(db.storage, { slug: edited.slug, type: edited.type, title: edited.title ?? undefined,
      compiled_truth: edited.compiled_truth, markdown_body: "Operator correction", written_by: "operator" });
    const r = await runChronicleExtract(db.storage, { slug, judge: async () => ({ events: ["A", "B"].map(event) }) });
    expect((r as any).events_retired).toBe(1);
    expect(await getPage(db.storage, rows[2]!.slug)).toBeNull();
    expect((await getPage(db.storage, edited.slug))!.markdown_body).toBe("Operator correction");
    expect((await getEntityTimeline(db.storage, slug)).map(r => r.event).sort()).toEqual(["A", "B", "D"]);
    expect((await findTrajectory(db.storage, slug)).map(r => r.text).sort()).toEqual(["A", "B", "D"]);
    expect((await db.storage.engine().query(`SELECT id FROM timeline_events WHERE slug = $1`, [slug])).rows).toHaveLength(4);
    await restorePage(db.storage, rows[2]!.slug, "operator", "default");
    expect(await getEntityTimeline(db.storage, slug)).toHaveLength(4);
    expect((await getTimelineForDate(db.storage, "2026-01-01", { sourceIds: ["default"] })).filter(r => r.slug === slug)).toHaveLength(4);
  });
  it("holds severe shrink and never retires after incomplete or empty extraction", async () => {
    const slug = "meetings/hold";
    await seed(slug);
    const held = await runChronicleExtract(db.storage, { slug, judge: async () => ({ events: [event("A")] }) });
    expect(held.status as string).toBe("held_shrink");
    for (const result of [ { events: [] }, { events: [event("A"), event("B")], truncated: true },
      { events: [event("A"), event("B")], inputTruncated: true } ]) {
      await runChronicleExtract(db.storage, { slug, judge: async () => result });
      expect(await getEntityTimeline(db.storage, slug)).toHaveLength(4);
    }
  });
  it("does not apply a stale extraction after the source changes", async () => {
    const slug = "meetings/stale";
    await seed(slug);
    const result = await runChronicleExtract(db.storage, { slug, judge: async () => {
      await putPage(db.storage, { slug, type: "meeting", markdown_body: "Changed while extracting" });
      return { events: [event("New A"), event("New B")] };
    } });
    expect(result.reason).toBe("source_changed");
    expect((await getEntityTimeline(db.storage, slug)).map(r => r.event).sort()).toEqual(["A", "B", "C", "D"]);
  });
  it("soft-retires events of a deleted source during mirror maintenance and retains projection rows", async () => {
    const slug = "meetings/deleted";
    const events = await seed(slug);
    await deletePage(db.storage, slug);
    await mirrorPagesPhase(db.storage, { maxPerRun: 0 });
    for (const ev of events) expect(await getPage(db.storage, ev.slug)).toBeNull();
    expect((await db.storage.engine().query(`SELECT id FROM timeline_events WHERE slug = $1`, [slug])).rows).toHaveLength(4);
    await restorePage(db.storage, slug, "operator", "default");
    const findings = await collectChronicle.collect({ engine: db.storage.engine(), version: "test", now: new Date(), sourceIds: ["default"] });
    expect(findings.some(f => f.id === "chronicle_coverage_gap")).toBe(true);
  });
  it("preserves changed hashes and foreign-owned events referring to the same origin", async () => {
    const slug = "meetings/hash";
    const rows = await seed(slug);
    await db.storage.engine().query(`UPDATE pages SET content_hash = 'changed-outside-writer' WHERE slug = $1`, [rows[2]!.slug]);
    await putPage(db.storage, { slug: "life/events/foreign", type: "event", source_id: "other", written_by: "life-chronicle",
      compiled_truth: { captured_via: "life-chronicle:auto", event: { depth: slug } } });
    await runChronicleExtract(db.storage, { slug, judge: async () => ({ events: ["A", "B"].map(event) }) });
    expect(await getPage(db.storage, rows[2]!.slug)).not.toBeNull();
    expect(await getPage(db.storage, rows[3]!.slug)).toBeNull();
    expect(await getPage(db.storage, "life/events/foreign")).not.toBeNull();
    await deletePage(db.storage, slug);
    await mirrorPagesPhase(db.storage, { maxPerRun: 0 });
    expect(await getPage(db.storage, rows[2]!.slug)).not.toBeNull();
    expect(await getPage(db.storage, "life/events/foreign")).not.toBeNull();
  });
  it("checks the origin version under the delete lock and keeps events after a concurrent origin edit", async () => {
    const slug = "meetings/delete-guard";
    const events = await seed(slug);
    const origin = (await getPage(db.storage, slug, ["default"], { withVersion: true }))!;
    const ev = (await getPage(db.storage, events[0]!.slug, ["default"], { withVersion: true }))!;
    await putPage(db.storage, { slug, type: "meeting", markdown_body: "Changed" });
    await expect(deletePage(db.storage, ev.slug, "life-chronicle:retired", "default", {
      expectedVersion: ev.version, expectedOriginVersion: { slug, version: origin.version! },
    })).rejects.toThrow(/not the expected/);
    expect(await getPage(db.storage, ev.slug)).not.toBeNull();
  });
  it("does not retire based on a clipped default-judge input or duplicate proposals", async () => {
    const slug = "meetings/long";
    await seed(slug);
    await putPage(db.storage, { slug, type: "meeting", markdown_body: "Meeting text ".repeat(1500) });
    const r = await runChronicleExtract(db.storage, { slug, sonnetFn: async () => ({
      text: JSON.stringify(["A", "B"].map(event)), modelId: "eu.anthropic.claude-sonnet-4-6",
      usage: { inputTokens: 100, outputTokens: 50 },
    }) });
    expect(r.reason).toBe("incomplete_extraction");
    expect(await getEntityTimeline(db.storage, slug)).toHaveLength(4);
    const held = await runChronicleExtract(db.storage, { slug, judge: async () => ({ events: [event("A"), event("A")] }) });
    expect(held.status).toBe("held_shrink");
  });
  it("bounds deleted-source retirement and obeys the maintenance lock fence", async () => {
    const slug = "meetings/capped";
    await putPage(db.storage, { slug, type: "meeting" });
    for (let i = 0; i < 101; i++) await putPage(db.storage, { slug: `life/events/capped-${i}`, type: "event",
      written_by: "life-chronicle", compiled_truth: { captured_via: "life-chronicle:auto", event: { depth: slug } } });
    await deletePage(db.storage, slug);
    await expect(runInPhaseContext({ signal: new AbortController().signal, fence: async () => false },
      () => mirrorPagesPhase(db.storage, { maxPerRun: 0 }))).rejects.toThrow(/lock_stolen/);
    const count = async () => Number((await db.storage.engine().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'life/events/capped-%' AND deleted_at IS NULL`,
    )).rows[0]!.n);
    expect(await count()).toBe(101);
    expect((await mirrorPagesPhase(db.storage, { maxPerRun: 0 })).retired_events).toBe(100);
    expect(await count()).toBe(1);
    expect((await mirrorPagesPhase(db.storage, { maxPerRun: 0 })).retired_events).toBe(1);
  });
});
