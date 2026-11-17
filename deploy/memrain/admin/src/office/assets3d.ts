import whiteboardUrl from "../assets/office3d/bathroomMirror.glb?url";
import cabinetUrl from "../assets/office3d/bookcaseClosedDoors.glb?url";
import shelfUrl from "../assets/office3d/bookcaseOpen.glb?url";
import chairUrl from "../assets/office3d/chairDesk.glb?url";
import femaleBBin from "../assets/office3d/character-female-b.bin?url";
import femaleB from "../assets/office3d/character-female-b.gltf?url";
import femaleDBin from "../assets/office3d/character-female-d.bin?url";
import femaleD from "../assets/office3d/character-female-d.gltf?url";
import femaleFBin from "../assets/office3d/character-female-f.bin?url";
import femaleF from "../assets/office3d/character-female-f.gltf?url";
import maleABin from "../assets/office3d/character-male-a.bin?url";
import maleA from "../assets/office3d/character-male-a.gltf?url";
import maleBBin from "../assets/office3d/character-male-b.bin?url";
import maleB from "../assets/office3d/character-male-b.gltf?url";
import maleDBin from "../assets/office3d/character-male-d.bin?url";
import maleD from "../assets/office3d/character-male-d.gltf?url";
import colormapUrl from "../assets/office3d/colormap.png?url";
import monitorUrl from "../assets/office3d/computerScreen.glb?url";
import deskUrl from "../assets/office3d/desk.glb?url";
import counterUrl from "../assets/office3d/kitchenBar.glb?url";
import coffeeUrl from "../assets/office3d/kitchenCoffeeMachine.glb?url";
import lampUrl from "../assets/office3d/lampRoundFloor.glb?url";
import sofaUrl from "../assets/office3d/loungeSofa.glb?url";
import boardUrl from "../assets/office3d/paneling.glb?url";
import plantUrl from "../assets/office3d/pottedPlant.glb?url";
import rugUrl from "../assets/office3d/rugRectangle.glb?url";

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

// One URL per person; every person shares the same rig and clips.
export const CHARACTER_VARIANTS: readonly string[] = [maleA, femaleB, maleD, femaleF, maleB, femaleD];

// Clips each person carries; anything else (typing, watering) is animated by hand.
export const CHARACTER_CLIPS = ["idle", "walk", "sit", "interact-right", "pick-up", "emote-yes"] as const;

export const MODEL_URLS: Record<ModelId, string> = {
  desk: deskUrl,
  chair: chairUrl,
  shelf: shelfUrl,
  cabinet: cabinetUrl,
  plant: plantUrl,
  sofa: sofaUrl,
  coffee_machine: coffeeUrl,
  counter: counterUrl,
  // The board's glass reads as a whiteboard once the scene paints it white.
  whiteboard: whiteboardUrl,
  board: boardUrl,
  lamp: lampUrl,
  rug: rugUrl,
  monitor: monitorUrl,
  character: maleA,
};

// A .gltf names its buffer and texture by plain file name, but the build renames
// them with a content hash. The loader runs every URL through this to find them.
const SIDE_FILES: ReadonlyMap<string, string> = new Map([
  ["colormap.png", colormapUrl],
  ["character-male-a.bin", maleABin],
  ["character-male-b.bin", maleBBin],
  ["character-male-d.bin", maleDBin],
  ["character-female-b.bin", femaleBBin],
  ["character-female-d.bin", femaleDBin],
  ["character-female-f.bin", femaleFBin],
]);

export function resolveModelFile(url: string): string {
  return SIDE_FILES.get(url.slice(url.lastIndexOf("/") + 1)) ?? url;
}
