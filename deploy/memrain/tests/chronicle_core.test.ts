/**
 * Life Chronicle core — eligibility matrix + event extractor (with a stubbed
 * judge, so no Bedrock). Covers the privacy/anti-loop exclusions, the
 * deterministic write path, the all-or-nothing parse barrier, and idempotency.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { getLastSeen, getTimelineForDate, upsertEventProjection } from "../src/core/chronicle.ts";
import { isChronicleEligible } from "../src/core/chronicle/eligibility.ts";
import {
  runChronicleExtract,
  screenChronicleProposals,
  type ChronicleJudge,
  type ChronicleEventProposal,
} from "../src/core/chronicle/extract-events.ts";
import {
  STOP_REASON_MAX_TOKENS,
  type SonnetFn,
} from "../src/core/llm/sonnet.ts";
import {
  registerChronicleHandler,
  CHRONICLE_EXTRACT_JOB_KIND,
} from "../src/core/jobs/chronicle-handler.ts";
import { getHandler, _resetHandlersForTesting } from "../src/core/jobs/handlers.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-chron-core-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const LONG_BODY = "x".repeat(120);

/** A judge that returns a fixed proposal list, ignoring its input. */
function stubJudge(events: ChronicleEventProposal[]): ChronicleJudge {
  return async () => ({ events });
}

describe("isChronicleEligible", () => {
  it("accepts a conversation-shape meeting", () => {
    expect(isChronicleEligible({ type: "meeting", slug: "meetings/a", body: LONG_BODY }).ok).toBe(true);
  });

  it("rescues a note under a meetings/ prefix", () => {
    expect(isChronicleEligible({ type: "note", slug: "meetings/b", body: LONG_BODY }).ok).toBe(true);
  });

  it("excludes diary pages (privacy invariant)", () => {
    expect(isChronicleEligible({ type: "diary", slug: "life/diary/2026-01-01", body: LONG_BODY }))
      .toEqual({ ok: false, reason: "diary_excluded" });
    expect(isChronicleEligible({ type: "note", slug: "life/diary/x", body: LONG_BODY }).ok).toBe(false);
  });

  it("excludes event pages (anti-loop)", () => {
    expect(isChronicleEligible({ type: "event", slug: "life/events/x", body: LONG_BODY }))
      .toEqual({ ok: false, reason: "event_self" });
  });

  it("excludes too-short bodies", () => {
    expect(isChronicleEligible({ type: "meeting", slug: "meetings/c", body: "short" }))
      .toEqual({ ok: false, reason: "too_short" });
  });

  it("excludes subagent scratch pages", () => {
    expect(isChronicleEligible({ type: "meeting", slug: "wiki/agents/x", body: LONG_BODY }))
      .toEqual({ ok: false, reason: "subagent_scratch" });
  });

  it("excludes dream/synth-generated pages", () => {
    expect(isChronicleEligible({ type: "meeting", slug: "meetings/d", body: LONG_BODY, dreamGenerated: true }))
      .toEqual({ ok: false, reason: "dream_generated" });
  });

  it("excludes non-conversation types", () => {
    expect(isChronicleEligible({ type: "note", slug: "notes/x", body: LONG_BODY }).ok).toBe(false);
  });
});

describe("screenChronicleProposals", () => {
  const ev = (when: string): ChronicleEventProposal => ({ when, who: [], what: "x", kind: "event" });

  it("cuts off at the earlier of the page's day and today", () => {
    const proposals = [ev("2026-01-10"), ev("2026-01-11"), ev("2026-01-09T23:00:00Z")];
    expect(screenChronicleProposals(proposals, "2026-01-10", "2026-05-01").dropped).toEqual({ future_dated: 1 });
    // A page dated ahead of today is still bounded by today.
    expect(screenChronicleProposals(proposals, "2026-12-31", "2026-01-10").kept).toHaveLength(2);
    expect(screenChronicleProposals(proposals, null, "2026-01-09").kept).toHaveLength(1);
  });

  it("marks a when with no day as date_imprecise", () => {
    const { kept, dropped } = screenChronicleProposals([ev("2024"), ev("2026-03"), ev("2026-03-02 10:00")], "2026-03-02", "2026-04-01");
    expect(kept.map((e) => e.when)).toEqual(["2026-03-02 10:00"]);
    expect(dropped).toEqual({ date_imprecise: 2 });
  });
});

