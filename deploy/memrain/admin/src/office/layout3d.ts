import type { ModelId } from "./asset-names.ts";
import { AMBIENT_SPOTS, CORRIDOR_FLOOR, OFFICE_MAP, PROPS, RUGS, WALL_DECOR, isWall, roomAt, type Prop } from "./map.ts";
import { facingProp } from "./ambient.ts";
import { facingToYaw, tileToWorld } from "./world.ts";
import type { Pose } from "./motion.ts";
import type { Tile } from "./path.ts";

// Where every piece of the 3D office goes, in world units. No three.js in here.

export type Furniture = Exclude<ModelId, "character">;
type Facing = Pose["facing"];

const W = OFFICE_MAP.width;
const H = OFFICE_MAP.height;

export const WALL_H = 0.5;
// Walls run along the middle of their tiles, so the rooms read as open zones.
export const WALL_T = 0.2;
const WALL_GAP = 1 - WALL_T / 2;
export const WALL_COLOR = "#f1ebe2";
const CHAIR_SEAT = 0.3;
const SOFA_SEAT = 0.2;

interface Spec {
  scale: number;
  // Backed up against the wall behind it.
  hug: boolean;
}

export const SPEC: Record<Furniture, Spec> = {
  desk: { scale: 1.35, hug: false },
  chair: { scale: 1.35, hug: false },
  shelf: { scale: 1.45, hug: true },
  cabinet: { scale: 1.45, hug: true },
  plant: { scale: 1.45, hug: false },
  sofa: { scale: 1.0, hug: true },
  coffee_machine: { scale: 1.4, hug: true },
  counter: { scale: 1.45, hug: false },
  whiteboard: { scale: 2.1, hug: true },
  board: { scale: 1.3, hug: true },
  lamp: { scale: 1.15, hug: false },
  rug: { scale: 1, hug: false },
  monitor: { scale: 0.9, hug: false },
};

