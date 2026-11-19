import type { RoomId } from "./rooms.ts";

export interface Seat {
  room: RoomId;
  index: number;
}

function lowestFree(used: Set<number>): number {
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

function usedIn(seats: ReadonlyMap<string, Seat>, room: RoomId): Set<number> {
  const used = new Set<number>();
  for (const s of seats.values()) if (s.room === room) used.add(s.index);
  return used;
}

// Lowest seat index nobody in `room` holds right now.
export function freeSeat(seats: ReadonlyMap<string, Seat>, room: RoomId): number {
  return lowestFree(usedIn(seats, room));
}

// A character keeps its seat while it stays in the room. Anyone who changed room
// or just arrived takes the lowest seat free there; anyone gone gives theirs up.
export function assignSeats(
  prev: ReadonlyMap<string, Seat>,
  people: Iterable<{ id: string; room: RoomId }>,
): Map<string, Seat> {
  const next = new Map<string, Seat>();
  const arrivals: { id: string; room: RoomId }[] = [];
  for (const p of people) {
    const s = prev.get(p.id);
    if (s && s.room === p.room) next.set(p.id, s);
    else arrivals.push(p);
  }
  const used = new Map<RoomId, Set<number>>();
  for (const p of arrivals) {
    const taken = used.get(p.room) ?? usedIn(next, p.room);
    used.set(p.room, taken);
    const index = lowestFree(taken);
    taken.add(index);
    next.set(p.id, { room: p.room, index });
  }
  return next;
}
