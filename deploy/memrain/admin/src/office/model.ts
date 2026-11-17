import type { FeedEvent, OfficeSnapshot } from "../admin-types.ts";
import { ROOM_PHRASE, WORKER_LABEL, roomFor, type RoomId } from "./rooms.ts";

export interface Character {
  id: string;
  label: string;
  kind: "client" | "worker";
  enabled: boolean;
  room: RoomId;
  activity: string | null;
  busyUntil: number;
  startedAt: number | null;
  errorUntil: number;
  arrivedAt: number;
}

export interface OfficeState {
  characters: Map<string, Character>;
  recent: { at: number; text: string }[];
}

const TOOL_HOLD_MS = 4000;
const JOB_LINGER_MS = 3000;
const JOB_MAX_MS = 60_000;
const CLIENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_CAP = 20;
const IGNORED_AGENTS = new Set(["admin-panel"]);

export function namesFromSnapshot(s: OfficeSnapshot): Map<string, string> {
  const names = new Map<string, string>();
  for (const [name, label] of Object.entries(WORKER_LABEL)) names.set(name, label);
  for (const w of s.workers) if (!names.has(w.name)) names.set(w.name, w.name);
  for (const c of s.clients) names.set(c.id, c.display_name);
  return names;
}

export function initialState(s: OfficeSnapshot, now: number): OfficeState {
  const characters = new Map<string, Character>();
  for (const w of s.workers) {
    const room = w.running ? roomFor({ kind: "job", agent: w.name, operation: "other" }) : "break_room";
    characters.set(w.name, {
      id: w.name,
      label: WORKER_LABEL[w.name] ?? w.name,
      kind: "worker",
      enabled: w.enabled,
      room,
      activity: null,
      busyUntil: w.running ? Infinity : 0,
      startedAt: w.running ? now : null,
      errorUntil: 0,
      arrivedAt: now,
    });
  }
  for (const c of s.clients) {
    const seen = c.last_seen ? Date.parse(c.last_seen) : NaN;
    if (!Number.isFinite(seen) || now - seen > CLIENT_WINDOW_MS) continue;
    characters.set(c.id, {
      id: c.id,
      label: c.display_name,
      kind: "client",
      enabled: true,
      room: "break_room",
      activity: null,
      busyUntil: 0,
      startedAt: null,
      errorUntil: 0,
      arrivedAt: now,
    });
  }
  return { characters, recent: [] };
}

export function describe(c: Character): string {
  return `${c.label} is ${ROOM_PHRASE[c.room]}`;
}

export function applyEvent(
  st: OfficeState,
  e: FeedEvent,
  now: number,
  names: Map<string, string>,
): OfficeState {
  if (IGNORED_AGENTS.has(e.agent)) return st;
  const isJob = e.kind === "job";
  const room = roomFor({ kind: isJob ? "job" : "tool", agent: e.agent, operation: e.operation });
  const prev = st.characters.get(e.agent);
  const base: Character = prev ?? {
    id: e.agent,
    label: names.get(e.agent) ?? WORKER_LABEL[e.agent] ?? e.agent.slice(0, 8),
    kind: isJob ? "worker" : "client",
    enabled: true,
    room: "reception",
    activity: null,
    busyUntil: 0,
    startedAt: null,
    errorUntil: 0,
    arrivedAt: now,
  };

  let next: Character;
  if (!isJob) {
    next = {
      ...base,
      room,
      activity: e.operation,
      busyUntil: Math.max(base.busyUntil, now + TOOL_HOLD_MS),
    };
  } else if (e.phase === "end") {
    const failed = e.status === "error";
    next = {
      ...base,
      room,
      activity: e.operation,
      busyUntil: now + JOB_LINGER_MS,
      startedAt: null,
      errorUntil: failed ? now + JOB_LINGER_MS : base.errorUntil,
    };
  } else {
    next = { ...base, room, activity: e.operation, busyUntil: Infinity, startedAt: base.startedAt ?? now };
  }

  const characters = new Map(st.characters);
  characters.set(e.agent, next);
  const recent = [{ at: now, text: describe(next) }, ...st.recent].slice(0, RECENT_CAP);
  return { characters, recent };
}

export function tick(st: OfficeState, now: number): OfficeState {
  let changed = false;
  const characters = new Map<string, Character>();
  for (const [id, c] of st.characters) {
    const stale = c.startedAt !== null && now - c.startedAt > JOB_MAX_MS;
    if (c.room !== "break_room" && (c.busyUntil <= now || stale)) {
      changed = true;
      characters.set(id, { ...c, room: "break_room", activity: null, startedAt: null, busyUntil: 0 });
    } else {
      characters.set(id, c);
    }
  }
  return changed ? { characters, recent: st.recent } : st;
}
