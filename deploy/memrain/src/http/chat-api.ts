/**
 * http/chat-api.ts — the admin "Ask" page's API. Dispatched from
 * handleAdminApi after its admin-session, same-origin and cooldown gates.
 *
 *   POST   /admin/api/chat                      one turn, as text/event-stream
 *   GET    /admin/api/chat/models               switch, cap, priced models
 *   GET    /admin/api/chat/threads              the owner's threads
 *   GET    /admin/api/chat/threads/:id          one thread and its messages
 *   DELETE /admin/api/chat/threads/:id          delete a thread outright
 *   POST   /admin/api/chat/messages/:id/save    save an answer as a page
 *
 * The stream sends `trace` events while the answer is prepared, then one
 * `answer`, then `done`; a turn that cannot produce an answer sends `error`
 * (closed code vocabulary) then `done`. A finished answer is stored `error`
 * and marked `ok` (saveable) just before `done` is sent, and only while the
 * stream is open; a client that leaves first, or a process that dies first,
 * leaves it `error`. So `done` always means the answer can be saved. A send the server refuses before any
 * work (bad body, unknown model or thread) is a 400 whose body is that same
 * error/done pair. A thread that is not the caller's is a 404, never a 403.
 *
 * The owner is the operator today; the owner record carries the grant and
 * spend id a member will bring.
 */
import type { Storage } from "../core/storage.ts";
import type { SearchOptions } from "../core/search/hybrid.ts";
import type { SonnetFn } from "../core/llm/sonnet.ts";
import { RateLimiter } from "../mcp/rate_limit.ts";
import { readBodyWithCap } from "./body_limit.ts";
import { chatConfig } from "../core/chat/config.ts";
import { CHAT_MESSAGE_MAX_CHARS, operatorOwner, runChatTurn, type ChatAnswer, type ChatOwner, type ChatStreamEvent } from "../core/chat/chat-service.ts";
import { ChatError, chatErrorMessage, type ChatErrorCode } from "../core/chat/failures.ts";
import { deleteChatThread, getChatThread, isThreadId, listChatThreads, confirmAnswer, threadMessages, withdrawAnswer } from "../core/chat/store.ts";
import { saveAnswerAsPage } from "../core/chat/save.ts";

export interface ChatApiDeps {
  storage: Storage;
  /** Test seam: a fake model for the turn. */
  chatModel?: SonnetFn;
  /** Test seam: a deterministic query embedder. */
  embedQuery?: SearchOptions["embedQuery"];
  /** Test seam: the per-owner send limiter (default: the process-wide one). */
  sendLimiter?: RateLimiter;
}

const BODY_CAP = 16_384;
const KEEPALIVE_MS = 15_000;
const encoder = new TextEncoder();
/** Sends per owner: a short burst, then one every six seconds. */
const sendLimiter = new RateLimiter({ capacity: 10, refillPerSecond: 1 / 6 });

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const notFound = () => json({ error: "not_found" }, 404);

function frame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** A refusal before any work: the error/done pair, with an HTTP status. */
function refusedStream(code: ChatErrorCode, message: string, status: number): Response {
  const body = new Uint8Array([...frame("error", { code, message }), ...frame("done", {})]);
  return new Response(body, { status, headers: SSE_HEADERS });
}

interface SendBody { message: string; threadId?: string; model?: string }

