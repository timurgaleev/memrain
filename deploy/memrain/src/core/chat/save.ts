/**
 * Save a chat answer as a page, through the same page_put every writer uses:
 * the secret scanner and the caller's grant apply, and the page keeps the
 * lowest trust tier of the evidence it cites. The citations become wikilinks,
 * so the saved page links to its evidence.
 */
import type { Storage } from "../storage.ts";
import type { Engine } from "../engine/interface.ts";
import { dispatchTool } from "../../mcp/dispatch.ts";
import { documentRankSql, pageRankSql, tierOfRank, type TrustTier } from "../trust-tier.ts";
import { ownedAnswer, setSavedSlug, type ChatCitation, type ChatOwner } from "./store.ts";

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

/**
 * The least trusted tier among the evidence an answer cites. The page is
 * written by the operator, so without this an answer that repeats a synced
 * Slack channel would turn that text into owner text. A take counts as the
 * text it was distilled from; a ref no row backs any more is not vouched for.
 */
async function evidenceTier(engine: Engine, citations: readonly ChatCitation[]): Promise<TrustTier> {
  const refs = citations.filter((c) => c.kind === "page").map((c) => c.slug);
  const takeKeys = [...new Set(citations.filter((c) => c.kind === "take").map((c) => c.slug))];
  if (takeKeys.length > 0) {
    const t = await engine.query<{ source_ref: string }>(
      `SELECT DISTINCT ON (take_key) source_ref FROM synth_takes WHERE take_key = ANY($1::text[])`,
      [takeKeys],
    );
    if (t.rows.length < takeKeys.length) return "external";
    refs.push(...t.rows.map((r) => r.source_ref));
  }
  if (refs.length === 0) return "owner";
  // scope: upstream the refs are the owner's own answer's citations, resolved under the owner's grant when it was answered; reading wider only lowers the tier
  const r = await engine.query<{ ref: string; rank: number | string }>(
    `SELECT pg.slug AS ref, (${pageRankSql("pg")})::int AS rank FROM pages pg
      WHERE pg.slug = ANY($1::text[]) AND pg.deleted_at IS NULL
     UNION ALL
     -- page://<source>/<slug> also reads as the default page slugged <source>/<slug>.
     SELECT pg.source_id || '/' || pg.slug AS ref, (${pageRankSql("pg")})::int AS rank FROM pages pg
      WHERE pg.source_id <> 'default' AND pg.source_id || '/' || pg.slug = ANY($1::text[]) AND pg.deleted_at IS NULL
     UNION ALL
     SELECT d.source_path AS ref, (${documentRankSql("d")})::int AS rank FROM documents d WHERE d.source_path = ANY($1::text[])
     UNION ALL
     SELECT d.id AS ref, (${documentRankSql("d")})::int AS rank FROM documents d WHERE d.id = ANY($1::text[])`,
    [refs],
  );
  const found = new Set(r.rows.map((row) => row.ref));
  if (refs.some((ref) => !found.has(ref))) return "external";
  return tierOfRank(Math.min(...r.rows.map((row) => Number(row.rank))));
}

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
  const tier = await evidenceTier(engine, message.citations);
  for (let i = 1; i <= SLUG_ATTEMPTS; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const res = await dispatchTool(storage, {
      name: "page_put",
      arguments: { slug, title, markdown_body: body, type: "note", expected_version: 0, written_by: "admin-chat", reason: "saved from chat" },
    }, tier === "owner" ? {} : { trustCeiling: tier });
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
