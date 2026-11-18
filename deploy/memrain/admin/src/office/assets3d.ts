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
import { CHARACTER_FILES, MODEL_FILES, sideFileOf, type ModelId, type ProceduralModelId } from "./asset-names.ts";

export type { ModelId } from "./asset-names.ts";

// The build renames every file with a content hash; this maps each plain name to it.
const BUILT: ReadonlyMap<string, string> = new Map([
  ["bookcaseClosedDoors.glb", cabinetUrl],
  ["bookcaseOpen.glb", shelfUrl],
  ["chairDesk.glb", chairUrl],
  ["character-female-b.bin", femaleBBin],
  ["character-female-b.gltf", femaleB],
  ["character-female-d.bin", femaleDBin],
  ["character-female-d.gltf", femaleD],
  ["character-female-f.bin", femaleFBin],
  ["character-female-f.gltf", femaleF],
  ["character-male-a.bin", maleABin],
  ["character-male-a.gltf", maleA],
  ["character-male-b.bin", maleBBin],
  ["character-male-b.gltf", maleB],
  ["character-male-d.bin", maleDBin],
  ["character-male-d.gltf", maleD],
  ["colormap.png", colormapUrl],
  ["computerScreen.glb", monitorUrl],
  ["desk.glb", deskUrl],
  ["kitchenBar.glb", counterUrl],
  ["kitchenCoffeeMachine.glb", coffeeUrl],
  ["lampRoundFloor.glb", lampUrl],
  ["loungeSofa.glb", sofaUrl],
  ["paneling.glb", boardUrl],
  ["pottedPlant.glb", plantUrl],
  ["rugRectangle.glb", rugUrl],
]);

function built(name: string): string {
  const url = BUILT.get(name);
  if (!url) throw new Error(`office: ${name} is not imported in assets3d.ts`);
  return url;
}

export const CHARACTER_VARIANTS: readonly string[] = CHARACTER_FILES.map(built);

export const MODEL_URLS = Object.fromEntries(
  (Object.keys(MODEL_FILES) as Exclude<ModelId, ProceduralModelId>[]).map((id) => [id, built(MODEL_FILES[id])]),
) as Record<Exclude<ModelId, ProceduralModelId>, string>;

// A .gltf names its buffer and texture by plain file name; the loader runs every
// URL through this to find their built names.
export function resolveModelFile(url: string): string {
  const side = sideFileOf(url);
  return side ? built(side) : url;
}
