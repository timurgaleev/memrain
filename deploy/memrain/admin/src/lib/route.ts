// Hash routes carry an optional parameter (a slug, a query or a date) after
// the first "/". Kept free of DOM and React so the root test runner can load it.

export type RouteName =
  | "login" | "overview" | "ask" | "office" | "search" | "pages" | "page" | "entity" | "graph"
  | "timeline" | "spend" | "agents" | "log" | "jobs" | "calibration" | "glossary" | "setup"
  | "enroll" | "security" | "notifications" | "connections" | "autonomy" | "approvals" | "labelling";

/** `quote` is a passage a page link asks the page view to highlight (`#page/<slug>?q=<quote>`). */
export interface Route { name: RouteName; param: string | null; quote?: string }

const NAMES: ReadonlySet<string> = new Set<RouteName>([
  "login", "overview", "ask", "office", "search", "pages", "page", "entity", "graph",
  "timeline", "spend", "agents", "log", "jobs", "calibration", "glossary", "setup",
  "enroll", "security", "notifications", "connections", "autonomy", "approvals", "labelling",
]);

export function parseHash(hash: string): Route {
  let s = hash.startsWith("#") ? hash.slice(1) : hash;
  if (s.startsWith("/")) s = s.slice(1);
  const cut = s.indexOf("/");
  const head = cut === -1 ? s : s.slice(0, cut);
  let rest = cut === -1 ? "" : s.slice(cut + 1);
  // `#dashboard` bookmarks predate the Overview page.
  const name: RouteName = head === "" || head === "dashboard" || !NAMES.has(head) ? "overview" : (head as RouteName);
  // A page link's quote follows the first raw "?": buildHash encodes any "?" in the slug.
  let quote = "";
  const ask = name === "page" ? rest.indexOf("?") : -1;
  if (ask !== -1) {
    const q = rest.slice(ask + 1).split("&").find((kv) => kv.startsWith("q="));
    quote = q === undefined ? "" : decoded(q.slice(2)) ?? "";
    rest = rest.slice(0, ask);
  }
  const param = rest === "" ? null : decoded(rest);
  return quote === "" ? { name, param } : { name, param, quote };
}

function decoded(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export function buildHash(r: Route): string {
  if (r.param === null || r.param === "") return `#${r.name}`;
  const quote = r.name === "page" && r.quote ? `?q=${encodeURIComponent(r.quote)}` : "";
  return `#${r.name}/${encodeURIComponent(r.param)}${quote}`;
}
