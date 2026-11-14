// Owner notifications in the panel: the sidebar badge, the kind labels and
// the id a `#notifications/<id>` link points at. Kept free of DOM and React so
// the root test runner can load it.

const LABELS: Record<string, string> = {
  needs_reconnect: "Connector needs a reconnect",
  deletions_held: "Deletions held",
  items_held: "Connector items held",
  spend_path_paused: "Spend path paused",
  daemon_auto_paused: "Daemon auto-paused",
  write_gate_hold: "Writes held by the write gate",
};

export function kindLabel(kind: string): string {
  return LABELS[kind] ?? kind;
}

/** Unread open notifications for the sidebar badge; empty when there are none. */
export function badgeText(summary: { open: number; unread: number } | null): string {
  const n = summary?.unread;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

/** The notification a route parameter names, or null for anything but a positive integer id. */
export function linkedNotificationId(param: string | null): number | null {
  if (param === null || !/^[1-9]\d{0,15}$/.test(param)) return null;
  const n = Number(param);
  return Number.isSafeInteger(n) ? n : null;
}
