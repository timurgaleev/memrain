/** The stored chat trace never exceeds 16 KB and says when it was cut. */
import { describe, expect, it } from "bun:test";
import { capTrace, CHAT_TRACE_MAX_BYTES, type ChatTraceEvent } from "../src/core/chat/store.ts";

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

describe("capTrace", () => {
  it("keeps a trace that fits unchanged", () => {
    const events: ChatTraceEvent[] = [{ step: "intent", note: "other" }, { step: "gather", count: 2, slugs: ["a", "b"] }];
    expect(capTrace(events)).toEqual(events);
  });

  it("drops slug lists first when that is enough", () => {
    const events: ChatTraceEvent[] = Array.from({ length: 40 }, (_, i) => ({ step: "gather", count: i, slugs: ["x".repeat(150), "y".repeat(150), "z".repeat(150)] }));
    const capped = capTrace(events);
    expect(size(capped)).toBeLessThanOrEqual(CHAT_TRACE_MAX_BYTES);
    expect(capped).toHaveLength(40);
    expect(capped.every(e => e.slugs === undefined)).toBe(true);
  });

  it("cuts to a prefix marked truncated when even bare events do not fit", () => {
    const events: ChatTraceEvent[] = Array.from({ length: 400 }, (_, i) => ({ step: "gather", count: i, note: "n".repeat(100) }));
    const capped = capTrace(events);
    expect(size(capped)).toBeLessThanOrEqual(CHAT_TRACE_MAX_BYTES);
    expect(capped.length).toBeLessThan(400);
    expect(capped.at(-1)!.note).toBe("truncated");
    expect(capped[0]!.count).toBe(0);
  });
});
