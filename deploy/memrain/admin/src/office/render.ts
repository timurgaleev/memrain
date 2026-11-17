import {
  CORRIDOR_FLOOR,
  OFFICE_MAP,
  PROPS,
  ROOMS,
  RUGS,
  TILE,
  WALL_DECOR,
  isSolid,
  isWall,
  officeLayout,
  roomAt,
  type Cell,
} from "./map.ts";
import type { Character, OfficeState } from "./model.ts";
import type { Pose } from "./motion.ts";
import { PEOPLE_COUNT, SHEET_STEP, personCell, type Sprites } from "./sprites.ts";

const WALL_TOP = "#373c4b";
const WALL_FACE = "#ece5d6";
const WALL_TRIM = "#b9ae99";
const PLAQUE = "#2f3442";
const PLAQUE_TEXT = "#f6f2ea";
const NAME_BG = "rgba(31, 34, 45, 0.82)";
const ERROR_RED = "#d8453b";
const LABEL_FONT = "600 6px ui-sans-serif, system-ui, sans-serif";
const NAME_FONT = "600 5.5px ui-sans-serif, system-ui, sans-serif";
const MAX_NAME = 14;

// Fixed looks for the built-in workers so they stay recognisable between visits.
const WORKER_LOOK: Record<string, number> = {
  connector_sync: 0,
  assistant: 1,
  loops_sweep: 3,
  notifications: 4,
  worker: 7,
  cycle: 9,
};

function lookFor(c: Character): number {
  const fixed = WORKER_LOOK[c.id];
  if (fixed !== undefined) return fixed;
  let h = 5381;
  for (let i = 0; i < c.id.length; i++) h = ((h << 5) + h + c.id.charCodeAt(i)) | 0;
  return Math.abs(h) % PEOPLE_COUNT;
}

function drawCell(ctx: CanvasRenderingContext2D, sheet: HTMLImageElement, cell: Cell, x: number, y: number): void {
  ctx.drawImage(sheet, cell[0] * SHEET_STEP, cell[1] * SHEET_STEP, TILE, TILE, x, y, TILE, TILE);
}

function drawFloors(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isWall(x, y)) continue;
      ctx.fillStyle = roomAt(x, y)?.floor ?? CORRIDOR_FLOOR;
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      if ((x + y) % 2 === 0) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.07)";
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
  }
  for (const r of RUGS) {
    const px = r.x * TILE + 2;
    const py = r.y * TILE + 2;
    const w = r.w * TILE - 4;
    const h = r.h * TILE - 4;
    ctx.fillStyle = r.color;
    ctx.fillRect(px, py, w, h);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 2.5, py + 2.5, w - 5, h - 5);
  }
}

function drawWalls(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isWall(x, y)) continue;
      const px = x * TILE;
      const py = y * TILE;
      if (isWall(x, y + 1)) {
        ctx.fillStyle = WALL_TOP;
        ctx.fillRect(px, py, TILE, TILE);
        continue;
      }
      // The wall faces the room below it: a light face under a dark cap.
      ctx.fillStyle = WALL_FACE;
      ctx.fillRect(px, py, TILE, TILE);
      ctx.fillStyle = WALL_TOP;
      ctx.fillRect(px, py, TILE, 4);
      ctx.fillStyle = WALL_TRIM;
      ctx.fillRect(px, py + TILE - 2, TILE, 2);
    }
  }
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function drawRoomLabels(ctx: CanvasRenderingContext2D): Box[] {
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const plaques: Box[] = [];
  for (const r of ROOMS) {
    const box = { x: r.x * TILE + 2, y: (r.y - 1) * TILE + 6, w: Math.ceil(ctx.measureText(r.label).width) + 6, h: 8 };
    ctx.fillStyle = PLAQUE;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = PLAQUE_TEXT;
    ctx.fillText(r.label, box.x + 3, box.y + 4);
    plaques.push(box);
  }
  return plaques;
}

function shortName(label: string): string {
  return label.length > MAX_NAME ? `${label.slice(0, MAX_NAME - 1)}…` : label;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Places a name tag above a head, nudging it up past plaques and tags already drawn nearby.
function drawName(ctx: CanvasRenderingContext2D, text: string, cx: number, bottom: number, taken: Box[]): void {
  ctx.font = NAME_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = Math.ceil(ctx.measureText(text).width) + 4;
  const box = { x: Math.round(cx - w / 2), y: bottom - 7, w, h: 7 };
  for (let tries = 0; tries < 4 && taken.some((t) => overlaps(t, box)); tries++) box.y -= 8;
  taken.push(box);
  ctx.fillStyle = NAME_BG;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, cx, box.y + 4);
}

function drawErrorBubble(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = ERROR_RED;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x - 1, y - 3, 2, 4);
  ctx.fillRect(x - 1, y + 2, 2, 1);
}

function drawBusyBubble(ctx: CanvasRenderingContext2D, x: number, y: number, now: number): void {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x - 5, y - 3, 11, 6);
  ctx.fillRect(x - 4, y + 3, 2, 1);
  const lit = Math.floor(now / 350) % 4;
  for (let k = 0; k < 3; k++) {
    ctx.fillStyle = k < lit ? "#3a3f4d" : "#c8c8c8";
    ctx.fillRect(x - 3 + k * 3, y - 1, 2, 2);
  }
}

function drawSnooze(ctx: CanvasRenderingContext2D, x: number, y: number, now: number): void {
  const t = (now % 2400) / 2400;
  const rise = Math.round(t * 3);
  ctx.font = "700 5px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = `rgba(70, 82, 112, ${1 - t * 0.6})`;
  ctx.fillText("z", x, y - rise);
  ctx.fillText("z", x + 3, y - 3 - rise);
}

