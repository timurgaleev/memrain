import { describe, expect, it } from "bun:test";
import { isCalendarDate, resolveEffectiveDate } from "../src/core/effective-date.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { putPage } from "../src/core/pages.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { factInputMetadata } from "../src/core/facts-batch.ts";

describe("effective dates before year 100", () => {
  it("preserves the ISO year instead of treating it as a year in the 1900s", () => {
    for (const date of ["0001-06-15", "0099-12-31", "0100-01-01", "2026-11-09"]) {
      expect(isCalendarDate(date)).toBe(true);
      expect(resolveEffectiveDate({ date })).toBe(`${date}T00:00:00.000Z`);
      expect(resolveEffectiveDate({}, `/archive/${date}-entry.md`)).toBe(`${date}T00:00:00.000Z`);
    }
  });

  it("uses Gregorian leap-day rules and still rejects rolled-over days", () => {
    for (const date of ["0004-02-29", "2000-02-29", "2024-02-29"]) {
      expect(isCalendarDate(date)).toBe(true);
    }
    for (const date of ["0000-01-01", "0000-02-29", "0001-02-29", "0099-02-29", "0100-02-29", "1900-02-29", "2026-02-30", "0001-00-01", "0099-13-01"]) {
      expect(isCalendarDate(date)).toBe(false);
      expect(resolveEffectiveDate({ date })).toBeNull();
    }
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`early date storage (${name})`, () => {
  it("stores early CE years and retains year-zero content with an unknown effective date", async () => {
    const db = await open();
    try {
      for (const date of ["0000-01-01", "0001-06-15", "0099-12-31"]) {
        const indexed = await indexDocument(db.storage, {
          sourcePath: `/dates/${date}.md`, text: `---\ndate: "${date}"\n---\n# Archive\nPreserved text.`,
        }, { embedFn: async text => deterministicEmbed(text) });
        expect((await db.storage.engine().query("SELECT effective_date::date::text AS date FROM documents WHERE id=$1", [indexed.documentId])).rows)
          .toEqual([{ date: date.startsWith("0000") ? null : date }]);
        expect((await db.storage.engine().query<{ content: string }>("SELECT content FROM chunks WHERE document_id=$1", [indexed.documentId])).rows.some(row => row.content.includes("Preserved text."))).toBe(true);
      }
    } finally { await db.close(); }
  });
  it("refuses year zero before timeline or fact SQL, while early CE events persist", async () => {
    const db = await open();
    try {
      await putPage(db.storage, { slug: "notes/early", markdown_body: "Preserved page." });
      await expect(addTimelineEvent(db.storage, { slug: "notes/early", occurred_at: "0000-01-01", event: "Invalid year" }))
        .rejects.toMatchObject({ code: "invalid_params" });
      expect(() => factInputMetadata({ valid_from: "0000-01-01" })).toThrow("real calendar date");
      expect((await db.storage.engine().query("SELECT event FROM timeline_events")).rows).toEqual([]);
      for (const date of ["0001-06-15", "0099-12-31"]) {
        const result = await addTimelineEvent(db.storage, { slug: "notes/early", occurred_at: date, event: `Milestone ${date}` });
        expect(result.inserted).toBe(true);
        expect(result.occurred_at.startsWith(date)).toBe(true);
        expect(factInputMetadata({ valid_from: date })).toEqual({ valid_from: date });
      }
    } finally { await db.close(); }
  });
});
