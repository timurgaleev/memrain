/**
 * An impossible calendar date (2026-02-30) is refused by add_timeline_event and
 * yields no frontmatter effective date, instead of rolling over into March.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { resolveEffectiveDate } from "../src/core/effective-date.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-timeline-date-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await putPage(storage, { slug: "notes/x", type: "note", markdown_body: "x" });
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("impossible calendar dates", () => {
  it("add_timeline_event refuses 2026-02-30 instead of rolling it to March", async () => {
    for (const occurred_at of ["2026-02-30", "2026-04-31T10:00:00Z"]) {
      await expect(addTimelineEvent(storage, { slug: "notes/x", occurred_at, event: "e" }))
        .rejects.toMatchObject({ code: "invalid_params" });
    }
    const ok = await addTimelineEvent(storage, { slug: "notes/x", occurred_at: "2026-02-28T10:00:00Z", event: "e" });
    expect(ok.occurred_at.startsWith("2026-02-28")).toBe(true);
    // Only the calendar is checked: an old but real date still lands.
    const old = await addTimelineEvent(storage, { slug: "notes/x", occurred_at: "1850-03-01", event: "e" });
    expect(old.inserted).toBe(true);
  });

  it("an impossible frontmatter date yields no effective date", () => {
    expect(resolveEffectiveDate({ date: "2026-02-30" }, null)).toBeNull();
    expect(resolveEffectiveDate({ date: "2026-02-28" }, null)).toBe("2026-02-28T00:00:00.000Z");
  });
});
