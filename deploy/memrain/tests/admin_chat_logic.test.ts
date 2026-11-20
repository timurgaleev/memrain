/**
 * The admin Ask page's pure helpers (admin/src/chat/): reading a POSTed
 * text/event-stream in arbitrary chunks, checking each event's shape before
 * the page trusts it, and the words the page shows for trace steps, costs and
 * every outcome code. No DOM.
 */
import { describe, expect, it } from "bun:test";
import { createSseParser, type SseMessage } from "../admin/src/chat/sse.ts";
import { locateQuote } from "../admin/src/lib/quote-find.ts";
import {
  parseCitations,
  parseModels,
  parseThread,
  parseThreads,
  parseTraceList,
  toChatEvent,
} from "../admin/src/chat/events.ts";
import {
  answerOutcome,
  exampleQuestions,
  fmtCost,
  fmtDuration,
  outcomeCopy,
  overCap,
  traceLabel,
  traceSummary,
} from "../admin/src/chat/copy.ts";
import { buildHash, parseHash } from "../admin/src/lib/route.ts";

function collect(chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const p = createSseParser((m) => out.push(m));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
}

describe("SSE parser", () => {
  it("reads named events with JSON data", () => {
    expect(collect(['event: trace\ndata: {"step":"intent"}\n\nevent: done\ndata: {}\n\n'])).toEqual([
      { event: "trace", data: '{"step":"intent"}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("reassembles an event split across chunks at any byte", () => {
    const whole = 'event: answer\ndata: {"a":1}\n\nevent: done\ndata: {}\n\n';
    for (let cut = 1; cut < whole.length; cut++) {
      expect(collect([whole.slice(0, cut), whole.slice(cut)])).toEqual([
        { event: "answer", data: '{"a":1}' },
        { event: "done", data: "{}" },
      ]);
    }
  });

  it("accepts CRLF and lone CR line endings, including a CRLF split between chunks", () => {
    expect(collect(["event: trace\r\ndata: {}\r", "\n\r\n"])).toEqual([{ event: "trace", data: "{}" }]);
    expect(collect(["event: trace\rdata: {}\r\r"])).toEqual([{ event: "trace", data: "{}" }]);
  });

  it("joins multi-line data, ignores comments and defaults the event name to message", () => {
    expect(collect([": keep-alive\n\ndata: a\ndata: b\n\n"])).toEqual([{ event: "message", data: "a\nb" }]);
  });

  it("drops a block with no data and an unterminated tail", () => {
    expect(collect(["event: trace\n\n", "event: answer\ndata: {}"])).toEqual([]);
  });

  it("strips exactly one space after the colon", () => {
    expect(collect(["data:  x\n\n"])).toEqual([{ event: "message", data: " x" }]);
  });
});

describe("chat events", () => {
  it("accepts a trace event and keeps only its known small fields", () => {
    expect(toChatEvent({ event: "trace", data: '{"step":"gather","count":4,"slugs":["a/b",7],"ms":12,"body":"secret"}' })).toEqual({
      type: "trace", trace: { step: "gather", count: 4, slugs: ["a/b"], ms: 12 },
    });
  });

  it("accepts an answer and drops malformed citations", () => {
    const e = toChatEvent({ event: "answer", data: JSON.stringify({
      thread_id: "t1", message_id: "m1", status: "ok", answer: "Yes [1].",
      citations: [{ n: 1, slug: "notes/a", title: "A" }, { n: "x", slug: "notes/b" }, { n: 2, slug: "", title: "" }],
      gaps: ["the date", 3], model: "small-1", cost_usd: 0.0012, duration_ms: 2100,
    }) });
    expect(e).toEqual({ type: "answer", answer: {
      thread_id: "t1", message_id: "m1", status: "ok", answer: "Yes [1].",
      citations: [{ n: 1, slug: "notes/a", title: "A" }], gaps: ["the date"],
      model: "small-1", cost_usd: 0.0012, duration_ms: 2100, code: null,
    } });
  });

  it("accepts a numeric message id from a bigserial column", () => {
    const e = toChatEvent({ event: "answer", data: JSON.stringify({ thread_id: "t1", message_id: 42, status: "ok", answer: "", citations: [], gaps: [], model: null, cost_usd: null, duration_ms: 1 }) });
    expect(e?.type === "answer" && e.answer.message_id).toBe("42");
  });

  it("refuses an answer with an unknown status or no thread id", () => {
    expect(toChatEvent({ event: "answer", data: JSON.stringify({ thread_id: "t1", message_id: "m", status: "great", answer: "" }) })).toBeNull();
    expect(toChatEvent({ event: "answer", data: JSON.stringify({ message_id: "m", status: "ok", answer: "" }) })).toBeNull();
  });

  it("reads error and done events, and ignores unknown events and bad JSON", () => {
    expect(toChatEvent({ event: "error", data: '{"code":"timeout","message":"slow"}' })).toEqual({ type: "error", error: { code: "timeout", message: "slow" } });
    expect(toChatEvent({ event: "done", data: "{}" })).toEqual({ type: "done" });
    expect(toChatEvent({ event: "ping", data: "{}" })).toBeNull();
    expect(toChatEvent({ event: "trace", data: "{not json" })).toBeNull();
  });

  it("reads a stored trace list and skips entries with no step", () => {
    expect(parseTraceList([{ step: "intent" }, { count: 2 }, "x", { step: "settle", usd: 0.001 }])).toEqual([
      { step: "intent" }, { step: "settle", usd: 0.001 },
    ]);
    expect(parseTraceList({ truncated: true })).toEqual([]);
  });

  it("reads the thread list and a thread with its messages", () => {
    expect(parseThreads({ threads: [{ id: "t1", title: null, updated_at: "2026-11-01T00:00:00Z", message_count: 2 }, { title: "x" }] })).toEqual([
      { id: "t1", title: null, updated_at: "2026-11-01T00:00:00Z", message_count: 2 },
    ]);
    const t = parseThread({
      thread: { id: "t1", title: "Plans", created_at: "a", updated_at: "b" },
      messages: [
        { id: 1, role: "user", content: "q", status: null, citations: null, gaps: null, model: null, cost_usd: null, trace: null, created_at: "a", saved_slug: null },
        { id: 2, role: "assistant", content: "A", status: "ok", citations: [{ n: 1, slug: "s", title: "S" }], gaps: [], model: "m", cost_usd: 0.002, trace: [{ step: "settle" }], created_at: "b", saved_slug: "chats/x" },
        { id: 3, role: "system", content: "hidden" },
      ],
    });
    expect(t.thread.title).toBe("Plans");
    expect(t.messages.map((m) => [m.id, m.role])).toEqual([["1", "user"], ["2", "assistant"]]);
    expect(t.messages[1]?.saved_slug).toBe("chats/x");
    expect(t.messages[1]?.trace).toEqual([{ step: "settle" }]);
  });

  it("reads the model list and keeps only priced models", () => {
    expect(parseModels({ enabled: true, default: "m1", answer_cap_usd: 0.02, models: [
      { id: "m1", label: "Small", input_usd_per_m: 0.25, output_usd_per_m: 1.25, estimate_usd: 0.004 },
      { id: "m2", label: "No price", input_usd_per_m: null, output_usd_per_m: null, estimate_usd: null },
    ] })).toEqual({ enabled: true, default: "m1", answer_cap_usd: 0.02, models: [
      { id: "m1", label: "Small", input_usd_per_m: 0.25, output_usd_per_m: 1.25, estimate_usd: 0.004 },
    ] });
    expect(parseModels({}).enabled).toBe(false);
  });
});

describe("chat copy", () => {
  it("formats a small cost with enough digits to read, and never fakes a zero for unknown", () => {
    expect(fmtCost(0.0012)).toBe("$0.0012");
    expect(fmtCost(0.02)).toBe("$0.0200");
    expect(fmtCost(1.5)).toBe("$1.50");
    expect(fmtCost(0.00001)).toBe("<$0.0001");
    expect(fmtCost(0)).toBe("$0");
    expect(fmtCost(null)).toBe("price unknown");
  });

  it("formats durations", () => {
    expect(fmtDuration(850)).toBe("850 ms");
    expect(fmtDuration(2100)).toBe("2.1 s");
    expect(fmtDuration(null)).toBe("");
  });

  it("names each trace step in plain words", () => {
    expect(traceLabel({ step: "gather", count: 4 })).toBe("Searched memory, found 4");
    expect(traceLabel({ step: "reserve", usd: 0.02 })).toBe("Set aside up to $0.0200 for the answer");
    expect(traceLabel({ step: "settle", usd: 0.0012 })).toBe("Final cost $0.0012");
    expect(traceLabel({ step: "something_new" })).toBe("something_new");
  });

  it("sums up a finished trace in one line", () => {
    const trace = [{ step: "intent" }, { step: "gather", count: 3 }, { step: "gather", count: 1 }, { step: "gather", count: 0 }, { step: "settle", usd: 0.0012 }];
    expect(traceSummary(trace, null)).toBe("Searched 3 places · $0.0012");
    expect(traceSummary([{ step: "gather" }], 0.003)).toBe("Searched 1 place · $0.0030");
    expect(traceSummary([], null)).toBe("No search steps recorded");
  });

  it("maps answer statuses to outcome codes", () => {
    expect(answerOutcome("ok", null)).toBeNull();
    expect(answerOutcome("refused", null)).toBe("refused");
    expect(answerOutcome("budget", null)).toBe("budget_exhausted");
    expect(answerOutcome("disabled", null)).toBe("chat_disabled");
    expect(answerOutcome("error", "timeout")).toBe("timeout");
    expect(answerOutcome("error", null)).toBe("provider_error");
  });

  it("gives every outcome a human line and says which ones can be retried", () => {
    for (const code of ["timeout", "rate_limited", "network", "provider_error", "budget_exhausted", "chat_disabled", "invalid_params", "db_busy", "refused", "stream_closed", "unconfirmed", "made_up_code"]) {
      const c = outcomeCopy(code);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.title).not.toContain("_");
    }
    expect(outcomeCopy("budget_exhausted")).toMatchObject({ retry: false, spendLink: true });
    expect(outcomeCopy("budget_exhausted").detail).toContain("00:00 UTC");
    expect(outcomeCopy("chat_disabled")).toMatchObject({ retry: false, enableHint: true });
    expect(outcomeCopy("timeout").retry).toBe(true);
    expect(outcomeCopy("db_busy").retry).toBe(true);
    expect(outcomeCopy("invalid_params").retry).toBe(false);
  });

  it("warns only when the estimate is above the per-answer cap", () => {
    expect(overCap(0.03, 0.02)).toBe(true);
    expect(overCap(0.02, 0.02)).toBe(false);
    expect(overCap(null, 0.02)).toBe(false);
  });

  it("builds up to three example questions from recent page titles, without repeats", () => {
    expect(exampleQuestions([
      { summary: "Planning offsite", slug: "a" }, { summary: "Planning offsite", slug: "b" }, { summary: "", slug: "c" },
      { summary: "Vendor contract", slug: "d" }, { summary: "Q3 budget", slug: "e" }, { summary: "Extra", slug: "f" },
    ])).toEqual([
      "What do I know about Planning offsite?",
      "What do I know about Vendor contract?",
      "What do I know about Q3 budget?",
    ]);
    expect(exampleQuestions([{ summary: "x".repeat(200), slug: "a" }])[0]!.length).toBeLessThanOrEqual(110);
  });

  it("routes #ask with an optional thread id", () => {
    expect(parseHash("#ask")).toEqual({ name: "ask", param: null });
    expect(parseHash("#ask/t-1")).toEqual({ name: "ask", param: "t-1" });
    expect(buildHash({ name: "ask", param: "t-1" })).toBe("#ask/t-1");
  });

  it("carries a cited quote on a page link, apart from the slug", () => {
    const hash = buildHash({ name: "page", param: "notes/plan?v2", quote: "plant tomatoes & beans?" });
    expect(hash).toBe("#page/notes%2Fplan%3Fv2?q=plant%20tomatoes%20%26%20beans%3F");
    expect(parseHash(hash)).toEqual({ name: "page", param: "notes/plan?v2", quote: "plant tomatoes & beans?" });
    expect(parseHash("#page/notes%2Fplan")).toEqual({ name: "page", param: "notes/plan" });
    expect(parseHash("#page/notes%2Fplan?q=")).toEqual({ name: "page", param: "notes/plan" });
    expect(parseHash(buildHash({ name: "page", param: "deals/x", quote: "50% off + more" })).quote).toBe("50% off + more");
    expect(parseCitations([{ n: 1, slug: "notes/plan", title: "Plan", quote: "plant tomatoes" }, { n: 2, slug: "x", title: "X", quote: 7 }]))
      .toEqual([{ n: 1, slug: "notes/plan", title: "Plan", quote: "plant tomatoes" }, { n: 2, slug: "x", title: "X" }]);
  });

  it("finds a quote across text nodes, ignoring case, spacing, curly quotes and a trailing stop", () => {
    // "The plan: **plant tomatoes**\n in May." rendered as three text nodes.
    const nodes = ["The plan: ", "plant   Tomatoes", "\n in May’s heat."];
    expect(locateQuote(nodes, "plant tomatoes in May's heat.")).toEqual({ start: [1, 0], end: [2, 15] });
    expect(locateQuote(nodes, "The plan")).toEqual({ start: [0, 0], end: [0, 8] });
    expect(locateQuote(nodes, "tomatoes in June")).toBeNull();
    expect(locateQuote(nodes, "  ")).toBeNull();
    // An elided quote highlights its first part.
    expect(locateQuote(nodes, "plant tomatoes ... heat")).toEqual({ start: [1, 0], end: [1, 16] });
  });
});
