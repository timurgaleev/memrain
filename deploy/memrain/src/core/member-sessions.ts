/**
 * Member web sessions for /app: the `memrain_app` cookie resolved to an
 * enabled member and the sources that member may read.
 *
 * The cookie holds a random id; the database keeps its SHA-256. A session
 * ends after 7 idle days, 30 days in all, on sign-out, or the moment its
 * member is disabled or removed: every resolve asks `memberAccess`, the same
 * join the token verifier uses, and revokes the session it refuses.
 *
 * The cookie is scoped to /app (`Path=/app`), and a request for any other
 * path never resolves one, so the admin panel and the share pages cannot be
 * reached with it even if a browser sends it.
 *
 * What a member reads in /app is the personal source plus the sources of the
 * member's groups, nothing wider; what the member writes goes to the personal
 * source only. A member without a personal source keeps the session but is
 * not ready for chat or saving (`member_not_ready`).
 */
import { createHash, randomBytes } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import { memberAccess, type MemberAccess } from "./members.ts";

export const APP_COOKIE = "memrain_app";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const SESSION_TTL_MS = 30 * DAY;
export const SESSION_IDLE_MS = 7 * DAY;
/** A session taken from an invite on a device without a passkey: once, 7 days. */
export const INVITE_SESSION_TTL_MS = 7 * DAY;
/** `last_seen_at` is written at most this often. */
const TOUCH_EVERY_MS = 60_000;
const SESSION_ID_RE = /^[\w-]{43}$/;

export type SessionVia = "passkey" | "invite";

export interface MemberSession {
  memberId: string;
  access: MemberAccess;
  /** The member's own source, the only one /app writes to; null when unset. */
  personalSourceId: string | null;
  /** Sorted, distinct: the personal source and the member's group sources. */
  readSet: string[];
  /** SHA-256 of the cookie value. */
  sessionHash: string;
}

const sha256Hex = (v: string): string => createHash("sha256").update(v, "utf8").digest("hex");
const iso = (ms: number): string => new Date(ms).toISOString();

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return new Date(String(v)).getTime();
}

/** `Set-Cookie` for the session; null clears it. */
export function memberSessionCookie(id: string | null, maxAgeMs = 0): string {
  const maxAge = id === null ? 0 : Math.max(0, Math.floor(maxAgeMs / 1000));
  return `${APP_COOKIE}=${id ?? ""}; Path=/app; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

/** The single `memrain_app` cookie value, or null when absent or sent twice. */
export function readAppCookie(req: Request, name: string = APP_COOKIE): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const values: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) values.push(part.slice(i + 1).trim());
  }
  return values.length === 1 && values[0] ? values[0] : null;
}

/** True for /app and every path below it, and nothing else. */
export function isAppPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

export async function createMemberSession(
  engine: Engine,
  memberId: string,
  via: SessionVia,
  nowMs: number = Date.now(),
): Promise<{ id: string; expiresAt: number }> {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = nowMs + (via === "invite" ? INVITE_SESSION_TTL_MS : SESSION_TTL_MS);
  await engine.query(
    `INSERT INTO member_web_sessions (id_hash, member_id, via, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz, $5::timestamptz)`,
    [sha256Hex(id), memberId, via, iso(nowMs), iso(expiresAt)],
  );
  return { id, expiresAt };
}

/** Revoke one session by its cookie value. */
export async function revokeMemberSession(engine: Engine, id: string, nowMs: number = Date.now()): Promise<boolean> {
  const r = await engine.query(
    `UPDATE member_web_sessions SET revoked_at = $2::timestamptz WHERE id_hash = $1 AND revoked_at IS NULL RETURNING id_hash`,
    [sha256Hex(id), iso(nowMs)],
  );
  return r.rows.length > 0;
}

/** Revoke every live session of a member. Returns how many. */
export async function revokeMemberSessions(engine: Pick<Engine, "query">, memberId: string, nowMs: number = Date.now()): Promise<number> {
  const r = await engine.query(
    `UPDATE member_web_sessions SET revoked_at = $2::timestamptz WHERE member_id = $1 AND revoked_at IS NULL RETURNING id_hash`,
    [memberId, iso(nowMs)],
  );
  return r.rows.length;
}

/** The personal source and the group sources, sorted and distinct. */
export function memberReadSet(personalSourceId: string | null, groupSources: readonly string[]): string[] {
  return [...new Set([...(personalSourceId ? [personalSourceId] : []), ...groupSources])].sort();
}

interface SessionRow {
  member_id: string;
  created_at: unknown;
  last_seen_at: unknown;
  expires_at: unknown;
  personal_source_id: string | null;
}

export async function resolveMemberSession(engine: Engine, req: Request, nowMs: number = Date.now()): Promise<MemberSession | null> {
  if (!isAppPath(new URL(req.url).pathname)) return null;
  const id = readAppCookie(req);
  if (id === null || !SESSION_ID_RE.test(id)) return null;
  const hash = sha256Hex(id);
  const r = await engine.query<SessionRow>(
    `SELECT s.member_id, s.created_at, s.last_seen_at, s.expires_at, m.personal_source_id
       FROM member_web_sessions s JOIN members m ON m.id = s.member_id
      WHERE s.id_hash = $1 AND s.revoked_at IS NULL`,
    [hash],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (toMs(row.expires_at) <= nowMs || toMs(row.last_seen_at) + SESSION_IDLE_MS <= nowMs) return null;
  const access = await memberAccess(engine, [row.member_id]);
  if (access === null || access.refused) {
    await revokeMemberSessions(engine, row.member_id, nowMs);
    return null;
  }
  if (toMs(row.last_seen_at) + TOUCH_EVERY_MS <= nowMs) {
    await engine.query(
      `UPDATE member_web_sessions SET last_seen_at = $2::timestamptz WHERE id_hash = $1 AND last_seen_at < $2::timestamptz`,
      [hash, iso(nowMs)],
    );
  }
  return {
    memberId: row.member_id,
    access,
    personalSourceId: row.personal_source_id,
    readSet: memberReadSet(row.personal_source_id, access.groupSources),
    sessionHash: hash,
  };
}
