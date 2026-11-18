/**
 * Save a chat answer as a page, through the same page_put every writer uses:
 * the secret scanner, the write gate and the caller's grant all apply. The
 * citations become wikilinks, so the saved page links to its evidence.
 */
import type { Storage } from "../storage.ts";
import { dispatchTool } from "../../mcp/dispatch.ts";
import { ownedAnswer, setSavedSlug, type ChatOwner } from "./store.ts";

const SLUG_WORDS_MAX = 60;
const SLUG_ATTEMPTS = 9;

export type SaveAnswerResult =
  | { ok: true; slug: string }
  | { ok: false; status: 404 | 409 | 422; error: string; message?: string };

/** Lowercase words joined by single hyphens, no trailing hyphen. */
export function slugWords(text: string): string {
  const words = text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > SLUG_WORDS_MAX) break;
    out = next;
  }
  return out || "answer";
}

function pageBody(question: string | null, answer: string, citations: Array<{ n: number; slug: string; title: string; kind: string }>): string {
  const parts: string[] = [];
  if (question) parts.push(`> ${question.replace(/\s+/g, " ").trim()}`);
  parts.push(answer.trim());
  const pages = citations.filter((c) => c.kind === "page");
  if (pages.length > 0) {
    parts.push("## Sources", pages.map((c) => `${c.n}. [[${c.slug}|${c.title.replace(/[[\]|]/g, " ").trim() || c.slug}]]`).join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

interface ToolEnvelope { error?: unknown; message?: unknown }

export async function saveAnswerAsPage(storage: Storage, owner: ChatOwner, messageId: number, now = new Date()): Promise<SaveAnswerResult> {
  const engine = storage.engine();
  const found = await ownedAnswer(engine, owner, messageId);
  if (!found) return { ok: false, status: 404, error: "not_found" };
  const { message, question } = found;
  if (message.saved_slug) return { ok: true, slug: message.saved_slug };
  if ((message.status !== "ok" && message.status !== "refused") || !message.content.trim()) {
    return { ok: false, status: 409, error: "not_saveable", message: "Only a finished answer can be saved." };
  }
  const base = `chats/${now.toISOString().slice(0, 10)}-${slugWords(question ?? message.content)}`;
  const title = (question ?? "Chat answer").replace(/\s+/g, " ").trim().slice(0, 200);
  const body = pageBody(question, message.content, message.citations);
  for (let i = 1; i <= SLUG_ATTEMPTS; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const res = await dispatchTool(storage, {
      name: "page_put",
      arguments: { slug, title, markdown_body: body, type: "note", expected_version: 0, written_by: "admin-chat", reason: "saved from chat" },
    });
    const text = res.content?.[0]?.text ?? "";
    if (!res.isError) {
      await setSavedSlug(engine, messageId, slug);
      return { ok: true, slug };
    }
    let env: ToolEnvelope = {};
    try {
      env = JSON.parse(text) as ToolEnvelope;
    } catch {
      console.error("[chat] save failed:", text.slice(0, 300));
      return { ok: false, status: 422, error: "write_refused" };
    }
    if (env.error === "version_conflict") continue;
    return {
      ok: false,
      status: 422,
      error: typeof env.error === "string" ? env.error : "write_refused",
      ...(typeof env.message === "string" ? { message: env.message } : {}),
    };
  }
  return { ok: false, status: 409, error: "slug_taken", message: "A page with this name already exists." };
}
