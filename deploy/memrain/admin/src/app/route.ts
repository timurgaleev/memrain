// The member app's hash routes. No DOM or React, so the root test runner can
// load it.

export type AppRouteName = "login" | "invite" | "start" | "ask" | "data";
export interface AppRoute { name: AppRouteName; param: string | null }

const NAMES: ReadonlySet<string> = new Set<AppRouteName>(["login", "invite", "start", "ask", "data"]);
const TOKEN_RE = /^[\w-]{43}$/;

/** Unknown routes (an operator page's link, say) land on the start page. */
export function parseAppHash(hash: string): AppRoute {
  let s = hash.startsWith("#") ? hash.slice(1) : hash;
  if (s.startsWith("/")) s = s.slice(1);
  const cut = s.indexOf("/");
  const head = cut === -1 ? s : s.slice(0, cut);
  const rest = cut === -1 ? "" : s.slice(cut + 1);
  const name = NAMES.has(head) ? (head as AppRouteName) : "start";
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

/** The invite token of `/app/invite#<token>`, or null. */
export function takeInviteFromUrl(loc: { pathname: string; hash: string }): string | null {
  if (!/\/app\/invite\/?$/.test(loc.pathname)) return null;
  const token = loc.hash.replace(/^#\/?/, "");
  return TOKEN_RE.test(token) ? token : null;
}