function drawCharacter(ctx: CanvasRenderingContext2D, c: Character, pose: Pose, sprites: Sprites): void {
  const walking = pose.path.length > 0;
  const tx = Math.round(pose.x);
  const ty = Math.round(pose.y);
  // Standing behind a desk: tuck the feet behind it so they look seated.
  const tucked = !walking && isSolid(tx, ty + 1) ? 3 : 0;
  const bob = walking && pose.frame >= 0.5 ? 1 : 0;
  const px = Math.round(pose.x * TILE);
  const py = Math.round(pose.y * TILE) + tucked - bob;

  ctx.save();
  if (c.kind === "worker" && !c.enabled) {
    ctx.globalAlpha = 0.45;
    ctx.filter = "grayscale(1)";
  }
  if (!tucked) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.2)";
    ctx.beginPath();
    ctx.ellipse(px + 8, py + 15 + bob, 5, 1.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const [col, row] = personCell(lookFor(c));
  if (pose.facing === "left") {
    ctx.translate(px + TILE, py);
    ctx.scale(-1, 1);
    ctx.drawImage(sprites.people, col * SHEET_STEP, row * SHEET_STEP, TILE, TILE, 0, 0, TILE, TILE);
  } else {
    ctx.drawImage(sprites.people, col * SHEET_STEP, row * SHEET_STEP, TILE, TILE, px, py, TILE, TILE);
  }
  ctx.restore();
}

function drawOverlay(ctx: CanvasRenderingContext2D, c: Character, pose: Pose, now: number, taken: Box[]): void {
  const walking = pose.path.length > 0;
  const px = Math.round(pose.x * TILE);
  const py = Math.round(pose.y * TILE);
  ctx.save();
  if (c.kind === "worker" && !c.enabled) ctx.globalAlpha = 0.6;
  drawName(ctx, shortName(c.label), px + 8, py - 1, taken);
  ctx.restore();

  if (c.errorUntil > now) {
    drawErrorBubble(ctx, px + 14, py + 1);
  } else if (!walking && c.room !== "break_room" && c.busyUntil > now) {
    drawBusyBubble(ctx, px + 15, py + 2, now);
  } else if (!walking && c.kind === "worker" && c.enabled && c.room === "break_room") {
    drawSnooze(ctx, px + 12, py + 4, now);
  }
}

// Furniture in depth order, with source and target rectangles worked out once.
const PROP_DRAWS = [...PROPS]
  .sort((a, b) => a.y - b.y)
  .map((p) => ({ y: p.y, sx: p.cell[0] * SHEET_STEP, sy: p.cell[1] * SHEET_STEP, dx: p.x * TILE, dy: p.y * TILE }));

interface StaticLayer {
  scale: number;
  tiles: HTMLImageElement;
  canvas: HTMLCanvasElement;
  plaques: Box[];
}

let staticLayer: StaticLayer | null = null;

// Floors, walls, rugs, pictures and room plaques never change, so they are drawn
// once at a whole-number scale and copied in on every frame. A canvas smaller than
// the map shrinks the 1x copy in one drawImage, which leaves no seams between tiles.
function staticFor(layoutScale: number, sprites: Sprites): StaticLayer {
  const scale = Math.max(1, Math.floor(layoutScale));
  if (staticLayer && staticLayer.scale === scale && staticLayer.tiles === sprites.tiles) return staticLayer;
  const canvas = document.createElement("canvas");
  canvas.width = OFFICE_MAP.width * TILE * scale;
  canvas.height = OFFICE_MAP.height * TILE * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingEnabled = false;
  drawFloors(ctx, OFFICE_MAP.width, OFFICE_MAP.height);
  drawWalls(ctx, OFFICE_MAP.width, OFFICE_MAP.height);
  for (const d of WALL_DECOR) drawCell(ctx, sprites.tiles, d.cell, d.x * TILE, d.y * TILE + 2);
  const plaques = drawRoomLabels(ctx);
  staticLayer = { scale, tiles: sprites.tiles, canvas, plaques };
  return staticLayer;
}

export function drawOffice(
  ctx: CanvasRenderingContext2D,
  state: OfficeState,
  poses: Map<string, Pose>,
  sprites: Sprites,
  now: number,
): void {
  const { width, height } = ctx.canvas;
  const layout = officeLayout(width, height);
  const layer = staticFor(layout.scale, sprites);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(layout.scale, 0, 0, layout.scale, layout.ox, layout.oy);
  ctx.drawImage(layer.canvas, 0, 0, OFFICE_MAP.width * TILE, OFFICE_MAP.height * TILE);

  const people: { c: Character; pose: Pose }[] = [];
  for (const c of state.characters.values()) {
    const pose = poses.get(c.id);
    if (pose) people.push({ c, pose });
  }

  // Props and people share one depth order so someone behind a desk is hidden by it.
  people.sort((a, b) => a.pose.y - b.pose.y);
  let next = 0;
  for (const p of PROP_DRAWS) {
    while (next < people.length && people[next]!.pose.y < p.y) {
      drawCharacter(ctx, people[next]!.c, people[next]!.pose, sprites);
      next++;
    }
    ctx.drawImage(sprites.tiles, p.sx, p.sy, TILE, TILE, p.dx, p.dy, TILE, TILE);
  }
  for (; next < people.length; next++) drawCharacter(ctx, people[next]!.c, people[next]!.pose, sprites);

  // Front rows claim their tag spot first; tags further back move up out of the way.
  people.sort((a, b) => b.pose.y - a.pose.y || a.pose.x - b.pose.x);
  const taken: Box[] = [...layer.plaques];
  for (const { c, pose } of people) drawOverlay(ctx, c, pose, now, taken);
}