describe("runChronicleExtract", () => {
  async function seedDepth(slug = "meetings/2026-01-10"): Promise<string> {
    await putPage(storage, {
      slug,
      type: "meeting",
      title: "Kickoff",
      compiled_truth: { date: "2026-01-10", attendees: ["people/alice"] },
      markdown_body: LONG_BODY,
    });
    return slug;
  }

  it("writes an event page + timeline projection on the happy path", async () => {
    const slug = await seedDepth();
    const res = await runChronicleExtract(storage, {
      slug,
      sourceId: "default",
      judge: stubJudge([
        { when: "2026-01-10", who: ["people/alice"], what: "Kickoff call", kind: "call" },
      ]),
    });
    expect(res.status).toBe("extracted");
    expect(res.events_written).toBe(1);

    const rows = await getTimelineForDate(storage, "2026-01-10", { sourceIds: ["default"] });
    expect(rows.length).toBe(1);
    expect(rows[0]!.summary).toBe("Kickoff call");
    expect(rows[0]!.kind).toBe("call");
    expect(rows[0]!.event_slug).toMatch(/^life\/events\/2026-01-10-/);
    expect(rows[0]!.slug).toBe(slug);

    const ev = await getPage(storage, rows[0]!.event_slug!, ["default"]);
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("event");
  });

  it("drops placeholder participants from the stored who", async () => {
    const slug = await seedDepth();
    await runChronicleExtract(storage, {
      slug,
      sourceId: "default",
      judge: stubJudge([
        { when: "2026-01-10", who: ["people/alice", "team", "Someone", "7"], what: "Planning", kind: "meeting" },
      ]),
    });
    const rows = await getTimelineForDate(storage, "2026-01-10", { sourceIds: ["default"] });
    const ev = await getPage(storage, rows[0]!.event_slug!, ["default"]);
    const event = (ev!.compiled_truth as { event: { who: string[] } }).event;
    expect(event.who).toEqual(["people/alice"]);
  });

  it("rejects the WHOLE batch when ONE proposal has a malformed date", async () => {
    const slug = await seedDepth();
    const res = await runChronicleExtract(storage, {
      slug,
      judge: stubJudge([
        { when: "2026-01-10", who: [], what: "good", kind: "call" },
        { when: "not-a-date", who: [], what: "bad", kind: "call" },
      ]),
    });
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("malformed_proposal");
    expect(res.events_written).toBe(0);
    // No partial writes: nothing projected.
    const rows = await getTimelineForDate(storage, "2026-01-10", { sourceIds: ["default"] });
    expect(rows.length).toBe(0);
  });

  it("returns no_events on an empty judge result", async () => {
    const slug = await seedDepth();
    const res = await runChronicleExtract(storage, { slug, judge: stubJudge([]) });
    expect(res.status).toBe("no_events");
    expect(res.events_written).toBe(0);
  });

  it("skips a missing page", async () => {
    const res = await runChronicleExtract(storage, { slug: "meetings/ghost", judge: stubJudge([]) });
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("page_not_found");
  });

  it("is idempotent — a re-run reuses the same slug with no duplicate rows", async () => {
    const slug = await seedDepth();
    const judge = stubJudge([
      { when: "2026-01-10", who: ["people/alice"], what: "Kickoff call", kind: "call" },
    ]);
    const first = await runChronicleExtract(storage, { slug, judge });
    const second = await runChronicleExtract(storage, { slug, judge });
    expect(first.events_written).toBe(1);
    expect(second.events_written).toBe(1);

    const rows = await getTimelineForDate(storage, "2026-01-10", { sourceIds: ["default"] });
    expect(rows.length).toBe(1);
    const events = await storage.engine().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pages WHERE type = 'event' AND deleted_at IS NULL",
    );
    expect(events.rows[0]!.n).toBe(1);
  });

  it("caps events at 10 per page (whole batch still validated)", async () => {
    const slug = await seedDepth();
    const many: ChronicleEventProposal[] = Array.from({ length: 12 }, (_, i) => ({
      when: "2026-01-10", who: [], what: `Event ${i}`, kind: "call",
    }));
    const res = await runChronicleExtract(storage, { slug, judge: stubJudge(many) });
    expect(res.events_written).toBe(10);
    const n = await storage.engine().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pages WHERE type = 'event' AND deleted_at IS NULL",
    );
    expect(n.rows[0]!.n).toBe(10);
  });

  it("drops a proposal dated after the page's day and keeps the meeting itself", async () => {
    const slug = await seedDepth();
    const res = await runChronicleExtract(storage, {
      slug,
      judge: stubJudge([
        { when: "2026-01-10", who: ["people/alice"], what: "Kickoff call", kind: "call" },
        { when: "2026-01-24", who: ["people/alice"], what: "Follow-up review", kind: "meeting" },
      ]),
    });
    expect(res.status).toBe("extracted");
    expect(res.events_written).toBe(1);
    expect(res.events_dropped).toEqual({ future_dated: 1 });
    expect(await getTimelineForDate(storage, "2026-01-24", { sourceIds: ["default"] })).toHaveLength(0);
  });

  it("refuses year- or month-only dates instead of pinning them to the first", async () => {
    const slug = await seedDepth();
    const res = await runChronicleExtract(storage, {
      slug,
      judge: stubJudge([
        { when: "2024", who: [], what: "Founded the company", kind: "milestone" },
        { when: "2025-03", who: [], what: "Moved to Berlin", kind: "travel" },
      ]),
    });
    expect(res.status).toBe("no_events");
    expect(res.reason).toBe("date_imprecise");
    expect(res.events_dropped).toEqual({ date_imprecise: 2 });
    const n = await storage.engine().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pages WHERE type = 'event' AND deleted_at IS NULL",
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it("bounds an undated page by today", async () => {
    await putPage(storage, {
      slug: "meetings/undated",
      type: "meeting",
      title: "Sync",
      compiled_truth: { attendees: ["people/alice"] },
      markdown_body: LONG_BODY,
    });
    const res = await runChronicleExtract(storage, {
      slug: "meetings/undated",
      now: new Date("2026-02-01T12:00:00Z"),
      judge: stubJudge([
        { when: "2026-02-01T09:00:00Z", who: [], what: "Sync call", kind: "call" },
        { when: "2026-02-15", who: [], what: "Launch", kind: "milestone" },
      ]),
    });
    expect(res.events_written).toBe(1);
    expect(res.events_dropped).toEqual({ future_dated: 1 });
  });

  it("propagates a TRANSIENT judge error so the job can retry", async () => {
    const slug = await seedDepth();
    const throttled: ChronicleJudge = async () => {
      throw new Error("ThrottlingException: too many requests");
    };
    await expect(
      runChronicleExtract(storage, { slug, judge: throttled }),
    ).rejects.toThrow(/Throttling/);
  });

  it("absorbs a PERMANENT judge error as a skipped result (job DONE)", async () => {
    const slug = await seedDepth();
    const denied: ChronicleJudge = async () => {
      throw new Error("AccessDeniedException: not authorized for this model");
    };
    const res = await runChronicleExtract(storage, { slug, judge: denied });
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("judge_error");
    expect(res.events_written).toBe(0);
  });
});

