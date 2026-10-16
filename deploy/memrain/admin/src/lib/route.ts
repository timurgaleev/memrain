// Hash routes carry an optional parameter (a slug, a query or a date) after
// the first "/". Kept free of DOM and React so the root test runner can load it.

export type RouteName =
  | "login" | "overview" | "search" | "pages" | "page" | "entity" | "graph"
  | "timeline" | "spend" | "agents" | "log" | "jobs" | "calibration" | "glossary" | "setup"
  | "enroll" | "security";

export interface Route { name: RouteName; param: string | null }

const NAMES: ReadonlySet<string> = new Set<RouteName>([
  "login", "overview", "search", "pages", "page", "entity", "graph",
  "timeline", "spend", "agents", "log", "jobs", "calibration", "glossary", "setup",
  "enroll", "security",
]);

export function parseHash(hash: string): Route {
  let s = hash.startsWith("#") ? hash.slice(1) : hash;
  if (s.startsWith("/")) s = s.slice(1);
  const cut = s.indexOf("/");
  const head = cut === -1 ? s : s.slice(0, cut);
  const rest = cut === -1 ? "" : s.slice(cut + 1);
  // `#dashboard` bookmarks predate the Overview page.
  const name: RouteName = head === "" || head === "dashboard" || !NAMES.has(head) ? "overview" : (head as RouteName);
  let param: string | null = null;
  if (rest !== "") {
    try {
      param = decodeURIComponent(rest);
    } catch {
      param = null;
    }
  }
  return { name, param };
}

export function buildHash(r: Route): string {
  return r.param === null || r.param === "" ? `#${r.name}` : `#${r.name}/${encodeURIComponent(r.param)}`;
}
