import { ApiError, expectOk, passkeyFetch } from "../lib/passkey-fetch.ts";
import { parseModels, parseThread, parseThreads } from "./events.ts";
import type { ModelsReport, ThreadDetail, ThreadSummary } from "./events.ts";

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
};
