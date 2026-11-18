/**
 * The /app wizard routes. Every route sits behind the member session and the
 * same-origin check (http/app.ts) and works on the member's own data only.
 *
 *   GET    /app/api/onboarding                the member's wizard (core/onboarding.ts)
 *   POST   /app/api/onboarding/paste          {title?, text} a note in the personal source
 *   POST   /app/api/onboarding/import[?confirm=1]
 *                                             body: a ChatGPT or Claude export (conversations.json)
 *   POST   /app/api/onboarding/demo           load the demo memory (core/demo-brain.ts)
 *   DELETE /app/api/onboarding/demo           remove it, every row
 *
 * A member without a personal source answers `member_not_ready`.
 */
import type { MemberSession } from "../core/member-sessions.ts";
import { importExport, OnboardingError, pasteNote, refreshOnboarding, type OnboardingGrant } from "../core/onboarding.ts";
import { demoLoaded, loadDemo, removeDemo } from "../core/demo-brain.ts";
import { transcriptPushMaxBytes } from "../core/transcripts/push.ts";
import { readBodyWithCap } from "./body_limit.ts";
import type { AppDeps } from "./app.ts";
import { OperationError } from "../core/operation-error.ts";

const PASTE_BODY_CAP = 1024 * 1024;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const NOT_READY = {
  error: "member_not_ready",
  message: "Your account has no personal space yet. Ask the brain operator to finish setting it up.",
};

function grantOf(s: MemberSession & { personalSourceId: string }): OnboardingGrant {
  return { memberId: s.memberId, sourceId: s.personalSourceId, allowedSources: s.readSet, spendId: `memrain_chat_m_${s.memberId}` };
}

async function readBody(req: Request, cap: number): Promise<Uint8Array | Response> {
  const read = await readBodyWithCap(req, cap);
  return read.ok ? read.buf : read.response;
}

/** Null when `url` is not an onboarding route. */
export async function handleAppOnboarding(req: Request, url: URL, session: MemberSession, deps: AppDeps): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/app/api/onboarding" && !p.startsWith("/app/api/onboarding/")) return null;
  if (session.personalSourceId === null) return json(NOT_READY, 409);
  const ready = session as MemberSession & { personalSourceId: string };
  const storage = deps.storage;
  try {
    if (p === "/app/api/onboarding" && req.method === "GET") {
      const state = await refreshOnboarding(storage.engine(), ready);
      return json({ ...state, demo_loaded: await demoLoaded(storage.engine(), ready.memberId) });
    }
    if (p === "/app/api/onboarding/paste" && req.method === "POST") {
      const buf = await readBody(req, PASTE_BODY_CAP);
      if (buf instanceof Response) return buf;
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(buf));
      } catch {
        return json({ error: "invalid_body" }, 400);
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "invalid_body" }, 400);
      return json(await pasteNote(storage, grantOf(ready), body as { title?: unknown; text?: unknown }));
    }
    if (p === "/app/api/onboarding/import" && req.method === "POST") {
      const buf = await readBody(req, transcriptPushMaxBytes());
      if (buf instanceof Response) return buf;
      return json(await importExport(storage, grantOf(ready), buf, { confirm: url.searchParams.get("confirm") === "1" }));
    }
    if (p === "/app/api/onboarding/demo" && req.method === "POST") {
      return json(await loadDemo(storage, ready.memberId));
    }
    if (p === "/app/api/onboarding/demo" && req.method === "DELETE") {
      return json(await removeDemo(storage.engine(), ready.memberId));
    }
  } catch (e) {
    if (e instanceof OnboardingError) return json({ error: e.code, message: e.message, ...e.extra }, e.status);
    if (e instanceof OperationError && e.code === "tenant_limit_reached") return json({ error: e.code, message: e.message }, 409);
    console.error("[app] onboarding failed:", e instanceof Error ? e.message : e);
    return json({ error: "internal_error" }, 500);
  }
  return json({ error: "not_found" }, 404);
}
