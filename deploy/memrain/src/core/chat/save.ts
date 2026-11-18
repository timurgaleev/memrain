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

/** What a refused save tells the client: a closed list, never the write's own text. */
export type SaveError = "not_found" | "not_saveable" | "write_refused" | "slug_taken" | "busy";

export type SaveAnswerResult =
  | { ok: true; slug: string }
  | { ok: false; status: 404 | 409 | 422; error: SaveError; message: string };

const SAVE_MESSAGES: Record<SaveError, string> = {
  not_found: "That answer does not exist.",
  not_saveable: "Only a finished answer can be saved.",
  write_refused: "The page write was refused. The server log says why.",
  slug_taken: "A page with this name already exists.",
  busy: "This answer is already being saved.",
};

const refuse = (status: 404 | 409 | 422, error: SaveError): SaveAnswerResult => ({ ok: false, status, error, message: SAVE_MESSAGES[error] });

/** Answers being saved in this process: a second click waits for nothing and is refused. */
const saving = new Set<number>();

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

interface ToolEnvelope { error?: unknown }

export async function saveAnswerAsPage(storage: Storage, owner: ChatOwner, messageId: number, now = new Date()): Promise<SaveAnswerResult> {
  if (saving.has(messageId)) return refuse(409, "busy");
  saving.add(messageId);
  try {
    return await save(storage, owner, messageId, now);
  } finally {
    saving.delete(messageId);
  }
}

async function save(storage: Storage, owner: ChatOwner, messageId: number, now: Date): Promise<SaveAnswerResult> {
  const engine = storage.engine();
  const found = await ownedAnswer(engine, owner, messageId);
  if (!found) return refuse(404, "not_found");
  const { message, question } = found;
  if (message.saved_slug) return { ok: true, slug: message.saved_slug };
  if (message.status !== "ok" || !message.content.trim()) return refuse(409, "not_saveable");
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
      // not an envelope; logged below
    }
    if (env.error === "version_conflict") continue;
    console.error("[chat] save refused:", text.slice(0, 300));
    return refuse(422, "write_refused");
  }
  return refuse(409, "slug_taken");
}
