/**
 * http/feedback-api.ts — rating the sources of a chat answer.
 *
 *   GET  <api>/feedback   { enabled }
 *   POST <api>/feedback   { message_id, slug, rating: 1 | -1 | 0 }
 *
 * Mounted under an API prefix (the operator's is /admin/api); the caller has
 * already checked the session and same-origin, and passes the chat owner it
 * resolved. A rating is accepted only on a finished (`ok`) answer of that
 * owner, only for a page the answer cites, and only in a source the owner can
 * read. The query id is the answer's message id; the question is not stored.
 * Off (MEMRAIN_FEEDBACK unset), both routes answer 404.
 */
import type { Storage } from "../core/storage.ts";
import type { ChatOwner } from "../core/chat/store.ts";
import { ownedAnswer } from "../core/chat/store.ts";
import { feedbackEnabled } from "../core/feedback/settings.ts";
import { recordRating } from "../core/feedback/store.ts";
import { principalTier } from "../core/trust-tier.ts";
import { readBodyWithCap } from "./body_limit.ts";

export interface FeedbackApiDeps {
  storage: Storage;
  owner: ChatOwner;
}

const BODY_CAP = 4096;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const refuse = (status: number, error: string, message: string) => json({ error, message }, status);

interface RateBody { messageId: number; slug: string; rating: -1 | 0 | 1 }

async function parse(req: Request): Promise<RateBody | Response> {
  const essence = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (essence !== "application/json") return json({ error: "unsupported_media_type" }, 415);
  const read = await readBodyWithCap(req, BODY_CAP);
  if (!read.ok) return read.response;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(read.buf));
  } catch {
    return refuse(400, "invalid_params", "The body is not JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse(400, "invalid_params", "Send a JSON object.");
  const b = body as Record<string, unknown>;
  const rawId = b["message_id"];
  const messageId = typeof rawId === "number" ? rawId : typeof rawId === "string" && /^\d{1,15}$/.test(rawId) ? Number(rawId) : NaN;
  if (!Number.isSafeInteger(messageId) || messageId < 1) return refuse(400, "invalid_params", "`message_id` must be an answer id.");
  const slug = b["slug"];
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 500) return refuse(400, "invalid_params", "`slug` must name a cited page.");
  const rating = b["rating"];
  if (rating !== 1 && rating !== -1 && rating !== 0) return refuse(400, "invalid_params", "`rating` must be 1, -1 or 0.");
  return { messageId, slug, rating };
}

export async function handleFeedbackApi(req: Request, deps: FeedbackApiDeps): Promise<Response> {
  if (!feedbackEnabled()) return json({ error: "not_found" }, 404);
  if (req.method === "GET") return json({ enabled: true });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await parse(req);
  if (body instanceof Response) return body;
  const engine = deps.storage.engine();
  const owned = await ownedAnswer(engine, deps.owner, body.messageId);
  if (!owned) return refuse(404, "not_found", "That answer does not exist.");
  if (owned.message.status !== "ok") return refuse(409, "not_rateable", "Only a finished answer can be rated.");
  if (!owned.message.citations.some((c) => c.kind === "page" && c.slug === body.slug)) {
    return refuse(400, "not_cited", "Rate a page this answer cites.");
  }
  const page = await engine.query<{ source_id: string }>(
    `SELECT source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL`,
    [body.slug],
  );
  const sourceId = page.rows[0]?.source_id;
  if (sourceId === undefined) return refuse(404, "not_found", "That page no longer exists.");
  if (deps.owner.readSources !== undefined && !deps.owner.readSources.includes(sourceId)) {
    return refuse(403, "forbidden_source", "You cannot rate a page outside the sources you can read.");
  }
  const r = await recordRating(engine, {
    sourceId,
    slug: body.slug,
    principal: deps.owner.key,
    tier: principalTier(deps.owner.key) as "owner" | "member" | "agent",
    rating: body.rating,
    signal: "explicit",
    queryId: String(body.messageId),
  });
  if (r.ok) return json({ ok: true });
  if (r.error === "rate_limited") return refuse(429, "rate_limited", "Too many ratings in the last hour. Try again later.");
  return refuse(404, "not_found", "That page no longer exists.");
}
