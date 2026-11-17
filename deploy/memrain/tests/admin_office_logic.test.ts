import { describe, expect, it } from "bun:test";
import type { FeedEvent, OfficeSnapshot } from "../admin/src/admin-types.ts";
import {
  STALE_JOB_MS,
  applyEvent,
  applySnapshot,
  describe as describeCharacter,
  initialState,
  namesFromSnapshot,
  tick,
  type OfficeState,
} from "../admin/src/office/model.ts";
import { roomFor, type RoomId } from "../admin/src/office/rooms.ts";
import { OFFICE_MAP, PROPS, TILE, officeLayout, seatFor } from "../admin/src/office/map.ts";
import { MAX_STEP_MS, stepCharacter, type Pose } from "../admin/src/office/motion.ts";
import { findPath } from "../admin/src/office/path.ts";
import { parseHash } from "../admin/src/lib/route.ts";

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

  it("restarts startedAt on a repeated job start", () => {
    let st = applyEvent(empty, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW, none);
    st = applyEvent(st, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW + 5, none);
    expect(st.characters.size).toBe(1);
    expect(st.characters.get("cycle")?.startedAt).toBe(NOW + 5);
  });
});

describe("tick", () => {
  it("keeps a long job busy and drops it past the stale cap", () => {
    const st = applyEvent(empty, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW, none);
    expect(tick(st, NOW + 61_000).characters.get("cycle")?.room).toBe("night_shift");
    expect(tick(st, NOW + STALE_JOB_MS + 1).characters.get("cycle")?.room).toBe("break_room");
  });

  it("prunes a client idle in the break room for over 24h", () => {
    let st = applyEvent(empty, ev({ agent: "a" }), NOW, none);
    st = tick(st, NOW + 5_000);
    expect(st.characters.get("a")?.room).toBe("break_room");
    expect(tick(st, NOW + 25 * 3600_000).characters.has("a")).toBe(false);
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

describe("event rules", () => {
  it("marks a failed tool call", () => {
    const st = applyEvent(empty, ev({ agent: "a", status: "error" }), NOW, none);
    expect(st.characters.get("a")?.errorUntil).toBe(NOW + 3000);
  });

  it("ignores tool events for a worker", () => {
    const st = applyEvent(empty, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW, none);
    const after = applyEvent(st, ev({ agent: "cycle" }), NOW + 10, none);
    expect(after).toBe(st);
  });

  it("treats more mutating tools as writes", () => {
    for (const op of ["add_timeline_event", "set_take_status", "takes_resolve", "ontology_propose", "log_friction"])
      expect(roomFor({ kind: "tool", agent: "x", operation: op })).toBe("writing");
  });
});

describe("applySnapshot", () => {
  const snap = (workers: OfficeSnapshot["workers"], clients: OfficeSnapshot["clients"] = []): OfficeSnapshot => ({
    workers,
    clients,
  });

  it("refreshes a running worker and updates enabled", () => {
    const st = initialState(snap([{ name: "cycle", enabled: true, running: true }]), NOW);
    const out = applySnapshot(st, snap([{ name: "cycle", enabled: false, running: true }]), NOW + 119_000, NOW + 120_000);
    const c = out.characters.get("cycle")!;
    expect(c.startedAt).toBe(NOW + 120_000);
    expect(c.busyUntil).toBe(Infinity);
    expect(c.enabled).toBe(false);
  });

  it("ends a job whose end was lost", () => {
    const st = initialState(snap([{ name: "cycle", enabled: true, running: true }]), NOW);
    const out = applySnapshot(st, snap([{ name: "cycle", enabled: true, running: false }]), NOW + 1000, NOW + 2000);
    expect(out.characters.get("cycle")?.busyUntil).toBe(NOW + 2000);
    expect(tick(out, NOW + 2000).characters.get("cycle")?.room).toBe("break_room");
  });

  it("ignores a running snapshot requested before a job ended", () => {
    const run = ev({ agent: "cycle", kind: "job", phase: "start", status: "running" });
    let st = applyEvent(empty, run, NOW, none);
    st = applyEvent(st, { ...run, phase: "end", status: "success" }, NOW + 2000, none);
    const out = applySnapshot(st, snap([{ name: "cycle", enabled: true, running: true }]), NOW + 1000, NOW + 3000);
    expect(out.characters.get("cycle")?.busyUntil).toBe(NOW + 5000);
    expect(tick(out, NOW + 5000).characters.get("cycle")?.room).toBe("break_room");
  });

  it("leaves a start that arrived after the query", () => {
    const st = applyEvent(empty, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW + 500, none);
    const out = applySnapshot(st, snap([{ name: "cycle", enabled: true, running: false }]), NOW, NOW + 1000);
    expect(out.characters.get("cycle")?.busyUntil).toBe(Infinity);
  });

  it("adds new workers, not new clients, and refreshes labels", () => {
    const st = initialState(
      snap([], [{ id: "c1", display_name: "Old", last_seen: new Date(NOW).toISOString() }]),
      NOW,
    );
    const out = applySnapshot(
      st,
      snap(
        [{ name: "notifications", enabled: true, running: false }],
        [
          { id: "c1", display_name: "New", last_seen: null },
          { id: "c9", display_name: "Fresh", last_seen: new Date(NOW).toISOString() },
        ],
      ),
      NOW,
      NOW,
    );
    expect(out.characters.has("notifications")).toBe(true);
    expect(out.characters.has("c9")).toBe(false);
    expect(out.characters.get("c1")?.label).toBe("New");
  });
});

describe("findPath", () => {
  const W = 5;
  const H = 5;
  // Wall column at x=2, open only at the bottom row.
  const detour = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && !(x === 2 && y < 4);

  it("walks around a wall column", () => {
    const path = findPath({ x: 0, y: 0 }, { x: 4, y: 0 }, detour, W, H);
    expect(path).toHaveLength(12);
    expect(path.at(-1)).toEqual({ x: 4, y: 0 });
    expect(path[0]).not.toEqual({ x: 0, y: 0 });
    let prev = { x: 0, y: 0 };
    for (const step of path) {
      expect(Math.abs(step.x - prev.x) + Math.abs(step.y - prev.y)).toBe(1);
      expect(detour(step.x, step.y)).toBe(true);
      prev = step;
    }
  });

  it("returns [] when the target is walled off", () => {
    const sealed = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && x !== 2;
    expect(findPath({ x: 0, y: 0 }, { x: 4, y: 0 }, sealed, W, H)).toEqual([]);
  });

  it("returns [] for a target that is not walkable", () => {
    expect(findPath({ x: 0, y: 0 }, { x: 2, y: 0 }, detour, W, H)).toEqual([]);
  });
});

describe("OFFICE_MAP", () => {
  const rooms = Object.keys(OFFICE_MAP.seats) as RoomId[];

  it("has a room for every RoomId with enough seats", () => {
    expect([...rooms].sort()).toEqual(
      ([
        "archive", "assistant_desk", "back_office", "break_room", "library", "mailroom",
        "night_shift", "post_office", "reception", "waiting_board", "writing",
      ] satisfies RoomId[]).sort(),
    );
    for (const r of rooms) expect(OFFICE_MAP.seats[r].length).toBeGreaterThanOrEqual(4);
    expect(OFFICE_MAP.seats.break_room.length).toBeGreaterThanOrEqual(8);
  });

  it("puts every seat on a walkable tile reachable from the break room", () => {
    const home = OFFICE_MAP.seats.break_room[0]!;
    for (const r of rooms) {
      for (const seat of OFFICE_MAP.seats[r]) {
        expect(OFFICE_MAP.walkable(seat.x, seat.y)).toBe(true);
        if (seat.x === home.x && seat.y === home.y) continue;
        const path = findPath(home, seat, OFFICE_MAP.walkable, OFFICE_MAP.width, OFFICE_MAP.height);
        expect(path.length).toBeGreaterThan(0);
      }
    }
  });

  it("never shares a seat between rooms or within one", () => {
    const seen = new Set<string>();
    for (const r of rooms) {
      for (const s of OFFICE_MAP.seats[r]) {
        const key = `${s.x},${s.y}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it("seatFor wraps the index", () => {
    const n = OFFICE_MAP.seats.archive.length;
    expect(seatFor("archive", 0)).toEqual(OFFICE_MAP.seats.archive[0]!);
    expect(seatFor("archive", n + 1)).toEqual(OFFICE_MAP.seats.archive[1]!);
  });
});

describe("stepCharacter", () => {
  const start = OFFICE_MAP.seats.break_room[0]!;
  const target = OFFICE_MAP.seats.archive[0]!;
  const pose: Pose = { x: start.x, y: start.y, path: [], facing: "down", frame: 0 };

  it("jumps straight to the target under reduced motion", () => {
    const next = stepCharacter(pose, target, 16, { reducedMotion: true });
    expect({ x: next.x, y: next.y }).toEqual(target);
    expect(next.path).toEqual([]);
  });

  it("moves at most 3 tiles per second and does not mutate the pose", () => {
    const before = structuredClone(pose);
    const next = stepCharacter(pose, target, 1000, { reducedMotion: false });
    expect(pose).toEqual(before);
    const moved = Math.abs(next.x - start.x) + Math.abs(next.y - start.y);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(3 + 1e-9);
  });

  it("arrives after enough small steps", () => {
    let p = pose;
    for (let i = 0; i < 2000 && (p.x !== target.x || p.y !== target.y); i++) {
      p = stepCharacter(p, target, 50, { reducedMotion: false });
      expect(OFFICE_MAP.walkable(Math.round(p.x), Math.round(p.y))).toBe(true);
    }
    expect({ x: p.x, y: p.y }).toEqual(target);
    expect(p.path).toEqual([]);
  });
});

describe("stepCharacter limits", () => {
  const start = OFFICE_MAP.seats.break_room[0]!;
  const pose: Pose = { x: start.x, y: start.y, path: [], facing: "down", frame: 0 };
  const desk = PROPS.find((p) => p.solid)!;

  it("stays put when the target is a wall or a desk", () => {
    expect(stepCharacter(pose, { x: 0, y: 0 }, 100, { reducedMotion: false })).toEqual(pose);
    expect(stepCharacter(pose, { x: desk.x, y: desk.y }, 100, { reducedMotion: false })).toEqual(pose);
  });

  it("does not jump onto a wall or a desk under reduced motion", () => {
    expect(stepCharacter(pose, { x: 0, y: 0 }, 16, { reducedMotion: true })).toEqual(pose);
    expect(stepCharacter(pose, { x: desk.x, y: desk.y }, 16, { reducedMotion: true })).toEqual(pose);
  });

  it("caps one step so a long pause does not skip the walk", () => {
    const target = OFFICE_MAP.seats.archive[0]!;
    const next = stepCharacter(pose, target, 60_000, { reducedMotion: false });
    const moved = Math.abs(next.x - start.x) + Math.abs(next.y - start.y);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual((3 * MAX_STEP_MS) / 1000 + 1e-9);
    expect(MAX_STEP_MS).toBe(250);
  });
});

describe("officeLayout", () => {
  const pw = OFFICE_MAP.width * TILE;
  const ph = OFFICE_MAP.height * TILE;

  it("shrinks to fit a phone-width canvas without clipping", () => {
    const { scale, ox, oy } = officeLayout(343, 300);
    expect(scale).toBeLessThan(1);
    expect(ox).toBeGreaterThanOrEqual(0);
    expect(oy).toBeGreaterThanOrEqual(0);
    expect(ox + pw * scale).toBeLessThanOrEqual(343);
    expect(oy + ph * scale).toBeLessThanOrEqual(300);
  });

  it("keeps whole-number scales when the map fits", () => {
    expect(officeLayout(pw * 2, ph * 2)).toEqual({ scale: 2, ox: 0, oy: 0 });
    expect(officeLayout(pw * 2 + 100, ph * 3).scale).toBe(2);
    expect(officeLayout(pw, ph).scale).toBe(1);
  });
});

describe("office route", () => {
  it("opens the Office page from its hash", () => {
    expect(parseHash("#office").name).toBe("office");
  });
});
