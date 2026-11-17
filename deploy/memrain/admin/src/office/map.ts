import type { Tile } from "./path.ts";
import type { ModelId } from "./assets3d.ts";
import type { RoomId } from "./rooms.ts";

const W = 34;
const H = 25;

export interface Room {
  id: RoomId;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  floor: string;
}

export interface Prop {
  // null: no 3D model fits, the 3D scene skips the prop.
  kind: ModelId | null;
  x: number;
  y: number;
  solid: boolean;
}

export interface Rug {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export const ROOMS: readonly Room[] = [
  { id: "reception", label: "Reception", x: 1, y: 1, w: 8, h: 5, floor: "#e4d2b0" },
  { id: "archive", label: "Archive", x: 10, y: 1, w: 7, h: 5, floor: "#d3c4a8" },
  { id: "writing", label: "Writing desk", x: 18, y: 1, w: 7, h: 5, floor: "#dcc8a2" },
  { id: "library", label: "Library", x: 26, y: 1, w: 7, h: 5, floor: "#bfa27c" },
  { id: "mailroom", label: "Mailroom", x: 1, y: 10, w: 7, h: 5, floor: "#d8cbb4" },
  { id: "post_office", label: "Post office", x: 9, y: 10, w: 6, h: 5, floor: "#cdd6de" },
  { id: "night_shift", label: "Night shift", x: 19, y: 10, w: 7, h: 5, floor: "#7d87a6" },
  { id: "waiting_board", label: "Who's waiting", x: 27, y: 10, w: 6, h: 5, floor: "#dccfb8" },
  { id: "assistant_desk", label: "Assistant", x: 1, y: 19, w: 7, h: 5, floor: "#cdc6df" },
  { id: "back_office", label: "Back office", x: 9, y: 19, w: 7, h: 5, floor: "#cbc5b9" },
  { id: "break_room", label: "Break room", x: 17, y: 19, w: 16, h: 5, floor: "#bcd7c8" },
];

export const CORRIDOR_FLOOR = "#e3ded3";

const CORRIDORS = [
  { x: 1, y: 7, w: 32, h: 2 },
  { x: 1, y: 16, w: 32, h: 2 },
  { x: 16, y: 9, w: 2, h: 7 },
];

// Two tiles wide, cut into the wall between a room and its corridor.
const DOORS: readonly Tile[] = [
  { x: 4, y: 6 }, { x: 12, y: 6 }, { x: 20, y: 6 }, { x: 28, y: 6 },
  { x: 5, y: 9 }, { x: 12, y: 9 }, { x: 23, y: 9 }, { x: 31, y: 9 },
  { x: 5, y: 18 }, { x: 13, y: 18 }, { x: 22, y: 18 }, { x: 29, y: 18 },
];

// What each piece of furniture is drawn as; the piano has no model and is left out.
const PLANT: ModelId = "plant";
const DESK: ModelId = "desk";
const TABLE: ModelId = "counter";
const CABINET: ModelId = "cabinet";
const SHELF: ModelId = "shelf";
const BOARD: ModelId = "board";
const LAMP: ModelId = "lamp";
const COFFEE: ModelId = "coffee_machine";
const SOFA: ModelId = "sofa";
const PIANO = null;

function solid(kind: ModelId | null, x: number, y: number): Prop {
  return { kind, x, y, solid: true };
}

function row(kind: ModelId | null, n: number, x: number, y: number): Prop[] {
  return Array.from({ length: n }, (_, dx) => solid(kind, x + dx, y));
}

export const PROPS: readonly Prop[] = [
  // Reception
  solid(PLANT, 1, 1), solid(CABINET, 2, 1), solid(CABINET, 7, 1), solid(PLANT, 8, 1),
  solid(DESK, 3, 3), solid(DESK, 4, 3), solid(DESK, 5, 3), solid(DESK, 6, 3),
  // Archive
  solid(CABINET, 10, 1), solid(CABINET, 11, 1), solid(CABINET, 12, 1), solid(CABINET, 13, 1),
  solid(CABINET, 14, 1), solid(CABINET, 15, 1), solid(CABINET, 16, 1),
  ...row(TABLE, 3, 14, 4),
  // Writing desk
  solid(SHELF, 18, 1), solid(PLANT, 24, 1),
  solid(DESK, 18, 3), solid(DESK, 19, 3), solid(DESK, 22, 3), solid(DESK, 23, 3), solid(DESK, 24, 3),
  // Library
  solid(SHELF, 26, 1), solid(SHELF, 27, 1), solid(SHELF, 28, 1), solid(SHELF, 29, 1),
  solid(SHELF, 30, 1), solid(SHELF, 31, 1), solid(SHELF, 32, 1),
  ...row(TABLE, 3, 30, 4), solid(PLANT, 26, 5),
  // Mailroom
  solid(SHELF, 1, 10), solid(SHELF, 2, 10), solid(CABINET, 3, 10), solid(CABINET, 7, 10),
  ...row(TABLE, 3, 2, 12),
  // Post office
  solid(SHELF, 9, 10), solid(CABINET, 10, 10), solid(CABINET, 11, 10), solid(CABINET, 14, 10),
  solid(DESK, 9, 12), solid(DESK, 10, 12), solid(DESK, 13, 12), solid(DESK, 14, 12),
  solid(PLANT, 9, 14), solid(PLANT, 14, 14),
  // Night shift
  solid(LAMP, 19, 10), solid(SHELF, 20, 10), solid(CABINET, 21, 10), solid(LAMP, 25, 10),
  solid(DESK, 19, 12), solid(DESK, 20, 12), solid(DESK, 22, 12), solid(DESK, 23, 12),
  // Who's waiting
  solid(BOARD, 27, 10), solid(BOARD, 28, 10), solid(BOARD, 29, 10), solid(TABLE, 32, 13),
  // Assistant
  solid(PLANT, 1, 19), solid(SHELF, 2, 19), solid(SHELF, 3, 19), solid(PLANT, 7, 19),
  solid(DESK, 1, 21), solid(DESK, 2, 21), solid(DESK, 4, 21), solid(DESK, 5, 21),
  // Back office
  solid(CABINET, 9, 19), solid(CABINET, 10, 19), solid(CABINET, 11, 19), solid(CABINET, 12, 19),
  solid(CABINET, 15, 19),
  solid(DESK, 9, 21), solid(DESK, 10, 21), solid(DESK, 14, 21), solid(DESK, 15, 21),
  solid(PLANT, 9, 23),
  // Break room
  solid(COFFEE, 17, 19), solid(SHELF, 18, 19), solid(SHELF, 19, 19),
  solid(SOFA, 24, 19), solid(SOFA, 25, 19), solid(PLANT, 26, 19),
  solid(SOFA, 28, 19), solid(SOFA, 29, 19), solid(COFFEE, 19, 20),
  ...row(PIANO, 2, 31, 19),
  solid(TABLE, 20, 22), solid(TABLE, 26, 22), solid(PLANT, 17, 23),
];

// Pictures hung on the wall above a room; purely decorative.
export const WALL_DECOR: readonly Prop[] = [
  { kind: "board", x: 6, y: 0, solid: false },
  { kind: "board", x: 15, y: 0, solid: false },
  { kind: "board", x: 23, y: 0, solid: false },
  { kind: "board", x: 31, y: 0, solid: false },
  // Break room whiteboard; the wall row sits above the room's top tiles.
  { kind: "whiteboard", x: 20, y: 18, solid: false },
  { kind: "whiteboard", x: 21, y: 18, solid: false },
];

export const RUGS: readonly Rug[] = [
  { x: 3, y: 4, w: 4, h: 2, color: "#b5654a" },
  { x: 19, y: 13, w: 7, h: 2, color: "#4b5574" },
  { x: 22, y: 21, w: 7, h: 3, color: "#e9c98f" },
  { x: 27, y: 11, w: 4, h: 3, color: "#8fae9b" },
];

const SEATS: Record<RoomId, Tile[]> = {
  reception: [{ x: 3, y: 4 }, { x: 6, y: 4 }, { x: 2, y: 4 }, { x: 7, y: 4 }, { x: 1, y: 3 }, { x: 8, y: 3 }],
  archive: [{ x: 10, y: 2 }, { x: 11, y: 2 }, { x: 13, y: 2 }, { x: 15, y: 2 }, { x: 16, y: 2 }, { x: 11, y: 4 }],
  writing: [{ x: 18, y: 2 }, { x: 19, y: 2 }, { x: 22, y: 2 }, { x: 23, y: 2 }, { x: 24, y: 2 }, { x: 20, y: 2 }],
  library: [{ x: 26, y: 2 }, { x: 27, y: 2 }, { x: 28, y: 2 }, { x: 30, y: 2 }, { x: 31, y: 2 }, { x: 32, y: 2 }],
  mailroom: [{ x: 2, y: 11 }, { x: 3, y: 11 }, { x: 4, y: 11 }, { x: 5, y: 12 }, { x: 5, y: 13 }, { x: 1, y: 12 }],
  post_office: [{ x: 9, y: 11 }, { x: 10, y: 11 }, { x: 13, y: 11 }, { x: 14, y: 11 }, { x: 11, y: 11 }, { x: 11, y: 13 }],
  night_shift: [{ x: 19, y: 11 }, { x: 20, y: 11 }, { x: 22, y: 11 }, { x: 23, y: 11 }, { x: 21, y: 11 }, { x: 24, y: 11 }],
  waiting_board: [{ x: 27, y: 11 }, { x: 28, y: 11 }, { x: 29, y: 11 }, { x: 27, y: 13 }, { x: 28, y: 13 }, { x: 30, y: 13 }],
  assistant_desk: [{ x: 1, y: 20 }, { x: 2, y: 20 }, { x: 4, y: 20 }, { x: 5, y: 20 }, { x: 3, y: 20 }, { x: 6, y: 20 }],
  back_office: [{ x: 9, y: 20 }, { x: 10, y: 20 }, { x: 14, y: 20 }, { x: 15, y: 20 }, { x: 12, y: 20 }, { x: 11, y: 22 }],
  break_room: [
    { x: 19, y: 22 }, { x: 21, y: 22 }, { x: 20, y: 21 }, { x: 20, y: 23 },
    { x: 25, y: 22 }, { x: 27, y: 22 }, { x: 26, y: 21 }, { x: 26, y: 23 },
    { x: 24, y: 20 }, { x: 25, y: 20 }, { x: 31, y: 21 }, { x: 18, y: 21 },
  ],
};

const open = new Uint8Array(W * H);
const blocked = new Uint8Array(W * H);

function carve(x: number, y: number, w: number, h: number): void {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) open[j * W + i] = 1;
}

