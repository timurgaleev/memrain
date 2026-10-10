/** think's date frame: reference-date validation, timezone fallback, page content dates. */
import { describe, expect, it } from "bun:test";
import {
  ReferenceDateError,
  dayInZone,
  pageContentDate,
  parseReferenceDate,
  resolveThinkTemporalContext,
  thinkTimeZone,
} from "../src/core/synthesis/think-temporal.ts";

const NOW = new Date("2026-10-10T22:30:00Z");

describe("parseReferenceDate", () => {
  it("accepts a past day and tomorrow, refuses later", () => {
    expect(parseReferenceDate("2024-02-29", "UTC", NOW)).toBe("2024-02-29");
    expect(parseReferenceDate(" 2026-10-11 ", "UTC", NOW)).toBe("2026-10-11");
    expect(() => parseReferenceDate("2026-10-12", "UTC", NOW)).toThrow(ReferenceDateError);
  });

  it("measures 'tomorrow' in the brain's zone", () => {
    // 22:30 UTC is already Oct 11 in Berlin, so Oct 12 is tomorrow there.
    expect(parseReferenceDate("2026-10-12", "Europe/Berlin", NOW)).toBe("2026-10-12");
  });

  it("refuses malformed and impossible dates", () => {
    expect(() => parseReferenceDate("2026/10/01", "UTC", NOW)).toThrow(ReferenceDateError);
    expect(() => parseReferenceDate("2025-02-29", "UTC", NOW)).toThrow(/real calendar date/);
    expect(() => parseReferenceDate("last week", "UTC", NOW)).toThrow(ReferenceDateError);
  });
});

describe("resolveThinkTemporalContext", () => {
  it("defaults to today in the zone", () => {
    expect(resolveThinkTemporalContext({ now: NOW, timeZone: "Europe/Berlin" })).toEqual({
      referenceDate: "2026-10-11",
      timeZone: "Europe/Berlin",
      explicit: false,
    });
  });

  it("uses a caller's reference date", () => {
    expect(resolveThinkTemporalContext({ now: NOW, timeZone: "UTC", referenceDate: "2025-01-15" })).toEqual({
      referenceDate: "2025-01-15",
      timeZone: "UTC",
      explicit: true,
    });
  });
});

describe("thinkTimeZone", () => {
  it("falls back to UTC for unset or invalid zones", () => {
    expect(thinkTimeZone(undefined)).toBe("UTC");
    expect(thinkTimeZone("Mars/Olympus")).toBe("UTC");
    expect(thinkTimeZone(" Asia/Tokyo ")).toBe("Asia/Tokyo");
  });
});

describe("pageContentDate", () => {
  it("dates content sources and not row-timestamp fallbacks", () => {
    expect(pageContentDate("2026-03-05T00:00:00.000Z", "date", "Asia/Tokyo")).toBe("2026-03-05");
    expect(pageContentDate("2026-03-05", "filename", "UTC")).toBe("2026-03-05");
    expect(pageContentDate("2026-03-05T00:00:00.000Z", "fallback", "UTC")).toBeNull();
    expect(pageContentDate("2026-03-05T00:00:00.000Z", null, "UTC")).toBeNull();
    expect(pageContentDate(null, "date", "UTC")).toBeNull();
  });

  it("renders a timed instant in the zone", () => {
    expect(pageContentDate("2026-03-05T20:00:00.000Z", "published", "Asia/Tokyo")).toBe("2026-03-06");
    expect(dayInZone(new Date("2026-03-05T20:00:00Z"), "UTC")).toBe("2026-03-05");
  });
});