async function parseSend(req: Request): Promise<SendBody | Response> {
  const essence = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (essence !== "application/json") return json({ error: "unsupported_media_type" }, 415);
  const read = await readBodyWithCap(req, BODY_CAP);
  if (!read.ok) return read.response;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(read.buf));
  } catch {
    return refusedStream("invalid_params", "The body is not JSON.", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refusedStream("invalid_params", "Send a JSON object.", 400);
  const b = body as Record<string, unknown>;
  if (typeof b["message"] !== "string") return refusedStream("invalid_params", "`message` must be a string.", 400);
  if (b["thread_id"] !== undefined && b["thread_id"] !== null && typeof b["thread_id"] !== "string") {
    return refusedStream("invalid_params", "`thread_id` must be a string.", 400);
  }
  if (b["model"] !== undefined && b["model"] !== null && typeof b["model"] !== "string") {
    return refusedStream("invalid_params", "`model` must be a string.", 400);
  }
  return {
    message: b["message"],
    ...(typeof b["thread_id"] === "string" ? { threadId: b["thread_id"] } : {}),
    ...(typeof b["model"] === "string" && b["model"] ? { model: b["model"] } : {}),
  };
}

/** The refusals runChatTurn would make before any work, as a 400. */
async function precheck(storage: Storage, owner: ChatOwner, send: SendBody): Promise<Response | null> {
  const message = send.message.trim();
  if (!message || message.length > CHAT_MESSAGE_MAX_CHARS) {
    return refusedStream("invalid_params", `Ask a question of 1 to ${CHAT_MESSAGE_MAX_CHARS} characters.`, 400);
  }
  const cfg = chatConfig();
  if (cfg.enabled && send.model !== undefined && !cfg.models.some((m) => m.id === send.model)) {
    return refusedStream("invalid_params", "That model is not offered for chat.", 400);
  }
  if (send.threadId !== undefined && !(await getChatThread(storage.engine(), owner, send.threadId))) {
    return refusedStream("invalid_params", "That conversation does not exist.", 400);
  }
  return null;
}

function streamTurn(req: Request, deps: ChatApiDeps, owner: ChatOwner, send: SendBody): Response {
  const stop = new AbortController();
  const onRequestAbort = () => stop.abort();
  req.signal.addEventListener("abort", onRequestAbort, { once: true });
  let ping: ReturnType<typeof setInterval> | undefined;
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let answer: ChatAnswer | null = null;
      const write = (bytes: Uint8Array) => {
        if (!open) return;
        try {
          controller.enqueue(bytes);
        } catch {
          open = false;
          stop.abort();
        }
      };
      ping = setInterval(() => write(encoder.encode(": ping\n\n")), KEEPALIVE_MS);
      (ping as unknown as { unref?: () => void }).unref?.();
      const onEvent = (e: ChatStreamEvent) => write(frame(e.event, e.data));
      void runChatTurn(
        {
          storage: deps.storage,
          owner,
          signal: stop.signal,
          confirmLater: true,
          ...(deps.chatModel ? { sonnetFn: deps.chatModel, embedFn: null } : {}),
          ...(deps.embedQuery ? { embedQuery: deps.embedQuery } : {}),
        },
        send,
        onEvent,
      )
        .then((a) => {
          answer = a;
        })
        .catch((e: unknown) => {
          const code: ChatErrorCode = e instanceof ChatError ? e.code : "provider_error";
          if (!(e instanceof ChatError)) console.error("[chat] turn failed:", e instanceof Error ? e.message : e);
          write(frame("error", { code, message: e instanceof ChatError ? e.message : chatErrorMessage(code) }));
        })
        .finally(async () => {
          clearInterval(ping);
          req.signal.removeEventListener("abort", onRequestAbort);
          const a = answer as ChatAnswer | null;
          if (a?.status === "ok" && open && !stop.signal.aborted) {
            const engine = deps.storage.engine();
            const logged = (e: unknown) => console.error("[chat] could not confirm an answer:", e instanceof Error ? e.message : e);
            await confirmAnswer(engine, a.message_id).catch(logged);
            // The client left while it was confirmed: done will not reach it.
            if (!open || stop.signal.aborted) await withdrawAnswer(engine, a.message_id).catch(logged);
          }
          write(frame("done", {}));
          if (open) {
            open = false;
            try {
              controller.close();
            } catch {
              // already closed by the client
            }
          }
        });
    },
    cancel() {
      // The tab closed or the user pressed stop: the turn releases its hold.
      open = false;
      clearInterval(ping);
      stop.abort();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

export async function handleChatApi(req: Request, url: URL, deps: ChatApiDeps): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/admin/api/chat" && !p.startsWith("/admin/api/chat/")) return null;
  const owner = operatorOwner();
  const engine = deps.storage.engine();

  if (p === "/admin/api/chat") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const send = await parseSend(req);
    if (send instanceof Response) return send;
    const refused = await precheck(deps.storage, owner, send);
    if (refused) return refused;
    if (!(deps.sendLimiter ?? sendLimiter).allow(owner.key)) return refusedStream("rate_limited", chatErrorMessage("rate_limited"), 429);
    return streamTurn(req, deps, owner, send);
  }

  if (p === "/admin/api/chat/models" && req.method === "GET") {
    const cfg = chatConfig();
    return json({
      enabled: cfg.enabled,
      default: cfg.defaultModel,
      answer_cap_usd: cfg.answerCapUsd,
      models: cfg.models,
      ...(cfg.disabledReason ? { disabled_reason: cfg.disabledReason } : {}),
    });
  }

  if (p === "/admin/api/chat/threads" && req.method === "GET") {
    return json({ threads: await listChatThreads(engine, owner) });
  }

  const thread = /^\/admin\/api\/chat\/threads\/([^/]+)$/.exec(p);
  if (thread) {
    const id = decodeURIComponent(thread[1]!);
    if (!isThreadId(id)) return notFound();
    if (req.method === "GET") {
      const t = await getChatThread(engine, owner, id);
      const messages = t ? await threadMessages(engine, owner, id) : null;
      return t && messages ? json({ thread: t, messages }) : notFound();
    }
    if (req.method === "DELETE") return (await deleteChatThread(engine, owner, id)) ? json({ ok: true }) : notFound();
    return json({ error: "method_not_allowed" }, 405);
  }

  const save = /^\/admin\/api\/chat\/messages\/(\d{1,15})\/save$/.exec(p);
  if (save && req.method === "POST") {
    const r = await saveAnswerAsPage(deps.storage, owner, Number(save[1]));
    if (r.ok) return json({ slug: r.slug });
    return json({ error: r.error, message: r.message }, r.status);
  }

  return notFound();
}
