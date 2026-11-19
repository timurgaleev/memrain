// What the 3D office loads, by file name under src/assets/office3d/. Kept apart from
// assets3d.ts, whose `?url` imports only a bundler understands, so plain code and
// tests can use these facts.

export type ModelId =
  | "desk"
  | "chair"
  | "shelf"
  | "cabinet"
  | "plant"
  | "sofa"
  | "coffee_machine"
  | "counter"
  | "whiteboard"
  | "board"
  | "lamp"
  | "rug"
  | "monitor"
  | "character";

// Built in code (whiteboard3d.ts), so there is no file to load.
export type ProceduralModelId = "whiteboard";
export const PROCEDURAL_MODELS: readonly ModelId[] = ["whiteboard"];

export const MODEL_FILES: Readonly<Record<Exclude<ModelId, ProceduralModelId>, string>> = {
  desk: "desk.glb",
  chair: "chairDesk.glb",
  shelf: "bookcaseOpen.glb",
  cabinet: "bookcaseClosedDoors.glb",
  plant: "pottedPlant.glb",
  sofa: "loungeSofa.glb",
  coffee_machine: "kitchenCoffeeMachine.glb",
  counter: "kitchenBar.glb",
  board: "paneling.glb",
  lamp: "lampRoundFloor.glb",
  rug: "rugRectangle.glb",
  monitor: "computerScreen.glb",
  character: "character-male-a.gltf",
};

// One file per person; every person shares the same rig and clips.
export const CHARACTER_FILES: readonly string[] = [
  "character-male-a.gltf",
  "character-female-b.gltf",
  "character-male-d.gltf",
  "character-female-f.gltf",
  "character-male-b.gltf",
  "character-female-d.gltf",
];

// Clips each person carries; anything else (typing, watering) is animated by hand.
export const CHARACTER_CLIPS = ["idle", "walk", "sit", "interact-right", "pick-up", "emote-yes"] as const;

// Files a .gltf names by plain name for its buffer and texture.
export const SIDE_FILES: readonly string[] = [
  "colormap.png",
  "character-male-a.bin",
  "character-male-b.bin",
  "character-male-d.bin",
  "character-female-b.bin",
  "character-female-d.bin",
  "character-female-f.bin",
];

// The side file a loader URL asks for, or null when it asks for anything else.
export function sideFileOf(url: string): string | null {
  const name = url.slice(url.lastIndexOf("/") + 1);
  return SIDE_FILES.includes(name) ? name : null;
}
