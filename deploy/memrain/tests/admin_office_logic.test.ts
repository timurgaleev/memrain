import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { FeedEvent, OfficeSnapshot } from "../admin/src/admin-types.ts";
import {
  STALE_JOB_MS,
  applyEvent,
  applySnapshot,
  describe as describeCharacter,
  initialState,
  lineFor,
  namesFromSnapshot,
  tick,
  type Character,
  type OfficeState,
} from "../admin/src/office/model.ts";
import { emptyAmbient, facingProp, planAmbient, targetFor } from "../admin/src/office/ambient.ts";
import { roomFor, type RoomId } from "../admin/src/office/rooms.ts";
import { AMBIENT_SPOTS, CHAT_SPOTS, OFFICE_MAP, PROPS, TILE, WALL_DECOR, officeLayout, roomAt, seatFor, spotFor } from "../admin/src/office/map.ts";
import { MAX_STEP_MS, stepCharacter, type Pose } from "../admin/src/office/motion.ts";
import { findPath } from "../admin/src/office/path.ts";
import { facingToYaw, tileToWorld } from "../admin/src/office/world.ts";
import { animPose, clipFor, clipsForPose, syncCharacters, type ClipName } from "../admin/src/office/anim.ts";
import { buildPlacements, buildSeats, floorBoxes } from "../admin/src/office/layout3d.ts";
import { parseHash } from "../admin/src/lib/route.ts";
import { assignSeats, freeSeat, type Seat } from "../admin/src/office/seats.ts";
import { CHARACTER_CLIPS, CHARACTER_VARIANTS, MODEL_URLS, resolveModelFile, type ModelId } from "../admin/src/office/assets3d.ts";
import { modelsOverBudget, staticClosure, threeInStaticClosure, type Manifest } from "../admin/scripts/check-office-chunks.ts";

const NOW = 1_000_000;
const empty: OfficeState = { characters: new Map(), recent: [] };
const none = new Map<string, string>();
const W = (name: string) => `worker:${name}`;
const C = (id: string) => `client:${id}`;

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

  it("labels an unknown app generically, never by its id", () => {
    const st = applyEvent(empty, ev({ agent: "abcdef123456" }), NOW, none);
    const c = st.characters.get(C("abcdef123456"))!;
    expect(c.label).toBe("New app");
    expect(describeCharacter(c)).not.toContain("abcdef");
    expect(st.recent[0]!.text).not.toContain("abcdef");
  });

  it("records the error window on a failed job end", () => {
    const st = applyEvent(empty, ev({ agent: "cycle", kind: "job", phase: "end", status: "error" }), NOW, none);
    expect(st.characters.get(W("cycle"))?.errorUntil).toBe(NOW + 3000);
  });

  it("restarts startedAt on a repeated job start", () => {
    let st = applyEvent(empty, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW, none);
    st = applyEvent(st, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW + 5, none);
    expect(st.characters.size).toBe(1);
    expect(st.characters.get(W("cycle"))?.startedAt).toBe(NOW + 5);
  });
});

describe("tick", () => {
  it("keeps a long job busy and drops it past the stale cap", () => {
    const st = applyEvent(empty, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW, none);
    expect(tick(st, NOW + 61_000).characters.get(W("cycle"))?.room).toBe("night_shift");
    expect(tick(st, NOW + STALE_JOB_MS + 1).characters.get(W("cycle"))?.room).toBe("break_room");
  });

  it("prunes a client idle in the break room for over 24h", () => {
    let st = applyEvent(empty, ev({ agent: "a" }), NOW, none);
    st = tick(st, NOW + 5_000);
    expect(st.characters.get(C("a"))?.room).toBe("break_room");
    expect(tick(st, NOW + 25 * 3600_000).characters.has(C("a"))).toBe(false);
  });

  it("holds a tool visit for 4s", () => {
    const st = applyEvent(empty, ev({ agent: "a" }), NOW, none);
    expect(tick(st, NOW + 3_999).characters.get(C("a"))?.room).toBe("archive");
    expect(tick(st, NOW + 4_001).characters.get(C("a"))?.room).toBe("break_room");
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
    expect([...st.characters.keys()].sort()).toEqual([C("c1"), W("cycle"), W("worker")]);
    expect(st.characters.get(W("cycle"))?.room).toBe("night_shift");
    expect(st.characters.get(W("cycle"))?.busyUntil).toBe(Infinity);
    expect(st.characters.get(W("worker"))?.room).toBe("break_room");
    expect(st.characters.get(W("worker"))?.enabled).toBe(false);
  });

  it("describes characters from labels and rooms", () => {
    const names = namesFromSnapshot(snap);
    expect(names.get(C("c1"))).toBe("Claude Code");
    const st = applyEvent(initialState(snap, NOW), ev({ agent: "c1" }), NOW, names);
    expect(describeCharacter(st.characters.get(C("c1"))!)).toBe("Claude Code is searching memory");
    expect(describeCharacter(initialState(snap, NOW).characters.get(W("worker"))!)).toBe("Librarian is idle");
  });
});

