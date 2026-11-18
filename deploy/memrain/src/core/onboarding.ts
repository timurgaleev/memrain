/**
 * The /app wizard for a member: connect a client, fill the memory, ask.
 *
 * Each step closes when it really happened, read from the rows that prove it:
 *   connected_at     the first successful call made with one of the member's
 *                    own keys, or the first sign-in through a connector code
 *                    issued to the member;
 *   first_write_at   the first page in the member's personal source;
 *   first_answer_at  the first answer of the member's chat that came back `ok`.
 * A marker is stored once it is seen and never cleared, so the wizard only
 * moves forward, survives a restart, and keeps a step that the member later
 * undid (a revoked key, an erased thread). `first_answer_at` minus the
 * invite's `opened_at` is the invite-to-first-answer time, both written by
 * the database.
 *
 * Filling writes only to the personal source, at tier member: pasted text
 * through the normal page write, an export through the transcript importer.
 */
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import { dispatchTool } from "../mcp/dispatch.ts";
import type { AuthInfo } from "./auth-info.ts";
import { priceFor, runWithSpendClient } from "./budget.ts";
import { slugWords } from "./chat/save.ts";
import { parseTranscriptExport } from "./transcripts/detect.ts";
import { ingestSessions } from "./transcripts/ingest.ts";

export type OnboardingStep = "connect" | "fill" | "ask" | "done";

export interface OnboardingState {
  step: OnboardingStep;
  connected_at: string | null;
  first_write_at: string | null;
  first_answer_at: string | null;
  /** When the member first opened an invite link; null when never. */
  opened_at: string | null;
}

export interface OnboardingMember {
  memberId: string;
  personalSourceId: string | null;
}

interface StateRow {
  connected_at: unknown;
  first_write_at: unknown;
  first_answer_at: unknown;
  opened_at: unknown;
}

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function stepOf(s: Pick<OnboardingState, "connected_at" | "first_write_at" | "first_answer_at">): OnboardingStep {
  if (s.connected_at === null) return "connect";
  if (s.first_write_at === null) return "fill";
  if (s.first_answer_at === null) return "ask";
  return "done";
}

/**
 * Read the evidence for every marker not yet stored, store what it shows, and
 * return the member's wizard. Stored markers win over evidence (COALESCE), so
 * nothing moves back.
 */
export async function refreshOnboarding(engine: Engine, m: OnboardingMember): Promise<OnboardingState> {
  const r = await engine.query<StateRow>(
    `WITH evidence AS (
       SELECT
         LEAST(
           (SELECT min(l.created_at) FROM mcp_request_log l
              JOIN access_tokens a ON a.name = l.token_name
             WHERE a.member_id = $1 AND l.status = 'success'),
           (SELECT min(a.last_used_at) FROM access_tokens a WHERE a.member_id = $1),
           (SELECT min(t.created_at) FROM oauth_tokens t
              JOIN oauth_enrollments e ON t.grant_bound AND e.id = t.grant_id
             WHERE e.member_id = $1 AND t.token_type = 'access')
         ) AS connected_at,
         -- scope: upstream the member's own personal source, named by its session
         (SELECT min(p.created_at) FROM pages p WHERE $2::text IS NOT NULL AND p.source_id = $2::text) AS first_write_at,
         -- scope: upstream the member's own chat, keyed by its owner key
         (SELECT min(cm.created_at) FROM chat_messages cm
            JOIN chat_threads ct ON ct.id = cm.thread_id
           WHERE ct.owner_key = $3 AND cm.role = 'assistant' AND cm.status = 'ok') AS first_answer_at
     ), saved AS (
       INSERT INTO onboarding_state (member_id, connected_at, first_write_at, first_answer_at)
       SELECT $1, connected_at, first_write_at, first_answer_at FROM evidence
       ON CONFLICT (member_id) DO UPDATE SET
         connected_at = COALESCE(onboarding_state.connected_at, EXCLUDED.connected_at),
         first_write_at = COALESCE(onboarding_state.first_write_at, EXCLUDED.first_write_at),
         first_answer_at = COALESCE(onboarding_state.first_answer_at, EXCLUDED.first_answer_at),
         updated_at = now()
       RETURNING connected_at, first_write_at, first_answer_at
     )
     SELECT s.connected_at, s.first_write_at, s.first_answer_at,
            (SELECT min(i.opened_at) FROM member_invites i WHERE i.member_id = $1) AS opened_at
       FROM saved s`,
    [m.memberId, m.personalSourceId, `member:${m.memberId}`],
  );
  const row = r.rows[0];
  const markers = {
    connected_at: iso(row?.connected_at),
    first_write_at: iso(row?.first_write_at),
    first_answer_at: iso(row?.first_answer_at),
  };
  const step = stepOf(markers);
  await engine.query(`UPDATE onboarding_state SET step = $2 WHERE member_id = $1 AND step <> $2`, [m.memberId, step]);
  return { step, ...markers, opened_at: iso(row?.opened_at) };
}

/** Where a member's onboarding writes, and as whom. */
export interface OnboardingGrant {
  memberId: string;
  sourceId: string;
  allowedSources: string[];
  spendId: string;
}

export class OnboardingError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "OnboardingError";
  }
}

