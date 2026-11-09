import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { registerSource } from "../src/core/sources.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { readContextDelta } from "../src/core/context-delta.ts";
import { listQuarantined } from "../src/core/quarantine-list.ts";
import { extractionReview } from "../src/core/extraction-review.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`bounded context helpers ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  const since = "2025-01-01T12:00:00.000Z";
  beforeAll(async () => {
    db = await engine.open();
    await registerSource(db.storage.engine(), { id: "other", kind: "other", pathPrefix: "/other" });
    for (const [slug, source, type] of [["notes/a", "default", "note"], ["notes/b", "default", "note"],
      ["notes/held", "default", "note"], ["notes/journal", "default", " Journal "], ["notes/foreign", "other", "note"]]) {
      await putPage(db.storage, { slug: slug!, source_id: source!, type: type!, markdown_body: "Fixture body withheld from metadata." });
    }
    const e = db.storage.engine();
    await e.exec("UPDATE pages SET updated_at = '2025-01-02T00:00:00Z'");
    await e.query(`INSERT INTO documents(id, source_path, source_id, frontmatter)
      VALUES ('review-held', 'page://notes/held', 'default', $1::text::jsonb)`,
      [JSON.stringify({ quarantine: { reason: "junk_pattern", detail: "SECRET_DETAIL" }, title: "SECRET_TITLE" })]);
    for (const [entity, fact, source, origin, visibility] of [
      ["people/missing", "The launch review starts next week", "default", "notes/a", "world"],
      ["people/missing", "The launch review starts next week soon", "default", "notes/a", "world"],
      ["people/held", "hidden-held", "default", "notes/held", "world"],
      ["people/diary", "hidden-diary", "default", "notes/journal", "world"],
      ["people/private", "hidden-private", "default", "notes/a", "private"],
      ["people/foreign", "hidden-foreign", "other", "notes/foreign", "world"],
    ] as const) await addFact(db.storage, { entity_slug: entity, fact, source_id: source, source_slug: origin, visibility,
      written_by_principal: "client:fixture", valid_from: "2025-01-01" });
    await e.exec("UPDATE entity_facts SET written_at = '2025-01-02T00:00:00Z'");
    for (const slug of ["notes/a", "notes/b", "notes/held", "notes/journal"]) {
      await addTimelineEvent(db.storage, { slug, occurred_at: "2025-01-01T01:00:00Z", event: `event ${slug}`, written_by_principal: "client:fixture" });
    }
  });
  afterAll(async () => { await db.close(); });
  it("filters before independent limits and frames facts/events without touching storage", async () => {
    const e = db.storage.engine();
    const snapshot = async () => Promise.all(["pages", "page_versions", "entity_facts", "timeline_events", "documents", "chunks", "jobs"].map(async table =>
      (await e.query(`SELECT md5(string_agg(payload, '' ORDER BY payload COLLATE "C")) AS hash FROM (SELECT row_to_json(t)::text AS payload FROM ${table} t) rows`)).rows));
    const before = await snapshot();
    const result = await readContextDelta(db.storage, { since, limit: 1, sourceIds: ["default"], remote: true });
    expect(result.pages.items).toHaveLength(1);
    expect(result.facts.items).toHaveLength(1);
    expect(result.events.items).toHaveLength(1);
    expect([result.pages.truncated, result.facts.truncated, result.events.truncated]).toEqual([true, true, true]);
    expect(JSON.stringify(result)).toContain('external_content');
    expect(JSON.stringify(result)).not.toContain('hidden-');
    expect(JSON.stringify(result)).not.toContain('Fixture body');
    expect(result.complete_change_log).toBe(false);
    expect(result.events.time_basis).toBe("event_date");
    expect(await snapshot()).toEqual(before);
    const none = await readContextDelta(db.storage, { since, sourceIds: [], remote: true });
    expect([none.pages.items, none.facts.items, none.events.items]).toEqual([[], [], []]);
  });
  it("quarantine output withholds free text and applies scope before limit", async () => {
    const result = await listQuarantined(db.storage.engine(), { sourceIds: ["default"], limit: 1 });
    expect(result.items).toEqual([{ id: "review-held", source_id: "default", source_path: "page://notes/held", reason: "junk_pattern" }]);
    expect(result.truncated).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect((await listQuarantined(db.storage.engine(), { sourceIds: [] })).items).toEqual([]);
  });
  it("returns bounded metadata review candidates without raw facts or writes", async () => {
    const result = await extractionReview(db.storage.engine(), { sourceIds: ["default"] });
    expect(result.scanned).toBe(2);
    expect(result.candidates.some((row: any) => row.kind === "missing_entity_page" && row.entity_slug === "people/missing")).toBe(true);
    expect(result.candidates.some((row: any) => row.kind === "similar_facts")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("launch review");
    expect(JSON.stringify(result)).not.toContain("hidden-");
    expect((await extractionReview(db.storage.engine(), { sourceIds: [] })).scanned).toBe(0);
  });
  it("rejects invalid dates, rolled-over hours and limits before a read", async () => {
    for (const value of ["2025-02-30", "2025-01-01T24:00:00Z", "yesterday", "2025-01-01T12:00:00+01:00"]) {
      await expect(readContextDelta(db.storage, { since: value })).rejects.toThrow("since");
    }
    for (const limit of [0, 101, 1.5, NaN]) {
      await expect(readContextDelta(db.storage, { since, limit })).rejects.toThrow("limit");
      await expect(listQuarantined(db.storage.engine(), { limit })).rejects.toThrow("limit");
      await expect(extractionReview(db.storage.engine(), { limit })).rejects.toThrow("limit");
    }
  });
  it("reports pool and result truncation independently with stable metadata order", async () => {
    const e = db.storage.engine();
    await e.exec(`INSERT INTO entity_facts(entity_slug, fact, source_id, visibility, written_at)
      SELECT 'pool/' || n, 'Pool fixture ' || n, 'default', 'world', '2025-02-01T00:00:00Z' FROM generate_series(1, 201) n`);
    try {
      const result = await extractionReview(e, { limit: 1, sourceIds: ["default"] });
      expect(result).toMatchObject({ scanned: 200, scan_truncated: true, truncated: true });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({ entity_slug: "pool/201", kind: "missing_entity_page" });
      expect(await extractionReview(e, { limit: 1, sourceIds: ["default"] })).toEqual(result);
      expect((await extractionReview(e, { limit: 1, sourceIds: ["other"] })).scanned).toBe(1);
    } finally { await e.exec("DELETE FROM entity_facts WHERE entity_slug LIKE 'pool/%'"); }
  });
  it("only returns reason codes and detects quarantine overflow after source filtering", async () => {
    const e = db.storage.engine();
    await e.query(`INSERT INTO documents(id, source_path, source_id, frontmatter) VALUES
      ('review-extra', 'page://extra', 'default', $1::text::jsonb), ('review-foreign', 'page://foreign', 'other', $1::text::jsonb)`,
      [JSON.stringify({ quarantine: { reason: "SECRET_REASON", detail: "SECRET_DETAIL" } })]);
    try {
      const result = await listQuarantined(e, { sourceIds: ["default"], limit: 1 });
      expect(result.truncated).toBe(true);
      expect(result.items).toEqual([{ id: "review-extra", source_path: "page://extra", source_id: "default", reason: "unknown" }]);
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect((await listQuarantined(e, { sourceIds: ["other"], limit: 1 })).truncated).toBe(false);
    } finally { await e.exec("DELETE FROM documents WHERE id IN ('review-extra', 'review-foreign')"); }
  });
  it("frames an event projected from an externally written event page", async () => {
    await putPage(db.storage, { slug: "life/events/external", markdown_body: "Event fixture", source_id: "default",
      written_by: "fixture", written_by_principal: "client:event-writer" });
    const e = db.storage.engine();
    await e.exec(`INSERT INTO timeline_events(slug, occurred_at, event, source_id, event_slug)
      VALUES ('notes/a', '2025-03-01T00:00:00Z', '<external event>', 'default', 'life/events/external')`);
    try {
      const result = await readContextDelta(db.storage, { since, sourceIds: ["default"], limit: 1, remote: true });
      expect(result.events.items[0]).toMatchObject({ trust: "external", summary: '<external_content trust="external">\n&lt;external event&gt;\n</external_content>' });
    } finally {
      await e.exec("DELETE FROM timeline_events WHERE event_slug = 'life/events/external'");
    }
  });
});
