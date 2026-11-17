import type { FeedEvent, OfficeSnapshot } from "../admin-types.ts";
import { ROOM_PHRASE, WORKER_LABEL, roomFor, type RoomId } from "./rooms.ts";

export type CharacterKind = "client" | "worker";

export interface Character {
  // Keyed by kind as well, so an app named like a worker never stands in for it.
  id: string;
  agent: string;
  label: string;
  kind: CharacterKind;
  enabled: boolean;
  room: RoomId;
  activity: string | null;
  busyUntil: number;
  startedAt: number | null;
  endedAt: number | null;
  errorUntil: number;
  arrivedAt: number;
  lastSeen: number;
  // Jobs of this worker started and not yet ended; one figure stands for all of them.
  inFlight: number;
}

export interface OfficeState {
  characters: Map<string, Character>;
  recent: { at: number; text: string }[];
}

const TOOL_HOLD_MS = 4000;
const JOB_LINGER_MS = 3000;
export const STALE_JOB_MS = 15 * 60_000;
const CLIENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_CAP = 20;
const IGNORED_AGENTS = new Set(["admin-panel"]);
const NEW_APP_LABEL = "New app";

export function characterKey(kind: CharacterKind, agent: string): string {
  return `${kind}:${agent}`;
}

// Tool calls come from apps, job events from workers.
export function eventKey(e: FeedEvent): string {
  return characterKey(e.kind === "job" ? "worker" : "client", e.agent);
}

export function namesFromSnapshot(s: OfficeSnapshot): Map<string, string> {
  const names = new Map<string, string>();
  for (const [name, label] of Object.entries(WORKER_LABEL)) names.set(characterKey("worker", name), label);
  for (const w of s.workers) {
    const key = characterKey("worker", w.name);
    if (!names.has(key)) names.set(key, w.name);
  }
  for (const c of s.clients) names.set(characterKey("client", c.id), c.display_name);
  return names;
}

function workerCharacter(w: OfficeSnapshot["workers"][number], now: number): Character {
  return {
    id: characterKey("worker", w.name),
    agent: w.name,
    label: WORKER_LABEL[w.name] ?? w.name,
    kind: "worker",
    enabled: w.enabled,
    room: w.running ? roomFor({ kind: "job", agent: w.name, operation: "other" }) : "break_room",
    activity: null,
    busyUntil: w.running ? Infinity : 0,
    startedAt: w.running ? now : null,
    endedAt: null,
    errorUntil: 0,
    arrivedAt: now,
    lastSeen: now,
    inFlight: w.running ? 1 : 0,
  };
}

// Only apps seen in the last day get a figure; older or never-used ones stay out.
function clientCharacter(c: OfficeSnapshot["clients"][number], now: number): Character | null {
  const seen = c.last_seen ? Date.parse(c.last_seen) : NaN;
  if (!Number.isFinite(seen) || now - seen > CLIENT_WINDOW_MS) return null;
  return {
    id: characterKey("client", c.id),
    agent: c.id,
    label: c.display_name,
    kind: "client",
    enabled: true,
    room: "break_room",
    activity: null,
    busyUntil: 0,
    startedAt: null,
    endedAt: null,
    errorUntil: 0,
    arrivedAt: now,
    lastSeen: seen,
    inFlight: 0,
  };
}

export function initialState(s: OfficeSnapshot, now: number): OfficeState {
  const characters = new Map<string, Character>();
  for (const w of s.workers) {
    const worker = workerCharacter(w, now);
    characters.set(worker.id, worker);
  }
  for (const c of s.clients) {
    const client = clientCharacter(c, now);
    if (client) characters.set(client.id, client);
  }
  return { characters, recent: [] };
}

export function applySnapshot(
  st: OfficeState,
  s: OfficeSnapshot,
  requestedAt: number,
  now: number,
): OfficeState {
  const characters = new Map(st.characters);
  for (const w of s.workers) {
    const key = characterKey("worker", w.name);
    const c = characters.get(key);
    if (!c) {
      characters.set(key, workerCharacter(w, now));
    } else if (w.running) {
      if (c.endedAt !== null && c.endedAt >= requestedAt) {
        characters.set(key, { ...c, enabled: w.enabled });
        continue;
      }
      characters.set(key, {
        ...c,
        enabled: w.enabled,
        room: roomFor({ kind: "job", agent: w.name, operation: "other" }),
        busyUntil: Infinity,
        startedAt: now,
        lastSeen: now,
        inFlight: Math.max(c.inFlight, 1),
      });
    } else {
      // Nothing runs, yet every start we saw came before the query: their ends were lost.
      const lostEnd = c.busyUntil === Infinity && c.startedAt !== null && c.startedAt < requestedAt;
      characters.set(key, {
        ...c,
        enabled: w.enabled,
        busyUntil: lostEnd ? now : c.busyUntil,
        inFlight: lostEnd ? 0 : c.inFlight,
      });
    }
  }
  // Also picks up apps whose live events this page missed.
  for (const cl of s.clients) {
    const key = characterKey("client", cl.id);
    const c = characters.get(key);
    if (c) {
      characters.set(key, { ...c, label: cl.display_name });
    } else {
      const client = clientCharacter(cl, now);
      if (client) characters.set(key, client);
    }
  }
  return { characters, recent: st.recent };
}

