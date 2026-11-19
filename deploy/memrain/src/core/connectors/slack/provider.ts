/**
 * The Slack provider: a bot token for the operator's own Slack app, read-only.
 *
 * Two ways in, both ending in one sealed bot token per workspace:
 *
 *   - OAuth v2 (slack.com/oauth/v2/authorize, then oauth.v2.access) with the
 *     operator's app (MEMRAIN_SLACK_OAUTH_CLIENT_ID / _SECRET, or a
 *     bring-your-own app saved in the admin, which wins). The app holds a
 *     client secret and is not opted into PKCE, which Slack would refuse
 *     (`pkce_not_allowed`), so no code challenge is sent. Slack takes the bot
 *     scopes comma-separated and answers the code exchange with HTTP 200 and
 *     `ok: false` on failure, which the connect flow reads as a failed exchange.
 *   - A bot token pasted from an internal app's "OAuth & Permissions" page,
 *     checked with auth.test before it is stored. Slack lists the token's
 *     scopes in the X-OAuth-Scopes header; a token that can do more than read
 *     channels and users is refused.
 *
 * Scopes: `channels:history channels:read users:read` for public channels,
 * plus `groups:history groups:read` only when private channels are ticked.
 * Slack adds every scope the app was ever granted in the workspace to a new
 * grant, so a grant may carry the private-channel scopes on top of a public
 * request (`grantIncludesPriorConsent`); a write scope is refused all the same.
 * Direct messages are never read: a bot only sees the DMs sent to it.
 *
 * The account is the workspace: labelled by its name, pinned by its team id,
 * so a reconnect into another workspace is refused. The app has one bot token
 * per workspace, so a token is never revoked while another live account of
 * the same workspace holds it (`tokenPerIdentity`). Bot tokens do not expire
 * unless the app opts into token rotation; with rotation off nothing renews.
 * Disconnecting calls auth.revoke with the token itself, which needs no app.
 *
 * Rate limits: conversations.history, conversations.replies and
 * conversations.info are Tier 3 (about 50 a minute) for an internal app, so an
 * account's requests are spaced 1.2 s apart. Apps distributed outside the
 * Slack Marketplace get far lower history limits; the setup guide says to
 * keep the app internal to the workspace.
 */
import type { FetchFn } from "../client.ts";
import { readTextCapped } from "../client.ts";
import type { ConnectorProvider, ProviderIdentity } from "../providers.ts";
import { SLACK_API_ORIGIN } from "./api.ts";
import { SLACK_PRIVATE_SERVICE, SLACK_SERVICE, slackAdapter } from "./adapter.ts";

export { SLACK_API_ORIGIN };
export const SLACK_PUBLIC_SCOPES = ["channels:history", "channels:read", "users:read"] as const;
export const SLACK_PRIVATE_SCOPES = ["groups:history", "groups:read"] as const;
/** Tier 3 is about 50 requests a minute per method and workspace. */
export const SLACK_MIN_SPACING_MS = 1_200;
const TIMEOUT_MS = 15_000;
const MAX_BODY = 64 * 1024;
const BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{10,250}$/;

/** Why a pasted token was not taken, as a code the admin page puts into words. */
export class SlackTokenError extends Error {
  constructor(readonly code: "key_invalid" | "key_rejected" | "scope_mismatch" | "identity" | "provider_unavailable") {
    super(`slack token refused (${code})`);
    this.name = "SlackTokenError";
  }
}

interface AuthTest {
  team: string;
  teamId: string;
  /** The token's scopes from X-OAuth-Scopes; null when Slack did not send the header. */
  scopes: string[] | null;
}

