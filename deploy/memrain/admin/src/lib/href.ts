import { buildHash } from "./route.ts";

export type SafeHref = { kind: "internal"; hash: string } | { kind: "external"; href: string } | null;

const SLUG_RE = /^[a-z0-9][\w/.-]*$/i;
const EXTERNAL_PROTOCOLS = ["http:", "https:", "mailto:"];

export function isSlug(s: string): boolean {
  return SLUG_RE.test(s) && !s.includes("//");
}

// A link target from stored page text. Slugs stay inside the panel; anything
// else must parse as an absolute URL on an allowed scheme. URL parsing with no
// base rejects protocol-relative and backslash hosts, and it normalises the
// control-character and mixed-case `javascript:` variants before the scheme
// check, so the check sees what the browser would.
export function safeHref(raw: string): SafeHref {
  const s = raw.trim();
  if (s.length === 0 || s.length > 2048) return null;
  if (isSlug(s)) return { kind: "internal", hash: buildHash({ name: "page", param: s }) };
  try {
    const u = new URL(s);
    return EXTERNAL_PROTOCOLS.includes(u.protocol) ? { kind: "external", href: u.href } : null;
  } catch {
    return null;
  }
}
