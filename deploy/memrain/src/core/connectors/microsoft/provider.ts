/**
 * The Microsoft provider: OAuth 2.0 authorization code with PKCE against the
 * Microsoft identity platform's v2.0 endpoints, read-only delegated Graph
 * access to Outlook mail and calendar, and the account identified by Graph
 * `/me`.
 *
 * Endpoints carry a tenant segment: `common` by default, or `organizations`,
 * `consumers`, a tenant id or a verified domain saved with the bring-your-own
 * client (or MEMRAIN_MICROSOFT_OAUTH_TENANT for the environment's client). An
 * app registered for one organization only must use its tenant id: such apps
 * cannot sign in through `/common` (AADSTS50194).
 *
 * Scopes are the minimum: `openid email offline_access User.Read` on every
 * connect (who connected, and a refresh token), plus `Mail.Read` for a mailbox
 * source and `Calendars.Read` for a calendar source. A scope without a
 * resource means Microsoft Graph, and the token response may spell it as the
 * full URL, may leave out the OpenID Connect scopes and may add `profile`
 * (learn.microsoft.com/entra/identity-platform/scopes-oidc); those differences
 * are not a mismatch.
 *
 * Consent is per user and client, not per token. Microsoft answers each grant
 * with every scope the user consented to for Graph, and offers no revocation
 * of a delegated grant to the app; so a calendar grant of a user whose mail
 * was connected (or disconnected) here still holds Mail.Read. Those read-only
 * scopes of the other service are accepted (`grantIncludesPriorConsent`); a
 * connect never asks for a service it is not connecting, so another user is
 * never asked for mail. A disconnect deletes the stored credential, and the
 * owner withdraws the consent at Microsoft (`consentUrls`).
 *
 * `prompt=select_account` shows the account picker even when one account is
 * signed in, so the owner does not connect the wrong mailbox by single
 * sign-on. Consent needs no prompt of its own: Microsoft asks for any
 * requested scope the user has not consented to yet
 * (learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow).
 *
 * Refresh tokens rotate: every renewal returns a new one, which replaces the
 * old (token-provider.ts stores it). A refresh token unused for 90 days
 * expires (AADSTS700082), and a password reset or an admin revocation ends it
 * (AADSTS50173); both answer `invalid_grant` and park the account as
 * needs_reconnect. A work tenant that does not let users consent refuses the
 * code exchange with AADSTS65001 or AADSTS90094, which the connect reports as
 * `admin_consent_required`.
 */
import { readTextCapped, type FetchFn } from "../client.ts";
import type { ConnectorProvider, ProviderConnectError } from "../providers.ts";

export const MICROSOFT_PROVIDER = "microsoft";
export const OUTLOOK_MAIL_SERVICE = "outlook_mail";
export const OUTLOOK_CALENDAR_SERVICE = "outlook_calendar";
export const GRAPH_API_ORIGIN = "https://graph.microsoft.com";
export const MICROSOFT_DEFAULT_TENANT = "common";

const GRAPH_RESOURCE = `${GRAPH_API_ORIGIN}/`;
const OIDC_SCOPES = ["openid", "email", "profile", "offline_access"] as const;
const KNOWN_SCOPES = ["User.Read", "Mail.Read", "Calendars.Read", ...OIDC_SCOPES] as const;
/** DelegationDoesNotExist, AdminConsentRequired, AdminConsentRequiredRequestAccess. */
const ADMIN_CONSENT_CODES = new Set([65001, 90094, 90095]);
const ME_URL = `${GRAPH_API_ORIGIN}/v1.0/me?$select=id,mail,userPrincipalName`;
const IDENTITY_TIMEOUT_MS = 15_000;
const MAX_ME_BYTES = 16 * 1024;
const ADDRESS_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** Graph's `https://graph.microsoft.com/Mail.Read`, or any casing of a known scope, in the spelling Memrain requests. */
function normalizeScope(raw: string): string {
  let scope = raw;
  if (scope.includes("%")) {
    try {
      scope = decodeURIComponent(scope);
    } catch {
      return raw;
    }
  }
  if (scope.toLowerCase().startsWith(GRAPH_RESOURCE)) scope = scope.slice(GRAPH_RESOURCE.length);
  return KNOWN_SCOPES.find((k) => k.toLowerCase() === scope.toLowerCase()) ?? scope;
}

function tokenErrorCode(body: Record<string, unknown>): ProviderConnectError | null {
  const codes = Array.isArray(body.error_codes) ? body.error_codes : [];
  return codes.some((c) => typeof c === "number" && ADMIN_CONSENT_CODES.has(c)) ? "admin_consent_required" : null;
}

function address(value: unknown): string | null {
  return typeof value === "string" && ADDRESS_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/**
 * The account's label: its user principal name, whose domain the tenant had
 * to verify, or the sign-in address of a personal account. A guest's UPN is a
 * rewritten `#EXT#` name, so a guest is labelled by its mail address instead.
 * The `mail` property is not used first: a tenant admin can set it to anything.
 */
async function identify(fetch: FetchFn, accessToken: string): Promise<string> {
  const res = await fetch(ME_URL, {
    method: "GET",
    redirect: "manual",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`Graph /me answered HTTP ${res.status}`);
  const text = await readTextCapped(res, MAX_ME_BYTES);
  if (text === null) throw new Error("Graph /me response is too large");
  const body = JSON.parse(text) as { id?: unknown; mail?: unknown; userPrincipalName?: unknown };
  if (typeof body.id !== "string" || body.id === "") throw new Error("Graph /me has no id");
  const upn = typeof body.userPrincipalName === "string" && !body.userPrincipalName.includes("#EXT#") ? address(body.userPrincipalName) : null;
  const label = upn ?? address(body.mail);
  if (label === null) throw new Error("Graph /me has no usable address");
  return label;
}

export function microsoftProvider(): ConnectorProvider {
  return {
    id: MICROSOFT_PROVIDER,
    authorizeUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
    tenant: { default: MICROSOFT_DEFAULT_TENANT },
    baseScopes: ["openid", "email", "offline_access", "User.Read"],
    services: {
      [OUTLOOK_MAIL_SERVICE]: { scopes: ["Mail.Read"], sourceKinds: ["mailbox"] },
      [OUTLOOK_CALENDAR_SERVICE]: { scopes: ["Calendars.Read"], sourceKinds: ["calendar"] },
    },
    authorizeParams: { prompt: "select_account" },
    optionalGrantScopes: OIDC_SCOPES,
    grantIncludesPriorConsent: true,
    tokenErrorCode,
    consentUrls: ["https://myapps.microsoft.com", "https://account.live.com/consent/Manage"],
    normalizeScope,
    identify: ({ fetch, accessToken }) => identify(fetch, accessToken),
  };
}
