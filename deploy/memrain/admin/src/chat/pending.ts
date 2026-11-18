// A question handed to the Ask page from elsewhere in the panel (the command
// palette). It only fills the question box: asking costs money, so sending
// stays the operator's click. Held in memory, never in the URL.

let pending: string | null = null;
const listeners = new Set<() => void>();

export function setPendingQuestion(q: string): void {
  pending = q;
  for (const l of listeners) l();
}

export function takePendingQuestion(): string | null {
  const q = pending;
  pending = null;
  return q;
}

/** Calls `fn` whenever a question is handed over, for a page that is already open. */
export function onPendingQuestion(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
