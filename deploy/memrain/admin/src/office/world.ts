import { OFFICE_MAP } from "./map.ts";
import type { Pose } from "./motion.ts";

// One tile is one world unit.
export const WORLD_TILE = 1;

// Tile centre, with the map centred on the world origin.
export function tileToWorld(t: { x: number; y: number }): { x: number; z: number } {
  return {
    x: (t.x + 0.5 - OFFICE_MAP.width / 2) * WORLD_TILE,
    z: (t.y + 0.5 - OFFICE_MAP.height / 2) * WORLD_TILE,
  };
}

// Rotation about the vertical axis for a model that faces +z by default.
export function facingToYaw(f: Pose["facing"]): number {
  switch (f) {
    case "down": return 0;
    case "right": return Math.PI / 2;
    case "up": return Math.PI;
    case "left": return -Math.PI / 2;
  }
}
