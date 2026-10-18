/**
 * Same-origin check for state-changing POSTs.
 *
 * A cross-origin auto-submitting form is a "simple request": no preflight, so
 * CORS does not stop it reaching the handler. Anything that acts on a POST body
 * and has a security consequence therefore has to check where the POST came
 * from.
 *
 * `Origin` decides it. Browsers set it on every POST and page script cannot
 * forge it, so a match against the target host means the form was served by us.
 * `Sec-Fetch-Site` is only the fallback for a caller that sent no `Origin`:
 * it describes the whole navigation chain rather than the form's own origin, so
 * a same-origin form submitted inside a popup that some other site opened can
 * carry `cross-site` — as Claude's connector flow does. Reading it first turned
 * a legitimate OAuth submit into a refusal.
 *
 * A non-browser caller sends neither and is allowed through, which is fine
 * because the attack needs a browser to be useful. `Origin: null` (a sandboxed
 * frame, a redirect-originated POST) fails to parse and is refused.
 *
 * The scheme counts as well as the host: a page on `http://` of our own host is
 * not us. Behind a TLS-terminating proxy the server sees plain http, so when
 * `publicUrl` names this host its origin is the one to match exactly. For any
 * other host, a trusted proxy's `X-Forwarded-Proto` (MEMRAIN_HTTP_TRUST_PROXY)
 * gives the scheme the browser used, and the origin must carry it. Without
 * that header, a request the server itself received over https must carry an
 * https origin, and plain http behind a proxy stays host-only.
 */
import { trustProxyHeaders } from "./client-key.ts";

export function isSameOriginPost(req: Request, url: URL, publicUrl?: string): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    try {
      const parsed = new URL(origin);
      // A browser sends a bare serialized origin. Anything carrying userinfo or
      // a path (`https://evil.example@brain.example/x`) parses to our host but
      // was never written by a browser, so refuse it rather than trust `host`.
      if (parsed.origin !== origin) return false;
      if (parsed.host !== url.host) return false;
      const configured = configuredOrigin(publicUrl);
      if (configured !== null && configured.host === url.host) return parsed.origin === configured.origin;
      const forwarded = trustedForwardedScheme(req);
      if (forwarded !== null) return parsed.protocol === forwarded;
      return url.protocol !== "https:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

/** The scheme a trusted proxy says the browser used, or null when unknown. */
function trustedForwardedScheme(req: Request): "https:" | "http:" | null {
  if (!trustProxyHeaders()) return null;
  const p = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return p === "https" || p === "http" ? `${p}:` : null;
}

function configuredOrigin(publicUrl: string | undefined): URL | null {
  const raw = (publicUrl ?? "").trim();
  if (raw.length === 0) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
