// Per-browser conveniences only. Storage can be missing or throw (private
// windows, blocked site data), so every access falls back.

export function browserStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}
