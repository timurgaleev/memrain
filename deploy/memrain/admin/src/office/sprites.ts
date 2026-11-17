import charactersUrl from "../assets/office/characters.png";
import indoorUrl from "../assets/office/indoor.png";

export interface Sprites {
  tiles: HTMLImageElement;
  people: HTMLImageElement;
}

// Both sheets lay out 16px cells with a 1px gap.
export const SHEET_STEP = 17;

// The character sheet's ready-dressed villagers sit in columns 0-1, rows 5-10.
export const PEOPLE_COUNT = 12;

export function personCell(index: number): readonly [number, number] {
  const i = ((index % PEOPLE_COUNT) + PEOPLE_COUNT) % PEOPLE_COUNT;
  return [i % 2, 5 + Math.floor(i / 2)];
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load office sprite ${src}`));
    img.src = src;
  });
}

export async function loadSprites(): Promise<Sprites> {
  const [tiles, people] = await Promise.all([load(indoorUrl), load(charactersUrl)]);
  return { tiles, people };
}