describe("event rules", () => {
  it("marks a failed tool call", () => {
    const st = applyEvent(empty, ev({ agent: "a", status: "error" }), NOW, none);
    expect(st.characters.get(C("a"))?.errorUntil).toBe(NOW + 3000);
  });

  it("sends a tool call from an app named like a worker to the app, not the worker", () => {
    const st = applyEvent(empty, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW, none);
    const after = applyEvent(st, ev({ agent: "cycle" }), NOW + 10, none);
    expect(after.characters.get(W("cycle"))).toEqual(st.characters.get(W("cycle")));
    expect(after.characters.get(C("cycle"))).toMatchObject({ kind: "client", room: "archive", label: "New app" });
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
    const c = out.characters.get(W("cycle"))!;
    expect(c.startedAt).toBe(NOW + 120_000);
    expect(c.busyUntil).toBe(Infinity);
    expect(c.enabled).toBe(false);
  });

  it("ends a job whose end was lost", () => {
    const st = initialState(snap([{ name: "cycle", enabled: true, running: true }]), NOW);
    const out = applySnapshot(st, snap([{ name: "cycle", enabled: true, running: false }]), NOW + 1000, NOW + 2000);
    expect(out.characters.get(W("cycle"))?.busyUntil).toBe(NOW + 2000);
    expect(tick(out, NOW + 2000).characters.get(W("cycle"))?.room).toBe("break_room");
  });

  it("ignores a running snapshot requested before a job ended", () => {
    const run = ev({ agent: "cycle", kind: "job", phase: "start", status: "running" });
    let st = applyEvent(empty, run, NOW, none);
    st = applyEvent(st, { ...run, phase: "end", status: "success" }, NOW + 2000, none);
    const out = applySnapshot(st, snap([{ name: "cycle", enabled: true, running: true }]), NOW + 1000, NOW + 3000);
    expect(out.characters.get(W("cycle"))?.busyUntil).toBe(NOW + 5000);
    expect(tick(out, NOW + 5000).characters.get(W("cycle"))?.room).toBe("break_room");
  });

  it("leaves a start that arrived after the query", () => {
    const st = applyEvent(empty, ev({ agent: "cycle", kind: "job", phase: "start", status: "running" }), NOW + 500, none);
    const out = applySnapshot(st, snap([{ name: "cycle", enabled: true, running: false }]), NOW, NOW + 1000);
    expect(out.characters.get(W("cycle"))?.busyUntil).toBe(Infinity);
  });

  it("adds new workers and recent clients, and refreshes labels", () => {
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
          { id: "c9", display_name: "Fresh", last_seen: new Date(NOW - 60_000).toISOString() },
          { id: "c8", display_name: "Stale", last_seen: new Date(NOW - 25 * 3600_000).toISOString() },
          { id: "c7", display_name: "Never", last_seen: null },
        ],
      ),
      NOW,
      NOW,
    );
    expect(out.characters.has(W("notifications"))).toBe(true);
    expect(out.characters.get(C("c1"))?.label).toBe("New");
    const fresh = out.characters.get(C("c9"))!;
    expect(fresh).toMatchObject({ kind: "client", label: "Fresh", room: "break_room", busyUntil: 0 });
    expect(out.characters.has(C("c8"))).toBe(false);
    expect(out.characters.has(C("c7"))).toBe(false);
  });

  it("names an app that first showed up through a live event", () => {
    const st = applyEvent(empty, ev({ agent: "c5" }), NOW, none);
    const out = applySnapshot(st, snap([], [{ id: "c5", display_name: "Desk app", last_seen: new Date(NOW).toISOString() }]), NOW, NOW);
    expect(out.characters.get(C("c5"))?.label).toBe("Desk app");
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

describe("assignSeats", () => {
  const person = (id: string, room: RoomId) => ({ id, room });

  it("keeps a seat while the character stays in the room", () => {
    const a = assignSeats(new Map(), [person("a", "archive"), person("b", "archive")]);
    const b = assignSeats(a, [person("b", "archive")]);
    expect(b.get("b")).toEqual(a.get("b"));
  });

  it("reuses a freed seat instead of stacking a newcomer on someone", () => {
    let seats: Map<string, Seat> = new Map();
    const n = OFFICE_MAP.seats.archive.length;
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    seats = assignSeats(seats, ids.map((id) => person(id, "archive")));
    // p1 walks off to write, then a newcomer arrives in the archive.
    const moved = ids.map((id) => person(id, id === "p1" ? "writing" : "archive"));
    seats = assignSeats(seats, [...moved, person("new", "archive")]);
    expect(seats.get("new")).toEqual({ room: "archive", index: 1 });
    const spots = [...seats.values()].filter((s) => s.room === "archive").map((s) => seatFor("archive", s.index));
    expect(new Set(spots.map((t) => `${t.x},${t.y}`)).size).toBe(spots.length);
  });

  it("forgets characters that left the office", () => {
    const a = assignSeats(new Map(), [person("a", "archive"), person("b", "library")]);
    const b = assignSeats(a, [person("b", "library")]);
    expect([...b.keys()]).toEqual(["b"]);
  });

  it("finds the lowest free seat in a room", () => {
    const seats = assignSeats(new Map(), [person("a", "reception"), person("b", "reception")]);
    expect(freeSeat(seats, "reception")).toBe(2);
    expect(freeSeat(assignSeats(seats, [person("b", "reception")]), "reception")).toBe(0);
  });
});

describe("spotFor", () => {
  const floorIn = (room: RoomId) => {
    let n = 0;
    for (let y = 0; y < OFFICE_MAP.height; y++) {
      for (let x = 0; x < OFFICE_MAP.width; x++) if (OFFICE_MAP.walkable(x, y) && roomAt(x, y)?.id === room) n++;
    }
    return n;
  };

  it("uses the room's seats first", () => {
    OFFICE_MAP.seats.archive.forEach((seat, i) => expect(spotFor("archive", i)).toEqual(seat));
  });

  it("stands a 7th archive visitor on a free floor tile inside the archive", () => {
    const seats = OFFICE_MAP.seats.archive.length;
    const extra = spotFor("archive", seats);
    expect(OFFICE_MAP.walkable(extra.x, extra.y)).toBe(true);
    expect(roomAt(extra.x, extra.y)?.id).toBe("archive");
    expect(OFFICE_MAP.seats.archive.some((t) => t.x === extra.x && t.y === extra.y)).toBe(false);
  });

  it("gives every floor tile of a room before it wraps", () => {
    const rooms = Object.keys(OFFICE_MAP.seats) as RoomId[];
    for (const room of rooms) {
      const n = floorIn(room);
      const spots = Array.from({ length: n }, (_, i) => spotFor(room, i));
      for (const t of spots) {
        expect(OFFICE_MAP.walkable(t.x, t.y)).toBe(true);
        expect(roomAt(t.x, t.y)?.id).toBe(room);
      }
      expect(new Set(spots.map((t) => `${t.x},${t.y}`)).size).toBe(n);
      expect(spotFor(room, n)).toEqual(spotFor(room, 0));
    }
  });
});

describe("clients and workers with the same name", () => {
  const recent = new Date(NOW - 60_000).toISOString();
  const snap: OfficeSnapshot = {
    workers: [
      { name: "worker", enabled: true, running: false },
      { name: "cycle", enabled: true, running: false },
    ],
    clients: [
      { id: "worker", display_name: "worker", last_seen: recent },
      { id: "cycle", display_name: "cycle", last_seen: recent },
    ],
  };

  it("keeps a PAT named worker and the Librarian as two figures", () => {
    const st = initialState(snap, NOW);
    expect(st.characters.get(W("worker"))).toMatchObject({ kind: "worker", label: "Librarian", agent: "worker" });
    expect(st.characters.get(C("worker"))).toMatchObject({ kind: "client", label: "worker", agent: "worker" });
    const names = namesFromSnapshot(snap);
    expect(names.get(W("worker"))).toBe("Librarian");
    expect(names.get(C("worker"))).toBe("worker");
  });

  it("moves each one only on its own events", () => {
    const names = namesFromSnapshot(snap);
    let st = applyEvent(initialState(snap, NOW), ev({ agent: "worker" }), NOW, names);
    expect(st.characters.get(C("worker"))?.room).toBe("archive");
    expect(st.characters.get(W("worker"))?.room).toBe("break_room");
    st = applyEvent(st, ev({ agent: "worker", kind: "job", phase: "start", status: "running" }), NOW + 1, names);
    expect(st.characters.get(W("worker"))?.room).toBe("library");
    expect(st.characters.get(C("worker"))?.room).toBe("archive");
  });

  it("moves the app when a PAT named cycle calls a tool, not the Night shift", () => {
    const names = namesFromSnapshot(snap);
    const before = initialState(snap, NOW);
    const st = applyEvent(before, ev({ agent: "cycle", operation: "page_put" }), NOW, names);
    expect(st.characters.get(C("cycle"))).toMatchObject({ room: "writing", label: "cycle" });
    expect(st.characters.get(W("cycle"))).toEqual(before.characters.get(W("cycle")));
    expect(st.characters.get(W("cycle"))?.label).toBe("Night shift");
  });

  it("never gives an unnamed app a worker's label", () => {
    const st = applyEvent(empty, ev({ agent: "cycle" }), NOW, none);
    expect(st.characters.get(C("cycle"))?.label).toBe("New app");
  });
});

describe("overlapping jobs of one worker", () => {
  const start = ev({ agent: "worker", kind: "job", phase: "start", status: "running", operation: "page_mirror" });
  const end = { ...start, phase: "end" as const, status: "success" };

  it("stays busy while another job still runs", () => {
    let st = applyEvent(empty, start, NOW, none);
    st = applyEvent(st, start, NOW + 10, none);
    st = applyEvent(st, end, NOW + 20, none);
    const later = tick(st, NOW + 60_000);
    expect(later.characters.get(W("worker"))?.room).toBe("library");
  });

  it("goes idle after the hold once the last job ends", () => {
    let st = applyEvent(empty, start, NOW, none);
    st = applyEvent(st, start, NOW + 10, none);
    st = applyEvent(st, end, NOW + 20, none);
    st = applyEvent(st, end, NOW + 30, none);
    expect(tick(st, NOW + 30 + 2_999).characters.get(W("worker"))?.room).toBe("library");
    expect(tick(st, NOW + 30 + 3_001).characters.get(W("worker"))?.room).toBe("break_room");
  });

  it("shows a failed end even while another job runs", () => {
    let st = applyEvent(empty, start, NOW, none);
    st = applyEvent(st, start, NOW + 10, none);
    st = applyEvent(st, { ...end, status: "error" }, NOW + 20, none);
    const w = st.characters.get(W("worker"))!;
    expect(w.errorUntil).toBe(NOW + 20 + 3000);
    expect(tick(st, NOW + 60_000).characters.get(W("worker"))?.room).toBe("library");
  });

  it("forgets a stuck count when a later snapshot finds nothing running", () => {
    let st = applyEvent(empty, start, NOW, none);
    st = applyEvent(st, start, NOW + 10, none);
    st = applySnapshot(st, { workers: [{ name: "worker", enabled: true, running: false }], clients: [] }, NOW + 1000, NOW + 2000);
    expect(st.characters.get(W("worker"))?.inFlight).toBe(0);
    st = tick(st, NOW + 2000);
    st = applyEvent(st, start, NOW + 3000, none);
    st = applyEvent(st, end, NOW + 4000, none);
    expect(tick(st, NOW + 4000 + 3_001).characters.get(W("worker"))?.room).toBe("break_room");
  });

  it("forgets a stuck count at the stale cap", () => {
    let st = applyEvent(empty, start, NOW, none);
    st = applyEvent(st, start, NOW + 10, none);
    const at = NOW + 10 + STALE_JOB_MS + 1;
    st = tick(st, at);
    expect(st.characters.get(W("worker"))).toMatchObject({ room: "break_room", inFlight: 0 });
    st = applyEvent(st, start, at + 1000, none);
    st = applyEvent(st, end, at + 2000, none);
    expect(tick(st, at + 2000 + 3_001).characters.get(W("worker"))?.room).toBe("break_room");
  });
});

describe("lineFor", () => {
  const snap: OfficeSnapshot = {
    workers: [{ name: "cycle", enabled: false, running: false }],
    clients: [{ id: "c1", display_name: "Laptop", last_seen: new Date(NOW).toISOString() }],
  };

  it("says an idle switched-off worker is off", () => {
    expect(lineFor(initialState(snap, NOW).characters.get(W("cycle"))!)).toBe("Night shift is off");
  });

  it("says what a switched-off worker is doing while it still works", () => {
    const st = applyEvent(initialState(snap, NOW), ev({ agent: "cycle", kind: "job", phase: "start", status: "running", operation: "cycle" }), NOW, none);
    expect(lineFor(st.characters.get(W("cycle"))!)).toBe("Night shift is running the nightly cycle");
  });

  it("describes apps and running workers as usual", () => {
    expect(lineFor(initialState(snap, NOW).characters.get(C("c1"))!)).toBe("Laptop is idle");
  });
});

describe("3D office assets", () => {
  const ids: ModelId[] = ["desk", "chair", "shelf", "cabinet", "plant", "sofa", "coffee_machine", "counter", "whiteboard", "board", "lamp", "rug", "monitor", "character"];

  it("has a model file for every model id", () => {
    for (const id of ids) expect(MODEL_URLS[id]).toMatch(/\.(glb|gltf)$/);
  });

  it("offers at least six distinct people", () => {
    expect(new Set(CHARACTER_VARIANTS).size).toBe(CHARACTER_VARIANTS.length);
    expect(CHARACTER_VARIANTS.length).toBeGreaterThanOrEqual(6);
    for (const url of CHARACTER_VARIANTS) expect(url).toMatch(/\.gltf$/);
  });

  it("never points at an inline data URL", () => {
    for (const url of [...Object.values(MODEL_URLS), ...CHARACTER_VARIANTS]) expect(url).not.toContain("data:");
  });

  it("maps the side files a model names to their built URLs", () => {
    expect(resolveModelFile("/admin/assets/colormap.png")).toMatch(/colormap.*\.png$/);
    expect(resolveModelFile("/admin/assets/colormap.png")).not.toBe("/admin/assets/colormap.png");
    expect(resolveModelFile("/admin/assets/other-Ab12.png")).toBe("/admin/assets/other-Ab12.png");
  });

  it("maps every person's buffer file", () => {
    for (const person of ["male-a", "male-b", "male-d", "female-b", "female-d", "female-f"]) {
      const asked = `/admin/assets/character-${person}.bin`;
      expect(resolveModelFile(asked)).not.toBe(asked);
      expect(resolveModelFile(asked)).toMatch(new RegExp(`character-${person}.*\\.bin$`));
    }
  });
});

describe("office chunk check", () => {
  const office = { file: "assets/Office-1.js", src: "src/pages/Office.tsx", isDynamicEntry: true, imports: ["_three-1.js"] };
  const three = { file: "assets/three-1.js", name: "three" };

  it("lets three load through a dynamic import", () => {
    const manifest: Manifest = {
      "index.html": { file: "assets/index-1.js", isEntry: true, imports: ["_vendor-1.js"], dynamicImports: ["src/pages/Office.tsx"] },
      "_vendor-1.js": { file: "assets/vendor-1.js" },
      "src/pages/Office.tsx": office,
      "_three-1.js": three,
    };
    expect([...staticClosure(manifest, "index.html")].sort()).toEqual(["_vendor-1.js", "index.html"]);
    expect(threeInStaticClosure(manifest, "index.html")).toBe(false);
  });

  it("catches three pulled statically two imports deep", () => {
    const manifest: Manifest = {
      "index.html": { file: "assets/index-1.js", isEntry: true, imports: ["_a-1.js"] },
      "_a-1.js": { file: "assets/a-1.js", imports: ["_b-1.js"] },
      "_b-1.js": { file: "assets/b-1.js", imports: ["_three-1.js"] },
      "_three-1.js": three,
    };
    expect(staticClosure(manifest, "index.html").has("_three-1.js")).toBe(true);
    expect(threeInStaticClosure(manifest, "index.html")).toBe(true);
  });

  it("knows three by its source path as well as its chunk name", () => {
    const manifest: Manifest = {
      "index.html": { file: "assets/index-1.js", isEntry: true, imports: ["node_modules/three/build/three.module.js"] },
      "node_modules/three/build/three.module.js": { file: "assets/three.module-1.js", src: "node_modules/three/build/three.module.js" },
    };
    expect(threeInStaticClosure(manifest, "index.html")).toBe(true);
  });

  it("holds the models to 1,500,000 bytes", () => {
    expect(modelsOverBudget(1_500_000)).toBe(false);
    expect(modelsOverBudget(1_500_001)).toBe(true);
  });
});

describe("3D world mapping", () => {
  const home = OFFICE_MAP.seats.break_room[0]!;
  const reachable = (t: { x: number; y: number }) =>
    OFFICE_MAP.walkable(t.x, t.y) &&
    (findPath(home, t, OFFICE_MAP.walkable, OFFICE_MAP.width, OFFICE_MAP.height).length > 0 ||
      (t.x === home.x && t.y === home.y));

  it("gives every prop a known model kind", () => {
    const known = new Set(Object.keys(MODEL_URLS));
    for (const p of [...PROPS, ...WALL_DECOR]) expect(p.kind === null || known.has(p.kind)).toBe(true);
  });

  it("keeps every ambient spot walkable and reachable", () => {
    for (const tiles of Object.values(AMBIENT_SPOTS)) for (const t of tiles) expect(reachable(t)).toBe(true);
    expect(AMBIENT_SPOTS.sofa.length).toBeGreaterThanOrEqual(4);
    for (const k of ["coffee", "whiteboard", "water_plants"] as const) {
      expect(AMBIENT_SPOTS[k].length).toBeGreaterThanOrEqual(2);
    }
  });

  it("pairs chat spots on adjacent walkable tiles", () => {
    expect(CHAT_SPOTS.length).toBeGreaterThanOrEqual(4);
    for (const [a, b] of CHAT_SPOTS) {
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1);
      expect(reachable(a)).toBe(true);
      expect(reachable(b)).toBe(true);
    }
  });

  it("puts every ambient spot beside a prop of its own kind", () => {
    const wanted = { coffee: "coffee_machine", whiteboard: "whiteboard", water_plants: "plant", sofa: "sofa" } as const;
    for (const [k, tiles] of Object.entries(AMBIENT_SPOTS) as [keyof typeof wanted, readonly { x: number; y: number }[]][]) {
      for (const t of tiles) {
        const beside = [...PROPS, ...WALL_DECOR].some(
          (p) => p.kind === wanted[k] && Math.abs(p.x - t.x) + Math.abs(p.y - t.y) === 1,
        );
        expect(beside).toBe(true);
      }
    }
  });

  it("leaves the piano without a 3D model", () => {
    expect(PROPS.filter((p) => p.cell[0] >= 23 && p.cell[1] === 8).every((p) => p.kind === null)).toBe(true);
  });

  it("keeps ambient and chat tiles off every seat", () => {
    const seats = new Set<string>();
    for (const room of Object.keys(OFFICE_MAP.seats) as RoomId[]) {
      for (let i = 0; i < OFFICE_MAP.seats[room].length; i++) {
        const t = seatFor(room, i);
        seats.add(`${t.x},${t.y}`);
      }
    }
    const tiles = [...Object.values(AMBIENT_SPOTS).flat(), ...CHAT_SPOTS.flat()];
    for (const t of tiles) expect(seats.has(`${t.x},${t.y}`)).toBe(false);
  });

  it("centres the scene on the origin", () => {
    const mid = tileToWorld({ x: OFFICE_MAP.width / 2 - 0.5, y: OFFICE_MAP.height / 2 - 0.5 });
    expect(mid.x).toBeCloseTo(0);
    expect(mid.z).toBeCloseTo(0);
    const c = tileToWorld({ x: 0, y: 0 });
    expect(c.x).toBeCloseTo(-OFFICE_MAP.width / 2 + 0.5);
    expect(c.z).toBeCloseTo(-OFFICE_MAP.height / 2 + 0.5);
  });

  it("turns the four facings into distinct yaws", () => {
    const yaws = (["up", "down", "left", "right"] as const).map(facingToYaw);
    expect(new Set(yaws).size).toBe(4);
  });
});

describe("ambient life", () => {
  const seeded = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const person = (id: string, over: Partial<Character> = {}): Character => ({
    id: `client:${id}`, agent: id, label: id, kind: "client", enabled: true, room: "break_room",
    activity: null, busyUntil: 0, startedAt: null, endedAt: null, errorUntil: 0, arrivedAt: 0, lastSeen: 0, inFlight: 0, ...over,
  });
  const stateOf = (cs: Character[]): OfficeState => ({ characters: new Map(cs.map((c) => [c.id, c])), recent: [] });
  const crowd = (n: number) => Array.from({ length: n }, (_, i) => person(`p${i}`));
  const opts = { reducedMotion: false };

  it("gives activities only to idle, enabled characters in the break room", () => {
    const st = stateOf([
      person("a"),
      person("off", { kind: "worker", id: "worker:off", enabled: false }),
      person("busy", { busyUntil: 99_999, room: "writing" }),
      person("busyhere", { busyUntil: 99_999 }),
    ]);
    const amb = planAmbient(st, emptyAmbient(), 1000, seeded(1), opts);
    expect([...amb.activities.keys()]).toEqual(["client:a"]);
  });

  it("drops an activity the same tick a character turns busy", () => {
    const idle = stateOf(crowd(3));
    const amb = planAmbient(idle, emptyAmbient(), 1000, seeded(2), opts);
    expect(amb.activities.size).toBeGreaterThan(0);
    const id = [...amb.activities.keys()][0]!;
    const c = { ...idle.characters.get(id)!, busyUntil: 5000 };
    const busy = stateOf([...idle.characters.values()].map((x) => (x.id === id ? c : x)));
    expect(planAmbient(busy, amb, 1100, seeded(3), opts).activities.has(id)).toBe(false);
    const t = targetFor(c, amb, { x: 1, y: 1 }, 1100);
    expect(t.pose).toBe("work");
    expect(t.tile).toEqual({ x: 1, y: 1 });
  });

  it("pairs two distinct characters for a chat, facing each other", () => {
    for (let seed = 1; seed < 60; seed++) {
      const amb = planAmbient(stateOf(crowd(6)), emptyAmbient(), 0, seeded(seed), opts);
      for (const [id, a] of amb.activities) {
        if (a.kind !== "chat") continue;
        const b = amb.activities.get(a.partner!)!;
        expect(a.partner).not.toBe(id);
        expect(b.partner).toBe(id);
        expect(b.until).toBe(a.until);
        const opposite = { left: "right", right: "left", up: "down", down: "up" } as const;
        expect(b.facing).toBe(opposite[a.facing!]);
      }
    }
  });

  it("never plans a chat for one idle character", () => {
    for (let seed = 1; seed < 80; seed++) {
      const amb = planAmbient(stateOf(crowd(1)), emptyAmbient(), 0, seeded(seed), opts);
      for (const a of amb.activities.values()) expect(a.kind).not.toBe("chat");
    }
  });

  it("never shares a target tile and never targets a seat", () => {
    const seats = new Set(Object.values(OFFICE_MAP.seats).flat().map((t) => `${t.x},${t.y}`));
    for (let seed = 1; seed < 40; seed++) {
      const amb = planAmbient(stateOf(crowd(12)), emptyAmbient(), 0, seeded(seed), opts);
      const tiles = [...amb.activities.values()].map((a) => `${a.target.x},${a.target.y}`);
      expect(new Set(tiles).size).toBe(tiles.length);
      for (const t of tiles) expect(seats.has(t)).toBe(false);
    }
  });

  it("changes each character's activity at most once per call after a long gap", () => {
    const st = stateOf(crowd(5));
    const first = planAmbient(st, emptyAmbient(), 0, seeded(4), opts);
    const later = planAmbient(st, first, 600_000, seeded(5), opts);
    for (const [id, a] of later.activities) {
      const was = first.activities.get(id);
      expect(a.until).toBeGreaterThan(600_000);
      expect(was === undefined || was.until <= 600_000).toBe(true);
    }
  });

  it("is empty under reduced motion", () => {
    const amb = planAmbient(stateOf(crowd(4)), emptyAmbient(), 0, seeded(6), { reducedMotion: true });
    expect(amb.activities.size).toBe(0);
  });

  it("is deterministic for a seed", () => {
    const a = planAmbient(stateOf(crowd(8)), emptyAmbient(), 0, seeded(7), opts);
    const b = planAmbient(stateOf(crowd(8)), emptyAmbient(), 0, seeded(7), opts);
    expect([...a.activities]).toEqual([...b.activities]);
  });

  it("targetFor sits in the break room and idles elsewhere", () => {
    const seat = { x: 3, y: 3 };
    expect(targetFor(person("a"), emptyAmbient(), seat, 0).pose).toBe("sit");
    expect(targetFor(person("a", { room: "writing" }), emptyAmbient(), seat, 0).pose).toBe("idle");
  });

  it("faces the matching prop from every ambient spot", () => {
    const want = { coffee: "coffee_machine", whiteboard: "whiteboard", water_plants: "plant", sofa: "sofa" } as const;
    const dir = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] } as const;
    for (const [kind, spots] of Object.entries(AMBIENT_SPOTS) as [keyof typeof want, { x: number; y: number }[]][]) {
      for (const t of spots) {
        const f = facingProp(kind, t);
        expect(f).toBeDefined();
        const [dx, dy] = dir[f!];
        const hit = [...PROPS, ...WALL_DECOR].some((p) => p.kind === want[kind] && p.x === t.x + dx && p.y === t.y + dy);
        expect(hit).toBe(true);
      }
    }
  });
});

