import type { AmbientKind } from "./map.ts";

export type PoseKind = "walk" | "idle" | "sit" | "work" | AmbientKind;

// "type" is the scene's blend of the sit clip's legs with the interact clip's arms.
export type ClipName = "idle" | "walk" | "sit" | "interact-right" | "pick-up" | "emote-yes" | "type";

// The sway and lean the clips do not carry: world units and radians.
export interface AnimPose {
  bob: number;
  lean: number;
}

const TAU = Math.PI * 2;
const wave = (t: number, hz: number) => Math.sin(TAU * hz * t);

export function animPose(kind: PoseKind, t: number): AnimPose {
  const breath = 0.008 * wave(t, 0.25);
  switch (kind) {
    case "walk":
      return { bob: 0.03 * Math.abs(wave(t, 1.5)), lean: 0.05 };
    case "sit":
      return { bob: breath, lean: 0 };
    case "sofa":
      return { bob: breath, lean: -0.08 };
    case "work":
      return { bob: 0.004 * wave(t, 3), lean: 0.15 };
    case "whiteboard":
      return { bob: breath, lean: 0.05 };
    case "water_plants":
      return { bob: breath, lean: 0.25 + 0.05 * wave(t, 0.5) };
    case "chat":
      return { bob: 0.01 * Math.abs(wave(t, 0.8)), lean: 0.03 };
    case "wander":
      return { bob: breath, lean: 0.02 * wave(t, 0.15) };
    case "coffee":
    case "idle":
      return { bob: breath, lean: 0 };
  }
}

const COFFEE_POUR_MS = 2500;
const CHAT_CYCLE_MS = 5200;
const CHAT_NOD_MS = 1330;

// Which clip a figure plays. `seated` means it has settled on a chair or sofa;
// `elapsedMs` counts from the last pose change and `phase` (seconds) staggers people.
export function clipFor(pose: PoseKind, moving: boolean, seated: boolean, elapsedMs: number, phase: number): ClipName {
  if (moving) return "walk";
  if (seated) return pose === "work" ? "type" : "sit";
  switch (pose) {
    case "work":
    case "whiteboard":
      return "interact-right";
    case "water_plants":
      return "pick-up";
    case "coffee":
      return elapsedMs < COFFEE_POUR_MS ? "interact-right" : "idle";
    case "chat":
      return (elapsedMs + phase * 1000) % CHAT_CYCLE_MS < CHAT_NOD_MS ? "emote-yes" : "idle";
    case "sit":
    case "sofa":
      return "sit";
    case "walk":
    case "wander":
    case "idle":
      return "idle";
  }
}

export function syncCharacters(existing: ReadonlySet<string>, wanted: ReadonlySet<string>): { add: string[]; remove: string[] } {
  return {
    add: [...wanted].filter((id) => !existing.has(id)),
    remove: [...existing].filter((id) => !wanted.has(id)),
  };
}