/**
 * The paid judge and the output cap.
 *
 * An event-dense page whose JSON array is cut mid-element parses to NOTHING, so
 * the old outcome was `no_events` — the spend booked and the page recorded as
 * having no events, which nothing would ever re-run. The judge now buys more
 * room once (temperature 0 means the same cap always cuts in the same place),
 * and only when the per-run USD ceiling covers the second call.
 *
 * These exercise the DEFAULT judge — the one that carries the retry — through
 * its injected transport seam, so still no Bedrock.
 */
describe("runChronicleExtract — truncated judge output", () => {
  const MODEL = "eu.anthropic.claude-sonnet-4-6";
  const CUT = `[{"when":"2026-01-10","who":["people/alice"],"what":"Kick`;
  const WHOLE =
    `[{"when":"2026-01-10","who":["people/alice"],"what":"Kickoff call","kind":"call"}]`;

  function scriptedSonnet(replies: { text: string; stopReason?: string }[]) {
    const caps: number[] = [];
    const fn: SonnetFn = async (input) => {
      const r = replies[Math.min(caps.length, replies.length - 1)]!;
      caps.push(input.maxTokens);
      return {
        text: r.text,
        modelId: MODEL,
        usage: { inputTokens: 100, outputTokens: 50 },
        ...(r.stopReason ? { stopReason: r.stopReason } : {}),
      };
    };
    return { fn, caps };
  }

  async function seedDepth(slug = "meetings/2026-01-10"): Promise<string> {
    await putPage(storage, {
      slug,
      type: "meeting",
      title: "Kickoff",
      compiled_truth: { date: "2026-01-10", attendees: ["people/alice"] },
      markdown_body: LONG_BODY,
    });
    return slug;
  }

  it("retries once at a LARGER cap and writes the events the second call returned", async () => {
    const slug = await seedDepth();
    const { fn, caps } = scriptedSonnet([
      { text: CUT, stopReason: STOP_REASON_MAX_TOKENS },
      { text: WHOLE },
    ]);
    const res = await runChronicleExtract(storage, { slug, sonnetFn: fn, modelId: MODEL });
    expect(caps).toEqual([1500, 3000]);
    expect(res.status).toBe("extracted");
    expect(res.events_written).toBe(1);
  });

  it("still truncated → skipped/truncated, NOT no_events, and nothing written", async () => {
    const slug = await seedDepth();
    const { fn, caps } = scriptedSonnet([{ text: CUT, stopReason: STOP_REASON_MAX_TOKENS }]);
    const res = await runChronicleExtract(storage, { slug, sonnetFn: fn, modelId: MODEL });
    expect(caps.length).toBe(2); // one retry, not a loop
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("truncated"); // "no_events" would call the page done
    expect(res.events_written).toBe(0);
    const rows = await getTimelineForDate(storage, "2026-01-10", { sourceIds: ["default"] });
    expect(rows.length).toBe(0);
  });

  it("skips the enlarged retry when the per-run budget cannot cover it", async () => {
    const slug = await seedDepth();
    const { fn, caps } = scriptedSonnet([{ text: CUT, stopReason: STOP_REASON_MAX_TOKENS }]);
    // Room for the first call's worst case, not for the doubled-output retry.
    const res = await runChronicleExtract(storage, {
      slug,
      sonnetFn: fn,
      modelId: MODEL,
      maxBudgetUsd: 0.04,
    });
    expect(caps).toEqual([1500]); // paying twice for the identical cut is the bug
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("truncated");
  });
});