describe("3D animation helpers", () => {
  const kinds = ["walk", "idle", "sit", "work", "wander", "coffee", "chat", "whiteboard", "water_plants", "sofa"] as const;

  it("keeps the hand-made sway small and deterministic", () => {
    for (const k of kinds) {
      for (const t of [0, 0.25, 0.5, 1, 10]) {
        const p = animPose(k, t);
        expect(Object.keys(p).sort()).toEqual(["bob", "lean"]);
        expect(Math.abs(p.bob)).toBeLessThanOrEqual(0.05);
        expect(Math.abs(p.lean)).toBeLessThanOrEqual(0.35);
        expect(animPose(k, t)).toEqual(p);
      }
    }
    expect(animPose("water_plants", 1).lean).toBeGreaterThan(0.15);
  });

  it("maps every pose to a clip the people carry", () => {
    const carried = new Set<string>(CHARACTER_CLIPS);
    for (const k of kinds) {
      for (const moving of [false, true]) {
        for (const seated of [false, true]) {
          for (const ms of [0, 1000, 3000, 6000]) {
            const clip = clipFor(k, moving, seated, ms, 0.4);
            if (clip === "type") expect(k === "work" && seated && !moving).toBe(true);
            else expect(carried.has(clip)).toBe(true);
          }
        }
      }
    }
    expect(clipFor("idle", true, true, 0, 0)).toBe("walk");
    expect(clipFor("work", false, true, 0, 0)).toBe("type");
    expect(clipFor("sofa", false, true, 0, 0)).toBe("sit");
    expect(clipFor("whiteboard", false, false, 0, 0)).toBe("interact-right");
    expect(clipFor("coffee", false, false, 500, 0)).toBe("interact-right");
    expect(clipFor("coffee", false, false, 9000, 0)).toBe("idle");
    const chat = new Set([0, 700, 1500, 2600, 4000].map((ms) => clipFor("chat", false, false, ms, 0)));
    expect(chat).toEqual(new Set(["emote-yes", "idle"]));
  });

  it("plays idle when a model lacks any clip a pose needs", () => {
    const all = new Set<string>(CHARACTER_CLIPS);
    const without = (name: string) => new Set([...all].filter((c) => c !== name));
    const names: ClipName[] = ["idle", "walk", "sit", "interact-right", "pick-up", "emote-yes", "type"];
    for (const n of names) expect(clipsForPose(n, all)).not.toEqual(n === "idle" ? [] : ["idle"]);
    expect(clipsForPose("type", all)).toEqual(["sit", "interact-right"]);
    expect(clipsForPose("type", without("sit"))).toEqual(["idle"]);
    expect(clipsForPose("type", without("interact-right"))).toEqual(["idle"]);
    expect(clipsForPose("walk", all)).toEqual(["walk"]);
    expect(clipsForPose("walk", without("walk"))).toEqual(["idle"]);
    expect(clipsForPose("idle", all)).toEqual(["idle"]);
  });

  it("ships every clip in every person's model", () => {
    const dir = join(import.meta.dir, "../admin/src/assets/office3d");
    for (const url of CHARACTER_VARIANTS) {
      const gltf = JSON.parse(readFileSync(join(dir, basename(url)), "utf8")) as { animations: { name: string }[] };
      const names = new Set(gltf.animations.map((a) => a.name));
      for (const clip of CHARACTER_CLIPS) expect(names.has(clip)).toBe(true);
    }
  });

  it("diffs the people on screen against the wanted ones", () => {
    const set = (...ids: string[]) => new Set(ids);
    expect(syncCharacters(set(), set("a", "b"))).toEqual({ add: ["a", "b"], remove: [] });
    expect(syncCharacters(set("a", "b"), set())).toEqual({ add: [], remove: ["a", "b"] });
    expect(syncCharacters(set("a", "b"), set("b", "c"))).toEqual({ add: ["c"], remove: ["a"] });
    expect(syncCharacters(set("a", "b"), set("a", "b"))).toEqual({ add: [], remove: [] });
  });
});

