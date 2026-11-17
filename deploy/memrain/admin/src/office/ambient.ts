import type { Character, OfficeState } from "./model.ts";
import { AMBIENT_SPOTS, CHAT_SPOTS, OFFICE_MAP, PROPS, WALL_DECOR, roomAt, type AmbientKind } from "./map.ts";
import type { ModelId } from "./assets3d.ts";
import type { Pose } from "./motion.ts";
import type { Tile } from "./path.ts";

export interface Activity {
  kind: AmbientKind;
  target: Tile;
  facing?: Pose["facing"];
  until: number;
  partner?: string;
}

export interface AmbientState {
  activities: ReadonlyMap<string, Activity>;
  nextAt: ReadonlyMap<string, number>;
}

type Facing = Pose["facing"];

const PAUSE_MS = [3000, 15000] as const;
const DURATION_MS = [5000, 20000] as const;
const OPPOSITE: Record<Facing, Facing> = { up: "down", down: "up", left: "right", right: "left" };
const SIDES: readonly [Facing, number, number][] = [
  ["up", 0, -1],
  ["right", 1, 0],
  ["down", 0, 1],
  ["left", -1, 0],
];

const key = (t: Tile) => `${t.x},${t.y}`;
const between = (rng: () => number, [lo, hi]: readonly [number, number]) => lo + Math.floor(rng() * (hi - lo + 1));

// Free floor in the break room and the corridors, never a seat.
const WANDER_TILES: readonly Tile[] = (() => {
  const seats = new Set(Object.values(OFFICE_MAP.seats).flat().map(key));
  const tiles: Tile[] = [];
  for (let y = 0; y < OFFICE_MAP.height; y++) {
    for (let x = 0; x < OFFICE_MAP.width; x++) {
      if (!OFFICE_MAP.walkable(x, y) || seats.has(`${x},${y}`)) continue;
      const room = roomAt(x, y);
      if (!room || room.id === "break_room") tiles.push({ x, y });
    }
  }
  return tiles;
})();

export function emptyAmbient(): AmbientState {
  return { activities: new Map(), nextAt: new Map() };
}

// The prop each activity is about; the figure turns to the matching one beside its spot.
const PROP_OF: Record<"coffee" | "whiteboard" | "water_plants" | "sofa", ModelId> = {
  coffee: "coffee_machine",
  whiteboard: "whiteboard",
  water_plants: "plant",
  sofa: "sofa",
};

export function facingProp(kind: keyof typeof PROP_OF, t: Tile): Facing | undefined {
  for (const [f, dx, dy] of SIDES) {
    const hit = [...PROPS, ...WALL_DECOR].some((p) => p.kind === PROP_OF[kind] && p.x === t.x + dx && p.y === t.y + dy);
    if (hit) return f;
  }
  return undefined;
}

function facingTo(from: Tile, to: Tile): Facing {
  if (to.x !== from.x) return to.x > from.x ? "right" : "left";
  return to.y > from.y ? "down" : "up";
}

function canIdle(c: Character, now: number): boolean {
  return c.room === "break_room" && c.enabled && c.busyUntil <= now;
}

export function planAmbient(
  st: OfficeState,
  amb: AmbientState,
  now: number,
  rng: () => number,
  opts: { reducedMotion: boolean },
): AmbientState {
  if (opts.reducedMotion) return emptyAmbient();

  const activities = new Map<string, Activity>();
  const nextAt = new Map<string, number>();
  const taken = new Set<string>();
  for (const [id, c] of st.characters) {
    const prev = amb.nextAt.get(id);
    if (prev !== undefined) nextAt.set(id, prev);
    const a = amb.activities.get(id);
    const partnerOk = !a?.partner || (() => {
      const p = st.characters.get(a.partner!);
      return !!p && canIdle(p, now) && amb.activities.get(a.partner!)?.partner === id;
    })();
    if (a && a.until > now && canIdle(c, now) && partnerOk) {
      activities.set(id, a);
      taken.add(key(a.target));
    }
  }

  const due: string[] = [];
  for (const [id, c] of st.characters) {
    if (activities.has(id) || !canIdle(c, now)) continue;
    if (now >= (nextAt.get(id) ?? 0)) due.push(id);
  }

  const free = (spots: readonly Tile[]) => spots.filter((t) => !taken.has(key(t)));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const assigned = new Set<string>();

  for (const id of due) {
    if (assigned.has(id)) continue;
    const options: AmbientKind[] = [];
    if (free(WANDER_TILES).length) options.push("wander");
    for (const k of ["coffee", "whiteboard", "water_plants", "sofa"] as const) {
      if (free(AMBIENT_SPOTS[k]).length) options.push(k);
    }
    const partners = due.filter((o) => o !== id && !assigned.has(o));
    const pairs = CHAT_SPOTS.filter(([a, b]) => !taken.has(key(a)) && !taken.has(key(b)));
    if (partners.length && pairs.length) options.push("chat");
    if (!options.length) continue;

    const kind = pick(options);
    const until = now + between(rng, DURATION_MS);
    const rest = until + between(rng, PAUSE_MS);
    assigned.add(id);
    nextAt.set(id, rest);

    if (kind === "chat") {
      const other = pick(partners);
      const [a, b] = pick(pairs);
      const [first, second] = rng() < 0.5 ? [a, b] : [b, a];
      const facing = facingTo(first, second);
      activities.set(id, { kind, target: first, facing, until, partner: other });
      activities.set(other, { kind, target: second, facing: OPPOSITE[facing], until, partner: id });
      taken.add(key(a));
      taken.add(key(b));
      assigned.add(other);
      nextAt.set(other, rest);
      continue;
    }
    const target = pick(free(kind === "wander" ? WANDER_TILES : AMBIENT_SPOTS[kind]));
    const facing = kind === "wander" ? undefined : facingProp(kind, target);
    activities.set(id, { kind, target, ...(facing ? { facing } : {}), until });
    taken.add(key(target));
  }

  return { activities, nextAt };
}

export function targetFor(
  c: Character,
  amb: AmbientState,
  seatTile: Tile,
  now: number,
): { tile: Tile; facing?: Pose["facing"]; pose: "walk" | "idle" | "sit" | "work" | AmbientKind } {
  if (c.busyUntil > now) return { tile: seatTile, pose: "work" };
  const a = amb.activities.get(c.id);
  if (a && c.enabled && c.room === "break_room") return { tile: a.target, facing: a.facing, pose: a.kind };
  return { tile: seatTile, pose: c.room === "break_room" ? "sit" : "idle" };
}
