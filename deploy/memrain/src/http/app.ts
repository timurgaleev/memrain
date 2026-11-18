/**
 * The member app under /app, served only while MEMRAIN_APP is on (404 on
 * every /app path otherwise).
 *
 *   /app/invite/*, /app/login/*, /app/logout   sign-in (app-auth.ts)
 *   /app/api/*                                 behind the member session
 *     GET  /app/api/me
 *     …    /app/api/chat…                      the chat routes, owned by the member
 *     …    /app/api/connect/…                  connect a client (app-connect.ts)
 *
 * Every /app/api route resolves the `memrain_app` session first (401
 * without one) and refuses a state-changing request from another origin.
 * A member reads its personal source and its groups' sources and writes only
 * to its personal source; without a personal source, chat and saving answer
 * `member_not_ready`. The member's chat owner key is `member:<id>`, which no
 * operator key can equal.
 */
import type { Storage } from "../core/storage.ts";
import type { SearchOptions } from "../core/search/hybrid.ts";
import type { SonnetFn } from "../core/llm/sonnet.ts";
import type { OAuthProvider } from "../core/oauth-provider.ts";
import type { ChatOwner } from "../core/chat/store.ts";
import type { SaveGrant } from "../core/chat/save.ts";
import { hostingFlags } from "../control/contract.ts";
import { getMember } from "../core/members.ts";
import { isAppPath, resolveMemberSession, type MemberSession } from "../core/member-sessions.ts";
import type { RateLimiter } from "../mcp/rate_limit.ts";
import { handleAppAuth } from "./app-auth.ts";
import { handleAppConnect } from "./app-connect.ts";
import { handleAppOnboarding } from "./app-onboarding.ts";
import { serveAppStatic } from "./app-static.ts";
import { handleChatRoutes } from "./chat-api.ts";
import { handleFeedbackApi } from "./feedback-api.ts";
import { isSameOriginPost } from "./same-origin.ts";

export interface AppDeps {
  storage: Storage;
  publicUrl?: string;
  /** Mints the member's connector code and PATs (B8); absent, those routes answer 503. */
  oauthProvider?: OAuthProvider;
  /** Test seams, forwarded to the chat routes. */
  chatModel?: SonnetFn;
  embedQuery?: SearchOptions["embedQuery"];
  sendLimiter?: RateLimiter;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const notFound = () => new Response("Not Found", { status: 404 });

export const MEMBER_NOT_READY = {
  error: "member_not_ready",
  message: "Your account has no personal space yet. Ask the brain operator to finish setting it up.",
} as const;

/** The chat owner of a member: its own key, source, read set and spend id. */
export function memberChatOwner(s: MemberSession & { personalSourceId: string }): ChatOwner {
  return {
    key: `member:${s.memberId}`,
    sourceId: s.personalSourceId,
    readSources: s.readSet,
    spendId: `memrain_chat_m_${s.memberId}`,
    fenceDiary: true,
  };
}

export function memberSaveGrant(s: MemberSession & { personalSourceId: string }): SaveGrant {
  return {
    sourceId: s.personalSourceId,
    allowedSources: s.readSet,
    principal: `member:${s.memberId}`,
    spendId: `memrain_chat_m_${s.memberId}`,
  };
}

function ready(s: MemberSession): s is MemberSession & { personalSourceId: string } {
  return s.personalSourceId !== null;
}

/** Null when `url` is not under /app. */
export async function handleApp(req: Request, url: URL, deps: AppDeps): Promise<Response | null> {
  if (!isAppPath(url.pathname)) return null;
  if (!hostingFlags().app) return notFound();

  const auth = await handleAppAuth(req, url, { engine: () => deps.storage.engine(), ...(deps.publicUrl ? { publicUrl: deps.publicUrl } : {}) });
  if (auth) return auth;

  const p = url.pathname;
  if (p !== "/app/api" && !p.startsWith("/app/api/")) {
    return req.method === "GET" || req.method === "HEAD" ? (await serveAppStatic(url)) ?? notFound() : notFound();
  }
  const session = await resolveMemberSession(deps.storage.engine(), req);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (req.method !== "GET" && req.method !== "HEAD" && !isSameOriginPost(req, url, deps.publicUrl)) {
    return json({ error: "cross_origin" }, 403);
  }

  if (p === "/app/api/me" && req.method === "GET") {
    const member = await getMember(deps.storage.engine(), session.memberId);
    return json({
      member_id: session.memberId,
      display_name: member?.display_name ?? null,
      ready: ready(session),
      read_sources: session.readSet,
    });
  }

  if (p === "/app/api/chat" || p.startsWith("/app/api/chat/")) {
    if (!ready(session)) return json(MEMBER_NOT_READY, 409);
    return handleChatRoutes(req, p.slice("/app/api/chat".length), {
      storage: deps.storage,
      ...(deps.chatModel ? { chatModel: deps.chatModel } : {}),
      ...(deps.embedQuery ? { embedQuery: deps.embedQuery } : {}),
      ...(deps.sendLimiter ? { sendLimiter: deps.sendLimiter } : {}),
    }, memberChatOwner(session), memberSaveGrant(session));
  }
  if (p === "/app/api/feedback") return ready(session) ? handleFeedbackApi(req, { storage: deps.storage, owner: memberChatOwner(session) }) : json(MEMBER_NOT_READY, 409);

  const connect = await handleAppConnect(req, url, session, deps);
  if (connect) return connect;
  const onboarding = await handleAppOnboarding(req, url, session, deps);
  if (onboarding) return onboarding;

  return json({ error: "not_found" }, 404);
}
