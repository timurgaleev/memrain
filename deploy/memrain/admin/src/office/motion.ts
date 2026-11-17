import { OFFICE_MAP } from "./map.ts";
import { findPath, type Tile } from "./path.ts";

export interface Pose {
  x: number;
  y: number;
  path: Tile[];
  facing: "up" | "down" | "left" | "right";
  // Walk cycle phase in [0, 1); 0 while standing.
  frame: number;
}

const TILES_PER_SECOND = 3;
export const MAX_STEP_MS = 250;

function route(pose: Pose, target: Tile): Tile[] {
  const start = { x: Math.round(pose.x), y: Math.round(pose.y) };
  const rest = findPath(start, target, OFFICE_MAP.walkable, OFFICE_MAP.width, OFFICE_MAP.height);
  const offGrid = start.x !== pose.x || start.y !== pose.y;
  if (!offGrid) return rest;
  const atTarget = start.x === target.x && start.y === target.y;
  return rest.length > 0 || atTarget ? [start, ...rest] : [];
}

function facingFor(dx: number, dy: number, fallback: Pose["facing"]): Pose["facing"] {
  if (dx === 0 && dy === 0) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

export function stepCharacter(
  pose: Pose,
  target: Tile,
  dtMs: number,
  opts: { reducedMotion: boolean },
): Pose {
  const arrived: Pose = { x: target.x, y: target.y, path: [], facing: pose.facing, frame: 0 };
  if (opts.reducedMotion) return arrived;
  if (pose.x === target.x && pose.y === target.y) {
    return pose.path.length === 0 && pose.frame === 0 ? pose : arrived;
  }

  const last = pose.path[pose.path.length - 1];
  const path = last && last.x === target.x && last.y === target.y ? pose.path : route(pose, target);
  if (path.length === 0) {
    // No route to a real floor tile: place the character rather than freeze it.
    // A wall or furniture is never a valid spot, so stay where we are.
    return OFFICE_MAP.walkable(target.x, target.y) ? arrived : pose;
  }

  let { x, y, facing } = pose;
  // A hidden tab resumes with one huge dt; walk on from there instead of skipping to the end.
  let budget = (TILES_PER_SECOND * Math.min(MAX_STEP_MS, Math.max(0, dtMs))) / 1000;
  let moved = 0;
  let i = 0;
  while (budget > 0 && i < path.length) {
    const next = path[i]!;
    const dx = next.x - x;
    const dy = next.y - y;
    facing = facingFor(dx, dy, facing);
    const sx = Math.min(budget, Math.abs(dx));
    x = sx === Math.abs(dx) ? next.x : x + Math.sign(dx) * sx;
    budget -= sx;
    const sy = Math.min(budget, Math.abs(dy));
    y = sy === Math.abs(dy) ? next.y : y + Math.sign(dy) * sy;
    budget -= sy;
    moved += sx + sy;
    if (x === next.x && y === next.y) i++;
  }

  const remaining = path.slice(i);
  const frame = remaining.length === 0 ? 0 : (pose.frame + moved) % 1;
  return { x, y, path: remaining, facing, frame };
}
