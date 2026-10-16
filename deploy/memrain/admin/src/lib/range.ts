// The Overview trend range, remembered per browser. Storage can be missing or
// throw (private windows, blocked site data), so every access falls back.

export type RangeDays = 7 | 30 | 90;

export const RANGES: readonly RangeDays[] = [7, 30, 90];
const KEY = "memrain.admin.range";

export function readRange(storage: Pick<Storage, "getItem"> | null): RangeDays {
  try {
    const v = Number(storage?.getItem(KEY));
    return (RANGES as readonly number[]).includes(v) ? (v as RangeDays) : 30;
  } catch {
    return 30;
  }
}

export function writeRange(storage: Pick<Storage, "setItem"> | null, d: RangeDays): void {
  try {
    storage?.setItem(KEY, String(d));
  } catch { /* not remembered; the picker still works */ }
}

export function browserStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}
