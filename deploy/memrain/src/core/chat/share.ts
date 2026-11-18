/**
 * Password links to one chat answer (migration 175, MEMRAIN_CHAT_SHARE).
 *
 * Only the answer's owner can make one, and only for an answer that finished
 * `ok`. The link token and the password are stored as hashes. Opening a link
 * shows the answer text and the titles of its sources; the question, the
 * pages behind the sources and everything else in the thread stay private.
 * A link lives SHARE_TTL_MS; five wrong passwords in a row lock it for
 * SHARE_LOCK_MINUTES, during which even the right password is refused.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { ownedAnswer, type ChatOwner } from "./store.ts";

export const SHARE_TTL_MS = 7 * 86_400_000;
export const SHARE_MAX_FAILURES = 5;
export const SHARE_LOCK_MINUTES = 15;
export const SHARE_PASSWORD_MIN = 8;
export const SHARE_PASSWORD_MAX = 200;
/** 32 random bytes, base64url. */
export const SHARE_TOKEN_RE = /^[\w-]{43}$/;

export function chatShareEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env["MEMRAIN_CHAT_SHARE"]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export function shareTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type CreateShareResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; error: "not_found" | "not_shareable" | "invalid_password" };

export async function createShare(engine: Engine, owner: ChatOwner, messageId: number, password: string): Promise<CreateShareResult> {
  if (password.length < SHARE_PASSWORD_MIN || password.length > SHARE_PASSWORD_MAX) return { ok: false, error: "invalid_password" };
  const owned = await ownedAnswer(engine, owner, messageId);
  if (!owned) return { ok: false, error: "not_found" };
  if (owned.message.status !== "ok") return { ok: false, error: "not_shareable" };
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SHARE_TTL_MS);
  const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
  await engine.query(
    `INSERT INTO chat_shares (token_hash, message_id, owner_key, password_hash, expires_at) VALUES ($1, $2, $3, $4, $5::timestamptz)`,
    [shareTokenHash(token), messageId, owner.key, passwordHash, expiresAt.toISOString()],
  );
  return { ok: true, token, expiresAt };
}

/** End every live link to the owner's answer; null when the answer is not the owner's. */
export async function revokeShares(engine: Engine, owner: ChatOwner, messageId: number): Promise<number | null> {
  if (!(await ownedAnswer(engine, owner, messageId))) return null;
  const r = await engine.query<{ token_hash: string }>(
    `UPDATE chat_shares SET revoked_at = NOW()
      WHERE message_id = $1 AND owner_key = $2 AND revoked_at IS NULL
      RETURNING token_hash`,
    [messageId, owner.key],
  );
  return r.rows.length;
}

export interface SharedAnswer {
  content: string;
  sources: Array<{ n: number; title: string }>;
}

export type ShareState = "open" | "not_found" | "gone" | "locked";
export type OpenShareResult = { ok: true; answer: SharedAnswer } | { ok: false; error: Exclude<ShareState, "open"> | "wrong_password" };

interface ShareRow {
  password_hash: string;
  gone: boolean;
  locked: boolean;
  content: string;
  citations: unknown;
}

async function findShare(engine: Engine, token: string): Promise<ShareRow | null> {
  if (!SHARE_TOKEN_RE.test(token)) return null;
  // scope: upstream a link is found by its token hash and shows only the one answer its owner shared
  const r = await engine.query<ShareRow>(
    `SELECT s.password_hash, m.content, m.citations,
            (s.revoked_at IS NOT NULL OR s.expires_at <= NOW() OR m.status IS DISTINCT FROM 'ok') AS gone,
            (s.locked_until IS NOT NULL AND s.locked_until > NOW()) AS locked
       FROM chat_shares s
       JOIN chat_messages m ON m.id = s.message_id AND m.role = 'assistant'
       JOIN chat_threads t ON t.id = m.thread_id AND t.owner_key = s.owner_key
      WHERE s.token_hash = $1`,
    [shareTokenHash(token)],
  );
  return r.rows[0] ?? null;
}

/** What a visitor without the password may learn: whether the link is still open. */
export async function shareState(engine: Engine, token: string): Promise<ShareState> {
  const row = await findShare(engine, token);
  if (!row) return "not_found";
  if (row.gone) return "gone";
  return row.locked ? "locked" : "open";
}

function sourcesOf(citations: unknown): SharedAnswer["sources"] {
  let list: unknown = citations;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: SharedAnswer["sources"] = [];
  for (const c of list) {
    const n = (c as { n?: unknown }).n;
    const title = (c as { title?: unknown }).title;
    if (typeof n === "number" && typeof title === "string") out.push({ n, title });
  }
  return out;
}

export async function openShare(engine: Engine, token: string, password: string): Promise<OpenShareResult> {
  const row = await findShare(engine, token);
  if (!row) return { ok: false, error: "not_found" };
  if (row.gone) return { ok: false, error: "gone" };
  if (row.locked) return { ok: false, error: "locked" };
  const hash = shareTokenHash(token);
  const right = password.length > 0 && password.length <= SHARE_PASSWORD_MAX && await Bun.password.verify(password, row.password_hash);
  if (!right) {
    const r = await engine.query<{ locked: boolean }>(
      `UPDATE chat_shares SET
         failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
         locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN NOW() + make_interval(mins => $3::int) ELSE locked_until END
       WHERE token_hash = $1
       RETURNING (locked_until IS NOT NULL AND locked_until > NOW()) AS locked`,
      [hash, SHARE_MAX_FAILURES, SHARE_LOCK_MINUTES],
    );
    return { ok: false, error: r.rows[0]?.locked === true ? "locked" : "wrong_password" };
  }
  await engine.query(`UPDATE chat_shares SET failed_attempts = 0 WHERE token_hash = $1 AND failed_attempts > 0`, [hash]);
  return { ok: true, answer: { content: row.content, sources: sourcesOf(row.citations) } };
}
