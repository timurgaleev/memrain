import type { AmbientKind } from "./map.ts";

export type PoseKind = "walk" | "idle" | "sit" | "work" | AmbientKind;

// Hand-made body motion, in radians and world units. The figures have clips for most
// of this; the scene reads these for the extra sway and lean the clips do not carry.
export interface AnimPose {
  bob: number;
  armSwing: number;
  legSwing: number;
  lean: number;
  seatDrop: number;
}

const TAU = Math.PI * 2;
const wave = (t: number, hz: number) => Math.sin(TAU * hz * t);

export function animPose(kind: PoseKind, t: number): AnimPose {
  const breath = 0.008 * wave(t, 0.25);
  switch (kind) {
    case "walk": {
      const s = wave(t, 1.5);
      return { bob: 0.03 * Math.abs(s), armSwing: -0.5 * s, legSwing: 0.6 * s, lean: 0.05, seatDrop: 0 };
    }
    case "sit":
      return { bob: breath, armSwing: 0.05 * wave(t, 0.2), legSwing: 0.8, lean: 0, seatDrop: 0.3 };
    case "sofa":
      return { bob: breath, armSwing: 0.1, legSwing: 0.8, lean: -0.08, seatDrop: 0.32 };
    case "work":
      return { bob: 0.004 * wave(t, 3), armSwing: 0.25 * wave(t, 3), legSwing: 0, lean: 0.15, seatDrop: 0 };
    case "whiteboard":
      return { bob: breath, armSwing: 0.55 + 0.2 * wave(t, 1.2), legSwing: 0, lean: 0.05, seatDrop: 0 };
    case "water_plants":
      return { bob: breath, armSwing: 0.5, legSwing: 0, lean: 0.25 + 0.05 * wave(t, 0.5), seatDrop: 0 };
    case "coffee":
      return { bob: breath, armSwing: 0.4 * (1 - Math.cos(TAU * t / 4)) / 2, legSwing: 0, lean: 0, seatDrop: 0 };
    case "chat":
      return { bob: 0.01 * Math.abs(wave(t, 0.8)), armSwing: 0.3 * wave(t, 0.8), legSwing: 0, lean: 0.03, seatDrop: 0 };
    case "wander":
      return { bob: breath, armSwing: 0.04 * wave(t, 0.3), legSwing: 0, lean: 0.02 * wave(t, 0.15), seatDrop: 0 };
    case "idle":
      return { bob: breath, armSwing: 0.03 * wave(t, 0.25), legSwing: 0, lean: 0, seatDrop: 0 };
  }
}

export function syncCharacters(existing: ReadonlySet<string>, wanted: ReadonlySet<string>): { add: string[]; remove: string[] } {
  return {
    add: [...wanted].filter((id) => !existing.has(id)),
    remove: [...existing].filter((id) => !wanted.has(id)),
  };
}