for (const r of ROOMS) carve(r.x, r.y, r.w, r.h);
for (const c of CORRIDORS) carve(c.x, c.y, c.w, c.h);
for (const d of DOORS) carve(d.x, d.y, 2, 1);
for (const p of PROPS) if (p.solid) blocked[p.y * W + p.x] = 1;

function inside(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < W && y < H;
}

export function isWall(x: number, y: number): boolean {
  return !inside(x, y) || open[y * W + x] === 0;
}

export function isSolid(x: number, y: number): boolean {
  return inside(x, y) && blocked[y * W + x] === 1;
}

export function roomAt(x: number, y: number): Room | undefined {
  return ROOMS.find((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
}

export const OFFICE_MAP: {
  width: number;
  height: number;
  walkable: (x: number, y: number) => boolean;
  seats: Record<RoomId, Tile[]>;
} = {
  width: W,
  height: H,
  walkable: (x, y) => !isWall(x, y) && !isSolid(x, y),
  seats: SEATS,
};

export type AmbientKind = "wander" | "coffee" | "chat" | "whiteboard" | "water_plants" | "sofa";

// Free floor beside the prop each idle activity belongs to.
export const AMBIENT_SPOTS: Record<Exclude<AmbientKind, "wander" | "chat">, readonly Tile[]> = {
  coffee: [{ x: 17, y: 20 }, { x: 18, y: 20 }],
  whiteboard: [{ x: 20, y: 19 }, { x: 21, y: 19 }],
  water_plants: [{ x: 17, y: 22 }, { x: 9, y: 22 }, { x: 8, y: 2 }],
  sofa: [{ x: 23, y: 19 }, { x: 28, y: 20 }, { x: 29, y: 20 }, { x: 30, y: 19 }],
};

// Two people face each other across neighbouring tiles.
export const CHAT_SPOTS: readonly (readonly [Tile, Tile])[] = [
  [{ x: 8, y: 7 }, { x: 9, y: 7 }],
  [{ x: 20, y: 8 }, { x: 21, y: 8 }],
  [{ x: 6, y: 17 }, { x: 7, y: 17 }],
  [{ x: 26, y: 16 }, { x: 27, y: 16 }],
  [{ x: 22, y: 23 }, { x: 23, y: 23 }],
];

export function seatFor(room: RoomId, index: number): Tile {
  const seats = SEATS[room];
  const i = ((Math.trunc(index) % seats.length) + seats.length) % seats.length;
  return seats[i]!;
}

// Free floor inside each room, row by row, for visitors once every seat is taken.
const FLOOR: Record<RoomId, Tile[]> = Object.fromEntries(
  ROOMS.map((r) => {
    const tiles: Tile[] = [];
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const seat = SEATS[r.id].some((t) => t.x === x && t.y === y);
        if (!seat && OFFICE_MAP.walkable(x, y)) tiles.push({ x, y });
      }
    }
    return [r.id, tiles];
  }),
) as Record<RoomId, Tile[]>;

// Seats first, then the room's free floor; wraps only once every floor tile is in use.
export function spotFor(room: RoomId, index: number): Tile {
  const seats = SEATS[room];
  const floor = FLOOR[room];
  const total = seats.length + floor.length;
  const i = ((Math.trunc(index) % total) + total) % total;
  return i < seats.length ? seats[i]! : floor[i - seats.length]!;
}