describe("getLastSeen date bound", () => {
  // A scheduled call or a planned milestone is a legitimate chronicle row, but
  // it is not an appearance — "last seen" must stay on the past side of the
  // reference day, or the future row lands as last_date and days_ago clamps to 0.
  async function seedPastAndFuture(): Promise<void> {
    await putPage(storage, {
      slug: "meetings/2026-01-10",
      type: "meeting",
      title: "Kickoff",
      markdown_body: LONG_BODY,
    });
    const res = await runChronicleExtract(storage, {
      slug: "meetings/2026-01-10",
      sourceId: "default",
      judge: stubJudge([
        { when: "2026-01-10", who: ["people/alice"], what: "Kickoff call", kind: "call" },
      ]),
    });
    expect(res.events_written).toBe(1);
    // The extractor refuses future-dated proposals, so the future row is
    // written the way older extractions left them: an event page + projection.
    const eventSlug = "life/events/2099-05-05-planned";
    await putPage(storage, {
      slug: eventSlug,
      type: "event",
      title: "Planned launch",
      compiled_truth: {
        type: "event",
        event: { when: "2099-05-05", who: ["people/alice"], what: "Planned launch", kind: "call", depth: "meetings/2026-01-10" },
      },
      markdown_body: "Planned launch",
      source_id: "default",
    });
    await upsertEventProjection(storage, {
      depthSlug: "meetings/2026-01-10",
      eventSlug,
      dateISO: "2099-05-05",
      occurredAt: "2099-05-05T00:00:00.000Z",
      summary: "Planned launch",
      sourceId: "default",
    });
  }

  it("skips a future-dated event and returns the most recent PAST one", async () => {
    await seedPastAndFuture();
    const seen = await getLastSeen(storage, "people/alice", {
      sourceIds: ["default"],
      asof: "2026-01-20",
    });
    expect(seen.last_date).toBe("2026-01-10");
    expect(seen.days_ago).toBe(10);
  });

  it("defaults the bound to today when no asof is given", async () => {
    await seedPastAndFuture();
    const seen = await getLastSeen(storage, "people/alice", { sourceIds: ["default"] });
    expect(seen.last_date).toBe("2026-01-10");
  });

  it("lets the event through once asof passes it (time travel)", async () => {
    await seedPastAndFuture();
    const seen = await getLastSeen(storage, "people/alice", {
      sourceIds: ["default"],
      asof: "2099-05-06",
    });
    expect(seen.last_date).toBe("2099-05-05");
    expect(seen.days_ago).toBe(1);
  });
});

describe("chronicle_extract job handler", () => {
  async function seedDepth(slug = "meetings/handler"): Promise<string> {
    await putPage(storage, {
      slug, type: "meeting", markdown_body: "x".repeat(120), compiled_truth: {},
    });
    return slug;
  }

  // The registered handler ignores its ctx arg; call it with the payload only.
  function invoke(payload: Record<string, unknown>) {
    const h = getHandler(CHRONICLE_EXTRACT_JOB_KIND)!;
    return (h as (p: Record<string, unknown>) => Promise<unknown>)(payload);
  }

  it("re-throws a transient judge error out of the handler (worker retries)", async () => {
    _resetHandlersForTesting();
    const slug = await seedDepth();
    registerChronicleHandler(storage, {
      judge: async () => {
        throw new Error("ThrottlingException: slow down");
      },
    });
    await expect(invoke({ slug, sourceId: "default" })).rejects.toThrow(/Throttling/);
  });

  it("returns a skipped result on a permanent judge error (no throw)", async () => {
    _resetHandlersForTesting();
    const slug = await seedDepth();
    registerChronicleHandler(storage, {
      judge: async () => {
        throw new Error("AccessDeniedException");
      },
    });
    const res = (await invoke({ slug, sourceId: "default" })) as { status: string; reason?: string };
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("judge_error");
  });
});
