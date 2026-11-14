/**
 * The Google provider: OAuth 2.0 authorization code with PKCE against Google's
 * endpoints, read-only Calendar access, and the account identified by its
 * verified email from the OpenID userinfo endpoint.
 *
 * Scopes are the minimum: `openid email` to learn which account connected,
 * plus `calendar.readonly`. The connect flow refuses any grant that differs
 * from that set, so `include_granted_scopes` is never sent: it would fold in
 * scopes granted to the same client earlier and fail the exact-scope check.
 * `prompt=consent` makes Google issue a refresh token on a reconnect too; it
 * only issues one on the first consent otherwise.
 *
 * The client is the operator's own (MEMRAIN_GOOGLE_OAUTH_CLIENT_ID and
 * MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET, or a bring-your-own client stored sealed
 * in the vault, which wins), never a shared one.
 *
 * Refresh-token lifetime: while the client's consent screen is in "Testing"
 * with an External user type, Google expires a refresh token after 7 days
 * unless the only scopes are name, email and profile, and calendar.readonly is
 * not one of those. Such an account goes to `needs_reconnect` weekly until the
 * app is published. Google also keeps at most 100 refresh tokens per account
 * per client and silently invalidates the oldest past that.
 * (developers.google.com/identity/protocols/oauth2, "Refresh token expiration")
 */
import type { FetchFn } from "../client.ts";
import type { ConnectorProvider } from "../providers.ts";
import { googleCalendarAdapter, GOOGLE_API_ORIGIN } from "./calendar.ts";

export const GOOGLE_CALENDAR_READONLY = "https://www.googleapis.com/auth/calendar.readonly";
const GOOGLE_EMAIL_SCOPE_URL = "https://www.googleapis.com/auth/userinfo.email";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const IDENTITY_TIMEOUT_MS = 15_000;
const MAX_USERINFO_BYTES = 16 * 1024;

async function identify(fetch: FetchFn, accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_URL, {
    method: "GET",
    redirect: "manual",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`userinfo answered HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_USERINFO_BYTES) throw new Error("userinfo response is too large");
  const body = JSON.parse(text) as { email?: unknown; email_verified?: unknown };
  // An unverified address could name a mailbox the owner does not hold.
  if (typeof body.email !== "string" || body.email === "" || body.email_verified !== true) {
    throw new Error("userinfo has no verified email");
  }
  return body.email.trim().toLowerCase();
}

export function googleProvider(): ConnectorProvider {
  return {
    id: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    baseScopes: ["openid", "email"],
    services: {
      calendar: { scopes: [GOOGLE_CALENDAR_READONLY], sourceKinds: ["calendar"] },
    },
    authorizeParams: { access_type: "offline", prompt: "consent" },
    // Google answers the `email` request with the scope's full URL.
    normalizeScope: scope => (scope === GOOGLE_EMAIL_SCOPE_URL ? "email" : scope),
    identify: ({ fetch, accessToken }) => identify(fetch, accessToken),
    sync: {
      apiOrigin: GOOGLE_API_ORIGIN,
      adapter: (account, ctx) => googleCalendarAdapter(account, ctx),
    },
  };
}
