import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { applyTimeScope, dayInRange, parseQueryTimeRange } from "../src/core/search/time-range.ts";
import { failingEmbed, runSearch } from "./rank-flags-fixture.ts";
import { deterministicEmbed } from "./det-embed.ts";

describe("parseQueryTimeRange", () => {
  const ref = "2026-11-21"; // a Saturday

  it("resolves last month in English, Russian and German to the previous calendar month", () => {
    for (const q of ["what did we decide last month", "\u0447\u0442\u043E \u043C\u044B \u0440\u0435\u0448\u0438\u043B\u0438 \u0432 \u043F\u0440\u043E\u0448\u043B\u043E\u043C \u043C\u0435\u0441\u044F\u0446\u0435", "was haben wir letzten Monat beschlossen"]) {
      expect(parseQueryTimeRange(q, ref)).toMatchObject({ start: "2026-10-01", end: "2026-10-31" });
    }
  });

  it("resolves yesterday and today to single days", () => {
    for (const q of ["notes from yesterday", "\u0432\u0447\u0435\u0440\u0430", "Gestern"]) {
      expect(parseQueryTimeRange(q, ref)).toMatchObject({ start: "2026-11-20", end: "2026-11-20" });
    }
    expect(parseQueryTimeRange("\u0441\u0435\u0433\u043E\u0434\u043D\u044F \u0432\u0441\u0442\u0440\u0435\u0447\u0430", ref)).toMatchObject({ start: ref, end: ref });
  });

  it("runs weeks Monday to Sunday and ends this week at the reference day", () => {
    for (const q of ["this week", "\u043D\u0430 \u044D\u0442\u043E\u0439 \u043D\u0435\u0434\u0435\u043B\u0435", "diese Woche"]) {
      expect(parseQueryTimeRange(q, ref)).toMatchObject({ start: "2026-11-16", end: ref });
    }
    for (const q of ["last week", "\u043D\u0430 \u043F\u0440\u043E\u0448\u043B\u043E\u0439 \u043D\u0435\u0434\u0435\u043B\u0435", "letzte Woche"]) {
      expect(parseQueryTimeRange(q, ref)).toMatchObject({ start: "2026-11-09", end: "2026-11-15" });
    }
    // A Sunday still belongs to the week that started on Monday.
    expect(parseQueryTimeRange("this week", "2026-11-22")).toMatchObject({ start: "2026-11-16", end: "2026-11-22" });
  });

  it("crosses the year boundary", () => {
    expect(parseQueryTimeRange("last month", "2026-01-10")).toMatchObject({ start: "2025-12-01", end: "2025-12-31" });
    expect(parseQueryTimeRange("\u0432 \u043F\u0440\u043E\u0448\u043B\u043E\u043C \u0433\u043E\u0434\u0443", "2026-01-10")).toMatchObject({ start: "2025-01-01", end: "2025-12-31" });
    expect(parseQueryTimeRange("this year", "2026-01-10")).toMatchObject({ start: "2026-01-01", end: "2026-01-10" });
  });

  it("abstains on two different spans, no cue, or a cue inside another word", () => {
    expect(parseQueryTimeRange("yesterday versus last week", ref)).toBeNull();
    expect(parseQueryTimeRange("quarterly budget review", ref)).toBeNull();
    expect(parseQueryTimeRange("Todayscape launch", ref)).toBeNull();
  });
});

describe("applyTimeScope", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];

  it("keeps the top half and gives the rest of the first k to in-range hits, dropping none", () => {
    const out = applyTimeScope(ids, 4, (x) => x === "e" || x === "f");
    expect(out).toEqual(["a", "b", "e", "f", "c", "d"]);
  });

  it("leaves the order alone when nothing below the head is in range", () => {
    expect(applyTimeScope(ids, 4, (x) => x === "a")).toEqual(ids);
    expect(applyTimeScope(ids, 4, () => false)).toEqual(ids);
  });

  it("widens the range by the slack days", () => {
    const range = { start: "2026-10-01", end: "2026-10-31" };
    expect(dayInRange("2026-11-02", range)).toBe(true);
    expect(dayInRange("2026-11-03", range)).toBe(false);
    expect(dayInRange(null, range)).toBe(false);
  });
});

describe("time scope in hybridSearch", () => {
  let dir: string;
  let storage: Storage;
  const OLD = "2026-01-15";

  // Every chunk holds the query words; fewer repeats of "budget" rank lower.
  // The documents live under concepts/, which the default recency maps keep
  // evergreen, so between two runs only the time scope can move a hit, whatever
  // recency settings another test file left in this process.
  const DOCS: Array<{ id: string; date?: string; repeats: number }> = [
    { id: "b1", date: OLD, repeats: 6 },
    { id: "b2", date: OLD, repeats: 5 },
    { id: "b3", date: OLD, repeats: 4 },
    { id: "b4", date: OLD, repeats: 3 },
    { id: "b5", date: OLD, repeats: 2 },
    { id: "b6", date: "2026-06-10", repeats: 1 },
    // No content date: its effective date is the row timestamp.
    { id: "b7", repeats: 1 },
  ];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "memrain-time-scope-"));
    storage = new Storage({ dbPath: join(dir, "db") });
    await storage.init();
    for (const d of DOCS) {
      const text = `${Array.from({ length: d.repeats }, () => "budget").join(" ")} review last month this week`;
      await writeDocumentTransaction(
        storage,
        {
          documentId: d.id,
          sourcePath: `concepts/${d.id}`,
          title: d.id,
          frontmatter: d.date ? { date: d.date } : {},
          embeddingModel: "deterministic-test",
        },
        [{ text, entities: [], embedding: deterministicEmbed(text) }],
      );
    }
  });
  afterAll(async () => {
    setSystemTime();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ids = async (query: string, now: string, extra: Record<string, unknown> = {}): Promise<string[]> => {
    setSystemTime(new Date(now));
    try {
      const { hits } = await runSearch(storage, query, { embedQuery: failingEmbed, k: 4, ...extra });
      return hits.map((h) => h.documentId);
    } finally {
      setSystemTime();
    }
  };

  // Value: protects=an in-range hit is lifted into the first k without moving the top half;
  // fails_when=the scope is not applied, or it reorders the head.
  it("lifts a hit dated last month into the first k and keeps the top half", async () => {
    const baseline = await ids("budget review last month", "2030-01-15T12:00:00Z");
    expect(baseline).toHaveLength(4);
    expect(baseline).not.toContain("b6");
    const scoped = await ids("budget review last month", "2026-07-01T12:00:00Z");
    expect(scoped.slice(0, 2)).toEqual(baseline.slice(0, 2));
    expect(scoped[2]).toBe("b6");
    expect(scoped[3]).toBe(baseline[2]);
  });

  // Value: protects=explicit since/until win over the parsed range; fails_when=both apply.
  it("stands down when the caller passes since or until", async () => {
    const baseline = await ids("budget review last month", "2030-01-15T12:00:00Z", { since: "2026-01-01" });
    const scoped = await ids("budget review last month", "2026-07-01T12:00:00Z", { since: "2026-01-01" });
    expect(scoped).toEqual(baseline);
    expect(scoped).not.toContain("b6");
  });

  // Value: protects=a row timestamp never counts as a content date; fails_when=the scope reads the
  // COALESCE'd date, which lifts every freshly written undated row for "this week".
  it("does not lift a hit whose only date is when the row was written", async () => {
    const baseline = await ids("budget review this week", "2030-01-15T12:00:00Z");
    expect(baseline).not.toContain("b7");
    const now = await ids("budget review this week", new Date().toISOString());
    expect(now).toEqual(baseline);
  });
});
