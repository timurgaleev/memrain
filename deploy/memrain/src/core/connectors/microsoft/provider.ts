/**
 * The Microsoft provider: OAuth 2.0 authorization code with PKCE against the
 * Microsoft identity platform's v2.0 endpoints, read-only Graph access, and
 * the account identified by its Graph mail address.
 *
 * Scopes are the minimum: `openid email offline_access User.Read` to learn
 * which account connected and to receive a refresh token (one is issued only
 * when `offline_access` is asked for), plus `Calendars.Read` for a calendar
 * source. All of them are delegated permissions a user may consent to for
 * themselves; a work tenant whose admin turned user consent off answers the
 * consent with an error until an admin consents for the tenant (see
 * docs/connectors/MICROSOFT.md).
 *
 * The token response's `scope` lists Graph's own scopes only, in Graph's
 * spelling, and leaves the OpenID ones out (or adds `profile`)
 * (learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow), so
 * the OpenID scopes are not part of the exact-scope check. A token also
 * carries every Graph scope the user already granted this app, as Google's
 * combined grants do, so a connect asks for the scopes the brain's other
 * Microsoft accounts hold too.
 *
 * The tenant segment is `common` (work, school and personal accounts) unless
 * MEMRAIN_MICROSOFT_TENANT names `organizations`, `consumers` or one tenant.
 * Refresh tokens of a web app have no fixed lifetime and are rotated on use;
 * one that expires or is revoked parks the account in `needs_reconnect`.
 * The identity platform has no RFC 7009 endpoint for a delegated refresh
 * token, so a disconnect cannot revoke it: the owner removes the app's access
 * from their account (myapps.microsoft.com or account.live.com/consent).
 *
 * The client is the operator's own (MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID and
 * MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET, or a bring-your-own client stored
 * sealed in the vault, which wins), never a shared one.
 */
import type { FetchFn } from "../client.ts";
import type { ConnectorProvider } from "../providers.ts";
import { OUTLOOK_PREFER, outlookCalendarAdapter } from "./calendar.ts";
import { GRAPH_ORIGIN } from "./graph-client.ts";

export const MICROSOFT_CALENDARS_READ = "Calendars.Read";
const USER_READ = "User.Read";
/** The OpenID scopes a token response leaves out of, or adds to, its `scope`. */
const OPENID_SCOPES = ["openid", "email", "offline_access", "profile"] as const;
/** Every Graph scope this provider ever asks for, in its canonical spelling. */
const GRAPH_SCOPES = [USER_READ, MICROSOFT_CALENDARS_READ];
const GRAPH_SCOPE_PREFIX = "https://graph.microsoft.com/";
const ME_URL = `${GRAPH_ORIGIN}/v1.0/me?$select=mail,userPrincipalName`;
const IDENTITY_TIMEOUT_MS = 15_000;
const MAX_ME_BYTES = 16 * 1024;
const TENANT_RE = /^(?:common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;

/** The tenant segment of the identity platform's URLs: `common` by default, null for a value that is not a tenant. */
export function microsoftTenant(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.MEMRAIN_MICROSOFT_TENANT;
  if (raw === undefined) return "common";
  const t = raw.trim();
  return TENANT_RE.test(t) ? t : null;
}

/** Graph's spelling of a granted scope as it was asked for. */
function normalizeScope(scope: string): string {
  const bare = scope.toLowerCase().startsWith(GRAPH_SCOPE_PREFIX) ? scope.slice(GRAPH_SCOPE_PREFIX.length) : scope;
  return GRAPH_SCOPES.find(s => s.toLowerCase() === bare.toLowerCase()) ?? bare;
}

/** One `@`, a non-empty local part, a dotted domain, no whitespace. */
function isAddress(v: string): boolean {
  const at = v.indexOf("@");
  if (v.length > 320 || /\s/.test(v) || at <= 0 || at !== v.lastIndexOf("@")) return false;
  const domain = v.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

async function identify(fetch: FetchFn, accessToken: string): Promise<string> {
  const res = await fetch(ME_URL, {
    method: "GET",
    redirect: "manual",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`Graph /me answered HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_ME_BYTES) throw new Error("Graph /me response is too large");
  const body = JSON.parse(text) as { mail?: unknown; userPrincipalName?: unknown };
  // A work account's mail is its primary SMTP address, which attendee lists
  // use; a personal account has none and signs in with its address.
  const address = [body.mail, body.userPrincipalName].find((v): v is string => typeof v === "string" && isAddress(v.trim()));
  if (address === undefined) throw new Error("Graph /me names no mail address");
  return address.trim().toLowerCase();
}

export function microsoftProvider(tenant = "common"): ConnectorProvider {
  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  return {
    id: "microsoft",
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    baseScopes: ["openid", "email", "offline_access", USER_READ],
    services: {
      calendar: { scopes: [MICROSOFT_CALENDARS_READ], sourceKinds: ["calendar"], headers: { Prefer: OUTLOOK_PREFER } },
    },
    combinedGrants: true,
    unreportedScopes: OPENID_SCOPES,
    authorizeParams: { response_mode: "query", prompt: "select_account" },
    normalizeScope,
    identify: ({ fetch, accessToken }) => identify(fetch, accessToken),
    sync: { apiOrigin: GRAPH_ORIGIN, adapter: (account, ctx) => outlookCalendarAdapter(account, ctx) },
  };
}
