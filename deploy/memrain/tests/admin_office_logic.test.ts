import { describe, expect, it } from "bun:test";
import type { FeedEvent, OfficeSnapshot } from "../admin/src/admin-types.ts";
import {
  applyEvent,
  describe as describeCharacter,
  initialState,
  namesFromSnapshot,
  tick,
  type OfficeState,
} from "../admin/src/office/model.ts";
import { roomFor } from "../admin/src/office/rooms.ts";

const NOW = 1_000_000;
const empty: OfficeState = { characters: new Map(), recent: [] };
const none = new Map<string, string>();

function ev(p: Partial<FeedEvent> & { agent: string }): FeedEvent {
  return { operation: "search", latency_ms: 1, status: "success", timestamp: "", ...p };
}

describe("roomFor", () => {
  it("routes tools and jobs", () => {
    expect(roomFor({ kind: "tool", agent: "x", operation: "search" })).toBe("archive");
    expect(roomFor({ kind: "tool", agent: "x", operation: "page_put" })).toBe("writing");
    expect(roomFor({ kind: "job", agent: "connector_sync", operation: "other" })).toBe("mailroom");
    expect(roomFor({ kind: "job", agent: "brand_new_daemon", operation: "other" })).toBe("back_office");
  });
});

describe("applyEvent", () => {
  it("does not mutate its input", () => {
    const st = applyEvent(empty, ev({ agent: "a" }), NOW, none);
    const before = structuredClone(st);
    applyEvent(st, ev({ agent: "a", operation: "page_put" }), NOW + 1, none);
    expect(st).toEqual(before);
  });

  it("ignores admin-panel", () => {
    expect(applyEvent(empty, ev({ agent: "admin-panel" }), NOW, none).characters.size).toBe(0);
  });

  it("keeps one character and a capped feed for many events", () => {
    let st = empty;
    for (let i = 0; i < 1000; i++) st = applyEvent(st, ev({ agent: "a" }), NOW + i, none);
    expect(st.characters.size).toBe(1);
    expect(st.recent.length).toBeLessThanOrEqual(20);
  });

  it("labels an unknown agent by its short id", () => {
    const st = applyEvent(empty, ev({ agent: "abcdef123456" }), NOW, none);
    expect(st.characters.get("abcdef123456")?.label).toBe("abcdef12");
  });

  it("records the error window on a failed job end", () => {
    const st = applyEvent(empty, ev({ agent: "cycle", kind: "job", phase: "end", status: "error" }), NOW, none);
    expect(st.characters.get("cycle")?.errorUntil).toBe(NOW + 3000);
  });

  it("does not duplicate a worker on a repeated job start", () => {
    let st = applyEvent(empty, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW, none);
    st = applyEvent(st, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW + 5, none);
    expect(st.characters.size).toBe(1);
    expect(st.characters.get("cycle")?.startedAt).toBe(NOW);
  });
});

describe("tick", () => {
  it("returns a job to the break room after 60s without an end", () => {
    const st = applyEvent(empty, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW, none);
    expect(tick(st, NOW + 30_000).characters.get("cycle")?.room).toBe("night_shift");
    expect(tick(st, NOW + 61_000).characters.get("cycle")?.room).toBe("break_room");
  });

  it("holds a tool visit for 4s", () => {
    const st = applyEvent(empty, ev({ agent: "a" }), NOW, none);
    expect(tick(st, NOW + 3_999).characters.get("a")?.room).toBe("archive");
    expect(tick(st, NOW + 4_001).characters.get("a")?.room).toBe("break_room");
  });
});

describe("initialState", () => {
  const snap: OfficeSnapshot = {
    workers: [
      { name: "cycle", enabled: true, running: true },
      { name: "worker", enabled: false, running: false },
    ],
    clients: [
      { id: "c1", display_name: "Claude Code", last_seen: new Date(NOW - 3600_000).toISOString() },
      { id: "c2", display_name: "Old", last_seen: new Date(NOW - 48 * 3600_000).toISOString() },
      { id: "c3", display_name: "Never", last_seen: null },
    ],
  };

  it("seeds workers and recent clients only", () => {
    const st = initialState(snap, NOW);
    expect([...st.characters.keys()].sort()).toEqual(["c1", "cycle", "worker"]);
    expect(st.characters.get("cycle")?.room).toBe("night_shift");
    expect(st.characters.get("cycle")?.busyUntil).toBe(Infinity);
    expect(st.characters.get("worker")?.room).toBe("break_room");
    expect(st.characters.get("worker")?.enabled).toBe(false);
  });

  it("describes characters from labels and rooms", () => {
    const names = namesFromSnapshot(snap);
    expect(names.get("c1")).toBe("Claude Code");
    const st = applyEvent(initialState(snap, NOW), ev({ agent: "c1" }), NOW, names);
    expect(describeCharacter(st.characters.get("c1")!)).toBe("Claude Code is searching memory");
    expect(describeCharacter(initialState(snap, NOW).characters.get("worker")!)).toBe("Librarian is idle");
  });
});