export function describe(c: Character): string {
  return `${c.label} is ${ROOM_PHRASE[c.room]}`;
}

// A switched-off worker can still be finishing a job; say so rather than "off".
export function lineFor(c: Character): string {
  return c.kind === "worker" && !c.enabled && c.room === "break_room" ? `${c.label} is off` : describe(c);
}

export function applyEvent(
  st: OfficeState,
  e: FeedEvent,
  now: number,
  names: Map<string, string>,
): OfficeState {
  if (IGNORED_AGENTS.has(e.agent)) return st;
  const isJob = e.kind === "job";
  const key = eventKey(e);
  const room = roomFor({ kind: isJob ? "job" : "tool", agent: e.agent, operation: e.operation });
  const prev = st.characters.get(key);
  const base: Character = prev ?? {
    id: key,
    agent: e.agent,
    // Until the snapshot names a new app, never show any part of its id.
    label: names.get(key) ?? (isJob ? WORKER_LABEL[e.agent] ?? e.agent : NEW_APP_LABEL),
    kind: isJob ? "worker" : "client",
    enabled: true,
    room: "reception",
    activity: null,
    busyUntil: 0,
    startedAt: null,
    endedAt: null,
    errorUntil: 0,
    arrivedAt: now,
    lastSeen: now,
    inFlight: 0,
  };

  let next: Character;
  if (!isJob) {
    next = {
      ...base,
      room,
      activity: e.operation,
      busyUntil: Math.max(base.busyUntil, now + TOOL_HOLD_MS),
      errorUntil: e.status === "error" ? now + JOB_LINGER_MS : base.errorUntil,
    };
  } else if (e.phase === "end") {
    const errorUntil = e.status === "error" ? now + JOB_LINGER_MS : base.errorUntil;
    const inFlight = Math.max(0, base.inFlight - 1);
    next = inFlight > 0
      ? { ...base, inFlight, endedAt: now, errorUntil }
      : {
          ...base,
          room,
          activity: e.operation,
          busyUntil: now + JOB_LINGER_MS,
          startedAt: null,
          endedAt: now,
          errorUntil,
          inFlight,
        };
  } else {
    next = {
      ...base,
      room,
      activity: e.operation,
      busyUntil: Infinity,
      startedAt: now,
      endedAt: null,
      inFlight: base.inFlight + 1,
    };
  }

  const characters = new Map(st.characters);
  characters.set(key, { ...next, lastSeen: now });
  const recent = [{ at: now, text: describe(next) }, ...st.recent].slice(0, RECENT_CAP);
  return { characters, recent };
}

export function tick(st: OfficeState, now: number): OfficeState {
  let changed = false;
  const characters = new Map<string, Character>();
  for (const [id, c] of st.characters) {
    const stale = c.startedAt !== null && now - c.startedAt > STALE_JOB_MS;
    if (c.room !== "break_room" && (c.busyUntil <= now || stale)) {
      changed = true;
      characters.set(id, { ...c, room: "break_room", activity: null, startedAt: null, busyUntil: 0, inFlight: 0 });
    } else if (c.kind === "client" && c.room === "break_room" && now - c.lastSeen > CLIENT_WINDOW_MS) {
      changed = true;
    } else {
      characters.set(id, c);
    }
  }
  return changed ? { characters, recent: st.recent } : st;
}

// The name floating over a figure; a busy one also says what kind of work it does.
export function labelFor(c: Character): string {
  return c.room === "break_room" ? c.label : `${c.label} · ${ROOM_PHRASE[c.room]}`;
}

// How many people models the 3D office ships with.
const LOOKS = 6;

// A figure keeps the same look for as long as its id stays the same.
export function variantFor(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return (h >>> 0) % LOOKS;
}
