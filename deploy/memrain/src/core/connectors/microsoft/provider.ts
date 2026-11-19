/**
 * The Microsoft provider: OAuth 2.0 authorization code with PKCE against the
 * Microsoft identity platform's v2.0 endpoints, read-only delegated Graph
 * access to Outlook mail and calendar and to Teams chats and meeting
 * transcripts, and the account identified by Graph `/me`.
 *
 * Endpoints carry a tenant segment: `common` by default, or `organizations`,
 * `consumers`, a tenant id or a verified domain saved with the bring-your-own
 * client (or MEMRAIN_MICROSOFT_OAUTH_TENANT for the environment's client). An
 * app registered for one organization only must use its tenant id: such apps
 * cannot sign in through `/common` (AADSTS50194).
 *
 * Scopes are the minimum: `openid email offline_access User.Read` on every
 * connect (who connected, and a refresh token), plus `Mail.Read` for a mailbox
 * source and `Calendars.Read` for a calendar source. Teams is added on its
 * own, so a mail or calendar connect never asks for it: `Chat.Read` for a
 * chat source, and for a meeting source `OnlineMeetings.Read` and
 * `OnlineMeetingTranscript.Read.All` (which only an administrator can
 * consent to) plus `Calendars.Read`, through which the meetings are found
 * (teams-transcripts.ts). A scope without a
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
 * `admin_consent_required`. Microsoft may refuse already at the redirect URI
 * instead (`access_denied` or `consent_required`); that response carries
 * only `error` and `error_description`, no numeric `error_codes`
 * (v2-oauth2-auth-code-flow, "Error response"), so the code is read from the
 * `AADSTS<n>:` the description opens with, never from its prose. AADSTS65004
 * there is `consent_declined`: a Cancel, or the end of a request for an
 * administrator's approval. Microsoft says its codes can change, so they
 * only choose a clearer message; any other code is a plain refusal.
 */
import { readTextCapped, type FetchFn } from "../client.ts";
import type { ConnectorProvider, ProviderConnectError, ProviderIdentity } from "../providers.ts";
import { OUTLOOK_CALENDAR_SERVICE, outlookCalendarAdapter } from "./calendar.ts";
import { GRAPH_API_ORIGIN } from "./graph-client.ts";
import { OUTLOOK_MAIL_SERVICE, outlookMailAdapter, outlookMailService } from "./mail.ts";
import { TEAMS_CHAT_SERVICE, teamsChatAdapter } from "./teams-chat.ts";
import { TEAMS_TRANSCRIPTS_SERVICE, teamsTranscriptsAdapter } from "./teams-transcripts.ts";

export { GRAPH_API_ORIGIN } from "./graph-client.ts";
export { OUTLOOK_CALENDAR_SERVICE } from "./calendar.ts";
export { OUTLOOK_MAIL_SERVICE } from "./mail.ts";

export const MICROSOFT_PROVIDER = "microsoft";
export const MICROSOFT_DEFAULT_TENANT = "common";
export const MICROSOFT_CALENDARS_READ = "Calendars.Read";

const GRAPH_RESOURCE = `${GRAPH_API_ORIGIN}/`;
const OIDC_SCOPES = ["openid", "email", "profile", "offline_access"] as const;
export const TEAMS_CHAT_READ = "Chat.Read";
export const ONLINE_MEETINGS_READ = "OnlineMeetings.Read";
export const MEETING_TRANSCRIPTS_READ = "OnlineMeetingTranscript.Read.All";
const KNOWN_SCOPES = [
  "User.Read", "Mail.Read", MICROSOFT_CALENDARS_READ, TEAMS_CHAT_READ, ONLINE_MEETINGS_READ, MEETING_TRANSCRIPTS_READ, ...OIDC_SCOPES,
] as const;
/**
 * DelegationDoesNotExist, a tenant policy that keeps consent for an
 * administrator (90093), AdminConsentRequired, AdminConsentRequiredRequestAccess,
 * and an app Microsoft deems risky, which only an administrator may consent to
 * (900941; 900981 with the admin consent workflow on).
 */
const ADMIN_CONSENT_CODES = new Set([65001, 90093, 90094, 90095, 900941, 900981]);
/**
 * UserDeclinedConsent: the owner chose Cancel, or asked an administrator for
 * approval and chose "Back to app" afterwards, which Microsoft also answers
 * with 65004 (learn.microsoft.com/entra/identity/enterprise-apps/
 * application-sign-in-unexpected-user-consent-error).
 */
