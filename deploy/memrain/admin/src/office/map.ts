import type { Tile } from "./path.ts";
import type { RoomId } from "./rooms.ts";

export const TILE = 16;
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

// [column, row] in the indoor tile sheet.
export type Cell = readonly [number, number];

export interface Prop {
  cell: Cell;
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

const PLANT: Cell = [16, 0];
const PLANT_TALL: Cell = [17, 0];
const DESK: Cell = [5, 4];
const DESK_END: Cell = [4, 4];
const ROUND_TABLE: Cell = [7, 0];
const DRAWERS: Cell = [1, 13];
const CUPBOARD: Cell = [0, 13];
const CUPBOARD_WIDE: Cell = [2, 13];
const CABINET_LOW: Cell = [1, 15];
const SHELF_PLATES: Cell = [4, 15];
const SHELF_JARS: Cell = [5, 13];
const SHELF_POTS: Cell = [6, 13];
const BOOKCASE: Cell = [19, 17];
const BOOKCASE_B: Cell = [20, 17];
const BOOKCASE_C: Cell = [21, 17];
const NOTES: Cell = [16, 13];
const BOARD_LEFT: Cell = [20, 13];
const BOARD_RIGHT: Cell = [21, 13];
const CANDLE: Cell = [16, 6];
const CANDELABRA: Cell = [17, 7];
const STOVE: Cell = [14, 14];
const ARMCHAIR: Cell = [14, 9];
const ARMCHAIR_B: Cell = [15, 9];

function solid(cell: Cell, x: number, y: number): Prop {
  return { cell, x, y, solid: true };
}

function row(cells: readonly Cell[], x: number, y: number): Prop[] {
  return cells.map((cell, dx) => solid(cell, x + dx, y));
}

const ORANGE_TABLE: Cell[] = [[16, 8], [17, 8], [18, 8]];
const GREEN_TABLE: Cell[] = [[16, 10], [17, 10], [18, 10]];
const LONG_TABLE: Cell[] = [[0, 0], [1, 0], [2, 0]];
const PIANO: Cell[] = [[23, 8], [24, 8]];

export const PROPS: readonly Prop[] = [
  // Reception
  solid(PLANT, 1, 1), solid(DRAWERS, 2, 1), solid(CUPBOARD_WIDE, 7, 1), solid(PLANT_TALL, 8, 1),
  solid(DESK_END, 3, 3), solid(DESK, 4, 3), solid(DESK, 5, 3), solid(DESK, 6, 3),
  // Archive
  solid(DRAWERS, 10, 1), solid(CUPBOARD, 11, 1), solid(CABINET_LOW, 12, 1), solid(CUPBOARD_WIDE, 13, 1),
  solid(DRAWERS, 14, 1), solid(CUPBOARD, 15, 1), solid(DRAWERS, 16, 1),
  ...row(LONG_TABLE, 14, 4),
  // Writing desk
  solid(SHELF_PLATES, 18, 1), solid(PLANT, 24, 1),
  solid(DESK_END, 18, 3), solid(DESK, 19, 3), solid(DESK_END, 22, 3), solid(DESK, 23, 3), solid(DESK, 24, 3),
  // Library
  solid(BOOKCASE, 26, 1), solid(BOOKCASE_B, 27, 1), solid(BOOKCASE_C, 28, 1), solid(BOOKCASE_B, 29, 1),
  solid(BOOKCASE, 30, 1), solid(BOOKCASE_C, 31, 1), solid(BOOKCASE_B, 32, 1),
  ...row(GREEN_TABLE, 30, 4), solid(PLANT_TALL, 26, 5),
  // Mailroom
  solid(SHELF_JARS, 1, 10), solid(SHELF_POTS, 2, 10), solid(CABINET_LOW, 3, 10), solid(DRAWERS, 7, 10),
  ...row(ORANGE_TABLE, 2, 12),
  // Post office
  solid(SHELF_PLATES, 9, 10), solid(DRAWERS, 10, 10), solid(CUPBOARD_WIDE, 11, 10), solid(CUPBOARD, 14, 10),
  solid(DESK_END, 9, 12), solid(DESK, 10, 12), solid(DESK_END, 13, 12), solid(DESK, 14, 12),
  solid(PLANT, 9, 14), solid(PLANT_TALL, 14, 14),
  // Night shift
  solid(CANDLE, 19, 10), solid(SHELF_PLATES, 20, 10), solid(DRAWERS, 21, 10), solid(CANDELABRA, 25, 10),
  solid(DESK_END, 19, 12), solid(DESK, 20, 12), solid(DESK_END, 22, 12), solid(DESK, 23, 12),
  // Who's waiting
  solid(NOTES, 27, 10), solid(BOARD_LEFT, 28, 10), solid(BOARD_RIGHT, 29, 10), solid(ROUND_TABLE, 32, 13),
  // Assistant
  solid(PLANT_TALL, 1, 19), solid(BOOKCASE_B, 2, 19), solid(BOOKCASE_C, 3, 19), solid(PLANT, 7, 19),
  solid(DESK_END, 1, 21), solid(DESK, 2, 21), solid(DESK_END, 4, 21), solid(DESK, 5, 21),
  // Back office
  solid(CUPBOARD, 9, 19), solid(DRAWERS, 10, 19), solid(CUPBOARD_WIDE, 11, 19), solid(CABINET_LOW, 12, 19),
  solid(CUPBOARD, 15, 19),
  solid(DESK_END, 9, 21), solid(DESK, 10, 21), solid(DESK_END, 14, 21), solid(DESK, 15, 21),
  solid(PLANT, 9, 23),
  // Break room
  solid(STOVE, 17, 19), solid(SHELF_JARS, 18, 19), solid(SHELF_POTS, 19, 19),
  solid(ARMCHAIR, 24, 19), solid(ARMCHAIR_B, 25, 19), solid(PLANT_TALL, 26, 19),
  ...row(PIANO, 31, 19),
  solid(ROUND_TABLE, 20, 22), solid(ROUND_TABLE, 26, 22), solid(PLANT, 17, 23),
];

// Pictures hung on the wall above a room; purely decorative.
export const WALL_DECOR: readonly Prop[] = [
  { cell: [19, 12], x: 6, y: 0, solid: false },
  { cell: [16, 12], x: 15, y: 0, solid: false },
  { cell: [19, 14], x: 23, y: 0, solid: false },
  { cell: [18, 0], x: 31, y: 0, solid: false },
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

// Largest whole-number scale that fits the map, centred in a w×h canvas. A canvas
// smaller than the map gets a fractional scale so the whole office stays visible.
export function officeLayout(w: number, h: number): { scale: number; ox: number; oy: number } {
  const pw = W * TILE;
  const ph = H * TILE;
  const fit = Math.min(w / pw, h / ph);
  const scale = fit >= 1 ? Math.floor(fit) : Math.max(fit, 0.01);
  return { scale, ox: Math.floor((w - pw * scale) / 2), oy: Math.floor((h - ph * scale) / 2) };
}
