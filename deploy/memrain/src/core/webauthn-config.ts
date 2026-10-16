/**
 * The WebAuthn relying party for the admin panel, taken from the configured
 * public URL and from nothing else.
 *
 * The rpID scopes every passkey: a browser hands a credential only to pages
 * whose host is the rpID or below it. Deriving it from `Host` or a forwarded
 * header would let whoever controls that header pick the scope, so there is no
 * request input here at all, and no fallback when the URL is unset. The rpID is
 * the full hostname, never a parent domain, so a sibling site under the same
 * registrable domain cannot use the owner's passkeys.
 *
 * Changing the hostname of MEMRAIN_PUBLIC_URL later orphans every passkey.
 */

export interface RelyingParty {
  rpID: string;
  /** Exact origin (scheme, host, port) the browser must report. */
  origin: string;
  rpName: string;
}

export type RelyingPartyUnavailable =
  | "public_url_unset"
  | "public_url_not_https"
  | "public_url_invalid";

export type RelyingPartyResult = RelyingParty | { error: RelyingPartyUnavailable };

const RP_NAME = "memrain";

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[")) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

export function resolveRelyingParty(publicUrl: string | undefined | null): RelyingPartyResult {
  const raw = (publicUrl ?? "").trim();
  if (raw.length === 0) return { error: "public_url_unset" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: "public_url_invalid" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "public_url_invalid" };
  const hostname = u.hostname.toLowerCase();
  if (hostname.length === 0 || isIpLiteral(hostname)) return { error: "public_url_invalid" };
  if (u.protocol === "http:" && hostname !== "localhost") return { error: "public_url_not_https" };
  return { rpID: hostname, origin: u.origin, rpName: RP_NAME };
}

export function isRelyingParty(r: RelyingPartyResult): r is RelyingParty {
  return !("error" in r);
}
