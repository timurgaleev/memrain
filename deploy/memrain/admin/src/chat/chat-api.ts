import { ApiError, expectOk, passkeyFetch } from "../lib/passkey-fetch.ts";
import { parseModels, parseThread, parseThreads } from "./events.ts";
import type { ModelsReport, ThreadDetail, ThreadSummary } from "./events.ts";
import { chatErrorText } from "./ThreadList.tsx";

// The Ask page's plain JSON calls. The question itself is a stream; see
// useChatStream. A 401 means the session ended, so it goes to sign-in like
// every panel call; any other refusal keeps its code for the page to word.
async function call(path: string, init?: RequestInit): Promise<unknown> {
  const r = await passkeyFetch<unknown>(path, init);
  if (r.status === 401) {
    window.location.hash = "#login";
    throw new ApiError("unauthorized", 401, r.body as Record<string, unknown>);
  }
  return expectOk(r);
}

const thread = (id: string) => `/admin/api/chat/threads/${encodeURIComponent(id)}`;

export const chatApi = {
  models: async (signal?: AbortSignal): Promise<ModelsReport> => parseModels(await call("/admin/api/chat/models", { signal })),
  threads: async (signal?: AbortSignal): Promise<ThreadSummary[]> => parseThreads(await call("/admin/api/chat/threads", { signal })),
  thread: async (id: string, signal?: AbortSignal): Promise<ThreadDetail> => parseThread(await call(thread(id), { signal })),
  deleteThread: (id: string) => call(thread(id), { method: "DELETE" }),
  /** Saves an assistant answer as a page through the normal write path. */
  save: async (messageId: string): Promise<string> => {
    const body = await call(`/admin/api/chat/messages/${encodeURIComponent(messageId)}/save`, { method: "POST", body: "{}" });
    const slug = body && typeof body === "object" ? (body as { slug?: unknown }).slug : undefined;
    if (typeof slug !== "string" || slug === "") throw new Error("The server did not say which page it saved.");
    return slug;
  },
  /** The optional answer actions this server has on; anything but a clear yes reads as off. */
  extras: async (signal?: AbortSignal): Promise<AnswerExtras> => {
    const on = async (path: string) => {
      const r = await passkeyFetch<{ enabled?: unknown }>(path, { signal }).catch(() => null);
      return r !== null && r.ok && r.body.enabled === true;
    };
    const [feedback, share] = await Promise.all([on("/admin/api/feedback"), on("/admin/api/chat/share")]);
    return { feedback, share };
  },
  /** Rate one cited page: 1 useful, -1 not useful, 0 withdraws the rating. */
  rate: (messageId: string, slug: string, rating: -1 | 0 | 1) =>
    call("/admin/api/feedback", { method: "POST", body: JSON.stringify({ message_id: messageId, slug, rating }) }),
  share: async (messageId: string, password: string): Promise<{ url: string; expiresAt: string }> => {
    const body = await call(`/admin/api/chat/messages/${encodeURIComponent(messageId)}/share`, { method: "POST", body: JSON.stringify({ password }) });
    const b = (body ?? {}) as { url?: unknown; expires_at?: unknown };
    if (typeof b.url !== "string" || typeof b.expires_at !== "string") throw new Error("The server did not return the link.");
    return { url: b.url, expiresAt: b.expires_at };
  },
  unshare: (messageId: string) => call(`/admin/api/chat/messages/${encodeURIComponent(messageId)}/share`, { method: "DELETE" }),
};

export interface AnswerExtras {
  feedback: boolean;
  share: boolean;
}

/** The server's own sentence for a refused action when it sent one. */
export function actionErrorText(e: unknown): string {
  const message = e instanceof ApiError ? e.body["message"] : undefined;
  return typeof message === "string" && message !== "" ? message : chatErrorText(e);
}