/** auth.test with a bot token: who it belongs to and what it may do. */
async function authTest(fetch: FetchFn, token: string): Promise<AuthTest> {
  let res: Response;
  try {
    res = await fetch(`${SLACK_API_ORIGIN}/api/auth.test`, {
      method: "GET",
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SlackTokenError("provider_unavailable");
  }
  if (res.status !== 200) throw new SlackTokenError(res.status === 429 || res.status >= 500 ? "provider_unavailable" : "key_rejected");
  const text = await readTextCapped(res, MAX_BODY);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text ?? "") as Record<string, unknown>;
  } catch {
    throw new SlackTokenError("provider_unavailable");
  }
  if (body.ok !== true) throw new SlackTokenError("key_rejected");
  // A bot token names its bot; a user token does not.
  if (typeof body.bot_id !== "string" || body.bot_id === "") throw new SlackTokenError("key_invalid");
  const team = typeof body.team === "string" ? body.team.trim() : "";
  const teamId = typeof body.team_id === "string" ? body.team_id.trim() : "";
  if (team === "" || !/^[TE][A-Z0-9]{2,30}$/.test(teamId)) throw new SlackTokenError("identity");
  const header = res.headers.get("x-oauth-scopes");
  const scopes = header === null ? null : [...new Set(header.split(",").map(s => s.trim()).filter(s => s !== ""))];
  return { team, teamId, scopes };
}

/** The services a token's scopes cover; null when they are anything but read-only channel and user scopes. */
export function servicesForScopes(scopes: readonly string[]): string[] | null {
  const allowed = new Set<string>([...SLACK_PUBLIC_SCOPES, ...SLACK_PRIVATE_SCOPES]);
  if (scopes.some(s => !allowed.has(s))) return null;
  if (!SLACK_PUBLIC_SCOPES.every(s => scopes.includes(s))) return null;
  return SLACK_PRIVATE_SCOPES.every(s => scopes.includes(s)) ? [SLACK_SERVICE, SLACK_PRIVATE_SERVICE] : [SLACK_SERVICE];
}

async function revokeToken(fetch: FetchFn, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${SLACK_API_ORIGIN}/api/auth.revoke`, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: "",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) return false;
    const body = JSON.parse((await readTextCapped(res, MAX_BODY)) ?? "") as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

export function slackProvider(): ConnectorProvider {
  return {
    id: "slack",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    baseScopes: [],
    services: {
      [SLACK_SERVICE]: { scopes: [...SLACK_PUBLIC_SCOPES], sourceKinds: ["chat"], minSpacingMs: SLACK_MIN_SPACING_MS },
      [SLACK_PRIVATE_SERVICE]: { scopes: [...SLACK_PRIVATE_SCOPES], sourceKinds: ["chat"], minSpacingMs: SLACK_MIN_SPACING_MS, optIn: true },
    },
    pkce: false,
    scopeSeparator: ",",
    grantIncludesPriorConsent: true,
    tokenPerIdentity: true,
    callbackErrorCode: ({ error }) => (error === "access_denied" ? "consent_declined" : null),
    identify: async ({ fetch, accessToken, tokenResponse }): Promise<ProviderIdentity> => {
      // Only a bot token is asked for; a user token would read as its user.
      if (tokenResponse.token_type !== "bot") throw new Error("slack granted no bot token");
      const who = await authTest(fetch, accessToken);
      return { label: who.team, userId: who.teamId };
    },
    revoke: ({ fetch, token }) => revokeToken(fetch, token),
    pastedToken: {
      async verify({ fetch, token }) {
        if (!BOT_TOKEN_RE.test(token)) throw new SlackTokenError("key_invalid");
        const who = await authTest(fetch, token);
        const services = who.scopes === null ? null : servicesForScopes(who.scopes);
        if (services === null) throw new SlackTokenError("scope_mismatch");
        return { identity: { label: who.team, userId: who.teamId }, scopes: [...who.scopes!].sort(), services };
      },
    },
    sync: {
      apiOrigin: SLACK_API_ORIGIN,
      adapter: (account, ctx) => slackAdapter(account, { ...(ctx.now ? { now: ctx.now } : {}), ...(ctx.engine ? { engine: ctx.engine } : {}) }),
    },
  };
}