describe("3D office layout", () => {
  const { seats, sofaSpots, chairs } = buildSeats();

  it("seats everyone on the sofa from every sofa spot", () => {
    for (const t of AMBIENT_SPOTS.sofa) {
      const seat = sofaSpots.get(`${t.x},${t.y}`);
      expect(seat).toBeDefined();
      const sofa = tileToWorld({ x: t.x + Math.sign(seat!.x - tileToWorld(t).x), y: t.y + Math.sign(seat!.z - tileToWorld(t).z) });
      expect(PROPS.some((p) => p.kind === "sofa" && tileToWorld(p).x === sofa.x && tileToWorld(p).z === sofa.z)).toBe(true);
    }
  });

  it("puts a chair at every seat beside a desk, facing it, with a seat to sit on", () => {
    const step = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as const;
    for (const c of chairs) {
      expect(seats.has(`${c.tile.x},${c.tile.y}`)).toBe(true);
      const [dx, dy] = step[c.facing];
      const ahead = PROPS.find((p) => p.x === c.tile.x + dx && p.y === c.tile.y + dy);
      if (ahead) expect(ahead.kind === "desk" || ahead.kind === "counter").toBe(true);
    }
    for (const t of Object.values(OFFICE_MAP.seats).flat()) {
      const besideDesk = PROPS.some((p) => p.kind === "desk" && Math.abs(p.x - t.x) + Math.abs(p.y - t.y) === 1);
      if (besideDesk) expect(chairs.some((c) => c.tile.x === t.x && c.tile.y === t.y)).toBe(true);
    }
  });

  it("covers the floor inside the outer walls and places every model kind it loads", () => {
    const quarters = floorBoxes();
    expect(quarters.length).toBe((OFFICE_MAP.width * 2 - 2) * (OFFICE_MAP.height * 2 - 2));
    const placed = buildPlacements(() => ({ x: 1, y: 1, z: 1 }), chairs);
    for (const k of ["desk", "chair", "monitor", "sofa", "whiteboard", "coffee_machine", "rug"]) {
      expect(placed.some((p) => p.kind === k)).toBe(true);
    }
  });
});
