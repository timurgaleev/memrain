/**
 * http/share.ts — password links to a chat answer (MEMRAIN_CHAT_SHARE).
 *
 * Owner routes, mounted by the chat API under /admin/api/chat (operator) and
 * /app/api/chat (member), behind that router's session and same-origin gates:
 *
 *   GET    <chat>/share                   { enabled }
 *   POST   <chat>/messages/:id/share      { password } -> { url: "/s/<token>", expires_at }
 *   DELETE <chat>/messages/:id/share      end every live link to the answer
 *
 * Public view, no cookie and no credential (the password is the credential):
 *
 *   GET  /s/<token>   a password form (404 unknown, 410 expired or ended)
 *   POST /s/<token>   the answer and its source titles; 401 wrong password,
 *                     429 locked or too many attempts from one client
 *
 * Every view is `noindex`, never cached, framed by nothing and runs no script.
 * Off, the owner routes answer 404 and /s/ is left to the 404 below it.
 */
import type { Storage } from "../core/storage.ts";
import type { ChatOwner } from "../core/chat/store.ts";
import {
  chatShareEnabled,
  createShare,
  openShare,
  revokeShares,
  shareState,
  SHARE_PASSWORD_MAX,
  SHARE_PASSWORD_MIN,
  SHARE_TOKEN_RE,
  type SharedAnswer,
} from "../core/chat/share.ts";
import { RateLimiter } from "../mcp/rate_limit.ts";
import { readBodyWithCap } from "./body_limit.ts";
import { resolveClientIp } from "./client-key.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const OWNER_ROUTE = /^\/(?:admin|app)\/api\/chat\/(?:share|messages\/(\d{1,15})\/share)$/;

/** The owner routes; null for any other path. */
export async function handleShareCreate(req: Request, url: URL, storage: Storage, owner: ChatOwner): Promise<Response | null> {
  const m = OWNER_ROUTE.exec(url.pathname);
  if (!m) return null;
  if (!chatShareEnabled()) return json({ error: "not_found" }, 404);
  const id = m[1];
  if (id === undefined) return req.method === "GET" ? json({ enabled: true }) : json({ error: "method_not_allowed" }, 405);
  const engine = storage.engine();
  if (req.method === "DELETE") {
    const n = await revokeShares(engine, owner, Number(id));
    return n === null ? json({ error: "not_found" }, 404) : json({ ok: true, revoked: n });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const essence = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (essence !== "application/json") return json({ error: "unsupported_media_type" }, 415);
  const read = await readBodyWithCap(req, 2048);
  if (!read.ok) return read.response;
  let password: unknown;
  try {
    password = (JSON.parse(new TextDecoder().decode(read.buf)) as { password?: unknown } | null)?.password;
  } catch {
    password = undefined;
  }
  const badPassword = json({ error: "invalid_params", message: `Choose a password of ${SHARE_PASSWORD_MIN} to ${SHARE_PASSWORD_MAX} characters.` }, 400);
  if (typeof password !== "string") return badPassword;
  const r = await createShare(engine, owner, Number(id), password);
  if (r.ok) return json({ url: `/s/${r.token}`, expires_at: r.expiresAt.toISOString() });
  if (r.error === "not_found") return json({ error: "not_found", message: "That answer does not exist." }, 404);
  if (r.error === "not_shareable") return json({ error: "not_shareable", message: "Only a finished answer can be shared." }, 409);
  return badPassword;
}

/** Password attempts per client, across every link. */
const attemptLimiter = new RateLimiter({ capacity: 20, refillPerSecond: 1 / 15 });

const VIEW_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STYLE = `body{font:16px/1.55 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#1b1f24;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6e8eb;background:#14171a}input,button{color:inherit;background:#1d2126;border-color:#3a4048}}
h1{font-size:1.25rem}.answer{white-space:pre-wrap}.muted{color:#6b7280}.error{color:#b42318}
input{font:inherit;padding:.5rem;border:1px solid #c4c9d0;border-radius:6px;width:100%;box-sizing:border-box}
button{font:inherit;margin-top:.75rem;padding:.5rem 1rem;border:1px solid #c4c9d0;border-radius:6px;cursor:pointer}`;

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>`
    + `<style>${STYLE}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: VIEW_HEADERS });
}

function form(status: number, error: string | null): Response {
  return page(status, "Shared answer", `<h1>Shared answer</h1>`
    + `<p class="muted">Someone shared an answer with you. Enter the password they gave you to read it.</p>`
    + (error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "")
    + `<form method="post"><label for="pw">Password</label>`
    + `<input id="pw" name="password" type="password" autocomplete="off" required maxlength="${SHARE_PASSWORD_MAX}" autofocus>`
    + `<button type="submit">Show the answer</button></form>`);
}

const notFound = () => page(404, "Link not found", `<h1>Link not found</h1><p>This link does not exist. Check that you copied all of it.</p>`);
const gone = () => page(410, "Link ended", `<h1>This link has ended</h1><p>Shared answers stay readable for 7 days, and the person who shared it can end the link sooner. Ask them for a new one.</p>`);
const locked = () => page(429, "Too many attempts", `<h1>Too many attempts</h1><p>This link is locked for a few minutes after too many wrong passwords. Try again later.</p>`);

function answerPage(a: SharedAnswer): Response {
  const sources = a.sources.length === 0 ? "" : `<h2>Sources</h2><ol>${a.sources
    .slice()
    .sort((x, y) => x.n - y.n)
    .map((s) => `<li value="${s.n}">${escapeHtml(s.title)}</li>`)
    .join("")}</ol>`;
  return page(200, "Shared answer", `<h1>Shared answer</h1><div class="answer">${escapeHtml(a.content)}</div>${sources}`
    + `<p class="muted">Written from the sharer's own notes. Only the answer and the titles of its sources are shared.</p>`);
}

export interface ShareViewOptions {
  /** Test seam: the per-client attempt limiter (default: the process-wide one). */
  limiter?: RateLimiter;
}

/** The public /s/<token> page; null when sharing is off or the path is not a share link. */
export async function handleShareView(req: Request, url: URL, storage: Storage, opts: ShareViewOptions = {}): Promise<Response | null> {
  if (!chatShareEnabled() || !url.pathname.startsWith("/s/")) return null;
  const token = url.pathname.slice("/s/".length);
  if (!SHARE_TOKEN_RE.test(token)) return notFound();
  const engine = storage.engine();
  if (req.method === "GET" || req.method === "HEAD") {
    const state = await shareState(engine, token);
    if (state === "not_found") return notFound();
    if (state === "gone") return gone();
    return state === "locked" ? locked() : form(200, null);
  }
  if (req.method !== "POST") return page(405, "Not allowed", `<h1>Not allowed</h1>`);
  if (!(opts.limiter ?? attemptLimiter).allow(resolveClientIp(req) ?? "unknown")) return locked();
  const read = await readBodyWithCap(req, 2048);
  if (!read.ok) return read.response;
  const password = new URLSearchParams(new TextDecoder().decode(read.buf)).get("password") ?? "";
  const r = await openShare(engine, token, password);
  if (r.ok) return answerPage(r.answer);
  if (r.error === "not_found") return notFound();
  if (r.error === "gone") return gone();
  if (r.error === "locked") return locked();
  return form(401, "That password is not right.");
}