const DECLINED_CONSENT_CODE = 65004;
const ME_URL = `${GRAPH_API_ORIGIN}/v1.0/me?$select=id,mail,userPrincipalName`;
const IDENTITY_TIMEOUT_MS = 15_000;
const MAX_ME_BYTES = 16 * 1024;
const ADDRESS_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
/** A Graph user id: a directory object's GUID, or a personal account's hex id. */
const USER_ID_RE = /^[\w-]{1,128}$/;
/** A sign-in name shown as a label: printable, no spaces, bounded. */
const SIGN_IN_RE = /^[\x21-\x7E]{1,320}$/;

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

/** The AADSTS code an error description opens with: `AADSTS65001: The user or administrator ...`. */
const LEADING_AADSTS_RE = /^AADSTS(\d{4,6}):/;

function callbackErrorCode(params: { description: string | null }): ProviderConnectError | null {
  const m = LEADING_AADSTS_RE.exec((params.description ?? "").trim());
  if (m === null) return null;
  const code = Number(m[1]);
  if (ADMIN_CONSENT_CODES.has(code)) return "admin_consent_required";
  return code === DECLINED_CONSENT_CODE ? "consent_declined" : null;
}

function address(value: unknown): string | null {
  return typeof value === "string" && ADDRESS_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/**
 * The account's label: its user principal name, whose domain the tenant had
 * to verify, or the sign-in address of a personal account. A guest's UPN is a
 * rewritten `#EXT#` name, so a guest is labelled by its mail address instead.
 * The `mail` property is not used first: a tenant admin can set it to anything.
 *
 * The mailbox address is `mail`, else the label. A work account's UPN need not
 * receive mail (`o.wner@corp` signs in, `owner@` gets the mail), and mail,
 * calendar owners and attendees name the account by its mailbox address, so
 * telling the account's own mail and calendars apart compares that address
 * too. It identifies nothing: the label stays the account's identity.
 *
 * Graph's `id` comes back as the user id: a personal and a work account can
 * share one address (a Microsoft account made with a work address), and only
 * the id tells them apart. An account with no address at all, a personal one
 * that signs in with a phone number, is labelled by that sign-in name, else
 * its id, and says it had none.
 */
async function identify(fetch: FetchFn, accessToken: string): Promise<ProviderIdentity> {
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
  if (typeof body.id !== "string" || !USER_ID_RE.test(body.id)) throw new Error("Graph /me has no id");
  const signIn = typeof body.userPrincipalName === "string" && !body.userPrincipalName.includes("#EXT#") ? body.userPrincipalName.trim() : "";
  const upn = address(signIn);
  const mail = address(body.mail);
  const label = upn ?? mail;
  if (label !== null) return { label, mailbox: mail ?? label, userId: body.id };
  // A personal account that signs in with a phone number has neither: its
  // sign-in name labels it, else its id, and nothing names its mailbox.
  return { label: SIGN_IN_RE.test(signIn) ? signIn : body.id, userId: body.id, noAddress: true };
}

export function microsoftProvider(): ConnectorProvider {
  return {
    id: MICROSOFT_PROVIDER,
    authorizeUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
    tenant: { default: MICROSOFT_DEFAULT_TENANT },
    baseScopes: ["openid", "email", "offline_access", "User.Read"],
    services: {
      [OUTLOOK_MAIL_SERVICE]: outlookMailService,
      [OUTLOOK_CALENDAR_SERVICE]: { scopes: [MICROSOFT_CALENDARS_READ], sourceKinds: ["calendar"] },
      [TEAMS_CHAT_SERVICE]: { scopes: [TEAMS_CHAT_READ], sourceKinds: ["chat"] },
      [TEAMS_TRANSCRIPTS_SERVICE]: { scopes: [MICROSOFT_CALENDARS_READ, ONLINE_MEETINGS_READ, MEETING_TRANSCRIPTS_READ], sourceKinds: ["meeting"] },
    },
    authorizeParams: { response_mode: "query", prompt: "select_account" },
    optionalGrantScopes: OIDC_SCOPES,
    grantIncludesPriorConsent: true,
    tokenErrorCode,
    callbackErrorCode,
    consentUrls: ["https://myapplications.microsoft.com", "https://account.microsoft.com/privacy/app-access"],
    normalizeScope,
    identify: ({ fetch, accessToken }) => identify(fetch, accessToken),
    sync: {
      apiOrigin: GRAPH_API_ORIGIN,
      adapter: (account, ctx) => {
        const services = account.services ?? [];
        if (services.includes(OUTLOOK_MAIL_SERVICE)) return outlookMailAdapter(account, ctx);
        if (services.includes(TEAMS_CHAT_SERVICE)) return teamsChatAdapter(account, ctx);
        if (services.includes(TEAMS_TRANSCRIPTS_SERVICE)) return teamsTranscriptsAdapter(account, ctx);
        return outlookCalendarAdapter(account, ctx);
      },
    },
  };
}