const STEP: Record<Facing, readonly [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE: Record<Facing, Facing> = { up: "down", down: "up", left: "right", right: "left" };
const SIDES: readonly Facing[] = ["up", "left", "right", "down"];

export interface Placement {
  kind: Furniture;
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sz: number;
  tint?: string;
}

export interface Seat {
  x: number;
  z: number;
  yaw: number;
  height: number;
}

export interface Chair {
  tile: Tile;
  facing: Facing;
}

export interface BoxItem {
  x: number;
  z: number;
  sx: number;
  sz: number;
  color: string;
  shade: number;
}

export const tileKey = (x: number, y: number) => `${x},${y}`;

function propAt(x: number, y: number, kinds: readonly (ModelId | null)[]): Prop | undefined {
  return PROPS.find((p) => p.x === x && p.y === y && kinds.includes(p.kind));
}

const ALL_SEATS: ReadonlySet<string> = new Set(Object.values(OFFICE_MAP.seats).flat().map((t) => tileKey(t.x, t.y)));

// Desks and tables face the seat beside them; everything else turns its back to the nearest wall.
function propFacing(p: Prop): { facing: Facing; walled: boolean } {
  if (p.kind === "desk" || p.kind === "counter") {
    const toSeat = (["down", "up", "left", "right"] as const).find((f) => ALL_SEATS.has(tileKey(p.x + STEP[f][0], p.y + STEP[f][1])));
    return { facing: toSeat ?? "down", walled: false };
  }
  const wall = SIDES.find((f) => isWall(p.x + STEP[f][0], p.y + STEP[f][1]));
  return wall ? { facing: OPPOSITE[wall], walled: true } : { facing: "down", walled: false };
}

function sofaSeat(sofa: Prop, from: Tile): Seat {
  const c = tileToWorld(sofa);
  const tx = Math.sign(from.x - sofa.x);
  const tz = Math.sign(from.y - sofa.y);
  return { x: c.x + tx * 0.18, z: c.z + tz * 0.18, yaw: facingToYaw(propFacing(sofa).facing), height: SOFA_SEAT };
}

// Where a figure really sits once it settles on a tile: on a chair at a desk or table,
// or on the sofa beside it. The chairs stand on these same tiles.
export function buildSeats(): { seats: Map<string, Seat>; sofaSpots: Map<string, Seat>; chairs: Chair[] } {
  const seats = new Map<string, Seat>();
  const chairs: Chair[] = [];
  for (const [room, tiles] of Object.entries(OFFICE_MAP.seats)) {
    for (const t of tiles) {
      const table = SIDES.find((f) => propAt(t.x + STEP[f][0], t.y + STEP[f][1], ["desk", "counter"]));
      const sofaSide = SIDES.find((f) => propAt(t.x + STEP[f][0], t.y + STEP[f][1], ["sofa"]));
      const sofa = sofaSide && propAt(t.x + STEP[sofaSide][0], t.y + STEP[sofaSide][1], ["sofa"]);
      const facing = table ?? (room === "break_room" && !sofa ? "down" : undefined);
      const c = tileToWorld(t);
      if (facing) {
        chairs.push({ tile: t, facing });
        seats.set(tileKey(t.x, t.y), { x: c.x, z: c.z, yaw: facingToYaw(facing), height: CHAIR_SEAT });
      } else if (sofa) {
        seats.set(tileKey(t.x, t.y), sofaSeat(sofa, t));
      }
    }
  }
  const sofaSpots = new Map<string, Seat>();
  for (const t of AMBIENT_SPOTS.sofa) {
    const f = facingProp("sofa", t);
    const sofa = f && propAt(t.x + STEP[f][0], t.y + STEP[f][1], ["sofa"]);
    if (sofa) sofaSpots.set(tileKey(t.x, t.y), sofaSeat(sofa, t));
  }
  return { seats, sofaSpots, chairs };
}

type Size = (k: Furniture) => { x: number; y: number; z: number };

export function buildPlacements(size: Size, chairs: readonly Chair[]): Placement[] {
  const out: Placement[] = [];
  const depth = (k: Furniture) => size(k).z * SPEC[k].scale;
  const height = (k: Furniture) => size(k).y * SPEC[k].scale;
  const againstWall = (k: Furniture) => -(WALL_GAP - depth(k) / 2 - 0.02);
  const put = (kind: Furniture, t: Tile, facing: Facing, push = 0, y = 0) => {
    const c = tileToWorld(t);
    const [dx, dz] = STEP[facing];
    const s = SPEC[kind].scale;
    out.push({ kind, x: c.x + dx * push, y, z: c.z + dz * push, yaw: facingToYaw(facing), sx: s, sz: s });
  };

  for (const p of PROPS) {
    if (!p.kind || p.kind === "character") continue;
    const { facing, walled } = propFacing(p);
    const hug = walled && SPEC[p.kind].hug;
    if (p.kind === "coffee_machine") {
      // A coffee machine needs a counter to stand on.
      put("counter", p, facing, walled ? againstWall("counter") : 0);
      put("coffee_machine", p, facing, hug ? againstWall("coffee_machine") : 0, height("counter"));
    } else {
      put(p.kind, p, facing, hug ? againstWall(p.kind) : 0);
    }
  }

  // Pictures and boards hang on the face of the wall that looks into the room; the
  // whiteboard is a stand, so its feet rest on the floor.
  for (const p of WALL_DECOR) {
    if (!p.kind || p.kind === "character") continue;
    const open = (["down", "up", "left", "right"] as const).find((f) => !isWall(p.x + STEP[f][0], p.y + STEP[f][1])) ?? "down";
    put(p.kind, p, open, WALL_T / 2 + depth(p.kind) / 2 + 0.005, p.kind === "whiteboard" ? 0 : 0.1);
  }

  for (const { tile, facing } of chairs) {
    put("chair", tile, facing, -0.08);
    // A screen on the desk, turned to whoever sits there.
    const desk = propAt(tile.x + STEP[facing][0], tile.y + STEP[facing][1], ["desk"]);
    if (desk) put("monitor", desk, OPPOSITE[facing], -0.1, height("desk"));
  }

  for (const r of RUGS) {
    const c = tileToWorld({ x: r.x + (r.w - 1) / 2, y: r.y + (r.h - 1) / 2 });
    const s = size("rug");
    out.push({ kind: "rug", x: c.x, y: 0.002, z: c.z, yaw: 0, sx: (r.w * 0.92) / s.x, sz: (r.h * 0.88) / s.z, tint: r.color });
  }
  return out;
}

function floorOf(t: Tile): { color: string; shade: number } {
  return { color: roomAt(t.x, t.y)?.floor ?? CORRIDOR_FLOOR, shade: (t.x + t.y) % 2 ? 1 : 0.94 };
}

// Quarter tiles, so each half of a wall tile takes the floor of its own side.
// The outer half of the border tiles lies outside the building and is left out.
export function floorBoxes(): BoxItem[] {
  const out: BoxItem[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = tileToWorld({ x, y });
      for (const qx of [-1, 1]) {
        for (const qy of [-1, 1]) {
          if ((x === 0 && qx < 0) || (x === W - 1 && qx > 0) || (y === 0 && qy < 0) || (y === H - 1 && qy > 0)) continue;
          const src = !isWall(x, y) ? { x, y } : [{ x: x + qx, y }, { x, y: y + qy }, { x: x + qx, y: y + qy }].find((t) => !isWall(t.x, t.y));
          out.push({ x: c.x + qx / 4, z: c.z + qy / 4, sx: 0.5, sz: 0.5, ...(src ? floorOf(src) : { color: CORRIDOR_FLOOR, shade: 1 }) });
        }
      }
    }
  }
  return out;
}

export function wallBoxes(): BoxItem[] {
  const out: BoxItem[] = [];
  const wall = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && isWall(x, y);
  const piece = (x: number, z: number, sx: number, sz: number) => out.push({ x, z, sx, sz, color: WALL_COLOR, shade: 1 });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!wall(x, y)) continue;
      const c = tileToWorld({ x, y });
      if (wall(x + 1, y)) piece(c.x + 0.5, c.z, 1 + WALL_T, WALL_T);
      if (wall(x, y + 1)) piece(c.x, c.z + 0.5, WALL_T, 1 + WALL_T);
      if (!wall(x - 1, y) && !wall(x + 1, y) && !wall(x, y - 1) && !wall(x, y + 1)) piece(c.x, c.z, WALL_T, WALL_T);
    }
  }
  return out;
}