const TITLE_MAX = 200;
export const PASTE_MAX_CHARS = 200_000;
const SLUG_ATTEMPTS = 5;

/** Pasted text becomes a note in the member's personal source, written as the member. */
export async function pasteNote(storage: Storage, g: OnboardingGrant, input: { title?: unknown; text?: unknown }): Promise<{ slug: string }> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length === 0) throw new OnboardingError("invalid_params", 400, "Paste some text to save.");
  if (text.length > PASTE_MAX_CHARS) throw new OnboardingError("invalid_params", 400, `Paste at most ${PASTE_MAX_CHARS} characters at a time.`);
  const rawTitle = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
  const title = (rawTitle || text.split("\n")[0]!.replace(/\s+/g, " ").trim()).slice(0, TITLE_MAX) || "Note";
  const base = `notes/${new Date().toISOString().slice(0, 10)}-${slugWords(title)}`;
  const authInfo: AuthInfo = {
    token: "",
    clientId: g.spendId,
    scopes: ["read", "write"],
    sourceId: g.sourceId,
    allowedSources: g.allowedSources,
    budgetUsdPerDay: null,
    isPublic: false,
  };
  for (let i = 1; i <= SLUG_ATTEMPTS; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const res = await dispatchTool(storage, {
      name: "page_put",
      arguments: { slug, title, markdown_body: text, type: "note", expected_version: 0, written_by: "app-onboarding", reason: "pasted in /app" },
    }, { authInfo, memberPrincipal: `member:${g.memberId}`, trustCeiling: "member" });
    if (!res.isError) return { slug };
    let error: unknown;
    try {
      error = (JSON.parse(res.content?.[0]?.text ?? "") as { error?: unknown }).error;
    } catch {
      error = undefined;
    }
    // The name can be held by an older note or by a page of another source.
    if (error === "version_conflict" || error === "permission_denied") continue;
    if (error === "secret_detected" || error === "invalid_params") {
      throw new OnboardingError("invalid_params", 400, "That text could not be saved: it looks like it holds a secret or is not valid.");
    }
    console.error("[app] paste refused:", (res.content?.[0]?.text ?? "").slice(0, 300));
    throw new OnboardingError("write_refused", 422, "The note could not be saved.");
  }
  throw new OnboardingError("slug_taken", 409, "Too many notes with this title today; give it another title.");
}

const IMPORT_EMBED_MODEL = "titan-embed";
/** Characters per token, low on purpose so the estimate errs high. */
const CHARS_PER_TOKEN = 3;
/** Chunk overlap and titles embed some text twice. */
const OVERLAP = 1.25;
export const DEFAULT_IMPORT_MAX_USD = 1;

/** Worst-case embedding spend for importing `chars` characters of conversation. */
export function importEstimateUsd(chars: number): number {
  const price = priceFor(IMPORT_EMBED_MODEL)?.inputPer1M ?? 0;
  return (Math.ceil(chars / CHARS_PER_TOKEN) * OVERLAP / 1_000_000) * price;
}

export function importCapUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["MEMRAIN_ONBOARD_IMPORT_MAX_USD"]?.trim();
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_IMPORT_MAX_USD;
}

export interface ImportResult {
  format: string;
  sessions: number;
  parts_written: number;
  parts_unchanged: number;
  sessions_rejected: number;
  sessions_failed: number;
  estimate_usd: number;
}

const NOT_AN_EXPORT = "This is not a ChatGPT or Claude export. Upload conversations.json from the export archive.";

/**
 * Import a ChatGPT or Claude export into the member's personal source. The
 * file is parsed in memory and never kept. Above the import cap nothing is
 * written until the member confirms.
 */
export async function importExport(storage: Storage, g: OnboardingGrant, bytes: Uint8Array, opts: { confirm: boolean }): Promise<ImportResult> {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new OnboardingError("invalid_params", 400, NOT_AN_EXPORT);
  }
  const parsed = parseTranscriptExport(data, bytes.length);
  const format = parsed.diagnostics.format;
  if ((format !== "chatgpt" && format !== "claude-ai") || parsed.sessions.length === 0) {
    throw new OnboardingError("invalid_params", 400, NOT_AN_EXPORT);
  }
  const chars = parsed.sessions.reduce((n, s) => n + s.messages.reduce((k, msg) => k + msg.text.length, 0) + (s.title?.length ?? 0), 0);
  const estimate = importEstimateUsd(chars);
  const cap = importCapUsd();
  if (estimate > cap && !opts.confirm) {
    throw new OnboardingError("import_over_cap", 409, "This import costs more than the usual limit; confirm to go ahead.", {
      estimate_usd: estimate, cap_usd: cap, sessions: parsed.sessions.length,
    });
  }
  const result = await runWithSpendClient({ clientId: g.spendId }, () => ingestSessions(storage, parsed.sessions, {
    sourceId: g.sourceId, ref: `app:${g.memberId}`, remote: true, trustTier: "member",
  }));
  return {
    format,
    sessions: result.sessions,
    parts_written: result.parts_written,
    parts_unchanged: result.parts_unchanged,
    sessions_rejected: result.sessions_rejected,
    sessions_failed: result.sessions_failed,
    estimate_usd: estimate,
  };
}
