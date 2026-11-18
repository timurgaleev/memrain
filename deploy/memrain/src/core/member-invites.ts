/**
 * One-time member invites: a link that lets a member register a passkey for
 * /app. The token travels in the URL fragment, so proxy and server logs never
 * see it, and only its hash is stored.
 *
 * A member is invited only when enabled and holding a personal source, since
 * /app writes nowhere else. Minting a new invite revokes the member's earlier
 * unused ones, so only one link is live per member.
 *
 * Opening the link reserves it for that browser (the hash of its pre-auth id)
 * for 15 minutes; the same browser may reopen it, another one waits for the
 * lease to lapse. The reservation is consumed in the transaction that stores
 * the passkey (member-passkeys.ts) or, on a device without one, that starts a
 * single 7-day session.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import { getMember } from "./members.ts";
import { createMemberSession } from "./member-sessions.ts";

export type MemberInviteErrorCode =
  | "not_implemented"
  | "not_found"
  | "member_not_enabled"
  | "member_not_ready"
  | "invalid_ttl";

export class MemberInviteError extends Error {
  constructor(public readonly code: MemberInviteErrorCode, message: string) {
    super(message);
    this.name = "MemberInviteError";
  }
}

export interface MemberInvite {
  inviteId: string;
  memberId: string;
  /** Shown once; the database keeps only its hash. */
  token: string;
  expiresAt: Date;
}

const MINUTE = 60_000;
export const INVITE_DEFAULT_TTL_MS = 72 * 60 * MINUTE;
export const INVITE_MAX_TTL_MS = 30 * 24 * 60 * MINUTE;
export const INVITE_LEASE_MS = 15 * MINUTE;
const TOKEN_RE = /^[\w-]{43}$/;

const sha256Hex = (v: string): string => createHash("sha256").update(v, "utf8").digest("hex");
const iso = (ms: number): string => new Date(ms).toISOString();

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return new Date(String(v)).getTime();
}

export async function mintMemberInvite(
  engine: Engine,
  memberId: string,
  ttlMs: number,
  opts: { createdBy?: string; nowMs?: number } = {},
): Promise<MemberInvite> {
  if (!Number.isFinite(ttlMs) || ttlMs < MINUTE || ttlMs > INVITE_MAX_TTL_MS) {
    throw new MemberInviteError("invalid_ttl", "an invite lives between one minute and 30 days");
  }
  const member = await getMember(engine, memberId);
  if (!member) throw new MemberInviteError("not_found", `no member "${memberId}"`);
  if (member.status !== "enabled") {
    throw new MemberInviteError("member_not_enabled", `member "${member.id}" is ${member.status}; only an enabled member can be invited`);
  }
  if (!member.personal_source_id) {
    throw new MemberInviteError(
      "member_not_ready",
      `member "${member.id}" has no personal source; /app writes only there (memrain member add … --personal-source SRC)`,
    );
  }
  const nowMs = opts.nowMs ?? Date.now();
  const token = randomBytes(32).toString("base64url");
  const inviteId = `minv_${randomBytes(12).toString("hex")}`;
  const expiresAt = nowMs + ttlMs;
  await engine.transaction(async (tx) => {
    // The member row lock serializes two mints, so only one link stays live.
    await tx.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [member.id]);
    await tx.query(
      `UPDATE member_invites SET revoked_at = $2::timestamptz WHERE member_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [member.id, iso(nowMs)],
    );
    await tx.query(
      `INSERT INTO member_invites (id, member_id, token_hash, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
      [inviteId, member.id, sha256Hex(token), opts.createdBy ?? "operator", iso(nowMs), iso(expiresAt)],
    );
  });
  return { inviteId, memberId: member.id, token, expiresAt: new Date(expiresAt) };
}

export function memberInviteUrl(publicUrl: string, token: string): string {
  let end = publicUrl.length;
  while (end > 0 && publicUrl[end - 1] === "/") end--;
  return `${publicUrl.slice(0, end)}/app/invite#${token}`;
}

export type InviteFailure = "unknown" | "used" | "expired" | "revoked" | "reserved" | "not_ready";

export type OpenInviteResult =
  | { ok: true; inviteId: string; memberId: string; displayName: string | null; until: number }
  | { ok: false; reason: InviteFailure };

interface InviteRow {
  id: string;
  member_id: string;
  expires_at: unknown;
  used_at: unknown;
  revoked_at: unknown;
  reserved_for: string | null;
  reserved_until: unknown;
}

function stateOf(row: InviteRow, nowMs: number): InviteFailure | null {
  if (row.used_at !== null) return "used";
  if (row.revoked_at !== null) return "revoked";
  if (toMs(row.expires_at) <= nowMs) return "expired";
  return null;
}

/**
 * Reserve the invite for the browser `preauthHash` and record when it was
 * first opened. A member who is no longer enabled, or lost the personal
 * source, cannot use the link.
 */
export async function openMemberInvite(
  engine: Engine,
  token: string,
  preauthHash: string,
  nowMs: number = Date.now(),
): Promise<OpenInviteResult> {
  if (!TOKEN_RE.test(token)) return { ok: false, reason: "unknown" };
  return engine.transaction(async (tx) => {
    const r = await tx.query<InviteRow>(
      `SELECT id, member_id, expires_at, used_at, revoked_at, reserved_for, reserved_until
         FROM member_invites WHERE token_hash = $1 FOR UPDATE`,
      [sha256Hex(token)],
    );
    const row = r.rows[0];
    if (!row) return { ok: false, reason: "unknown" } as const;
    const state = stateOf(row, nowMs);
    if (state) return { ok: false, reason: state } as const;
    const held = row.reserved_for !== null && row.reserved_until !== null && toMs(row.reserved_until) > nowMs;
    if (held && row.reserved_for !== preauthHash) return { ok: false, reason: "reserved" } as const;
    const member = await getMember(tx, row.member_id);
    if (!member || member.status !== "enabled" || !member.personal_source_id) return { ok: false, reason: "not_ready" } as const;
    const until = held ? toMs(row.reserved_until) : nowMs + INVITE_LEASE_MS;
    await tx.query(
      `UPDATE member_invites
          SET reserved_for = $2, reserved_until = $3::timestamptz, opened_at = COALESCE(opened_at, $4::timestamptz)
        WHERE id = $1`,
      [row.id, preauthHash, iso(until), iso(nowMs)],
    );
    return { ok: true, inviteId: row.id, memberId: row.member_id, displayName: member.display_name, until } as const;
  });
}

/**
 * Claim the invite reserved for `preauthHash` inside `tx`: the caller stores
 * what the invite pays for (a passkey, a session) in the same transaction.
 */
export async function claimReservedInvite(
  tx: Engine,
  token: string,
  preauthHash: string,
  via: "passkey" | "no_passkey",
  nowMs: number,
): Promise<{ ok: true; inviteId: string; memberId: string } | { ok: false; reason: InviteFailure }> {
  if (!TOKEN_RE.test(token)) return { ok: false, reason: "unknown" };
  const r = await tx.query<InviteRow>(
    `SELECT id, member_id, expires_at, used_at, revoked_at, reserved_for, reserved_until
       FROM member_invites WHERE token_hash = $1 FOR UPDATE`,
    [sha256Hex(token)],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, reason: "unknown" };
  const state = stateOf(row, nowMs);
  if (state) return { ok: false, reason: state };
  if (row.reserved_for !== preauthHash || row.reserved_until === null || toMs(row.reserved_until) <= nowMs) {
    return { ok: false, reason: "reserved" };
  }
  const member = await getMember(tx, row.member_id);
  if (!member || member.status !== "enabled" || !member.personal_source_id) return { ok: false, reason: "not_ready" };
  await tx.query(
    `UPDATE member_invites SET used_at = $2::timestamptz, used_via = $3 WHERE id = $1`,
    [row.id, iso(nowMs), via],
  );
  return { ok: true, inviteId: row.id, memberId: row.member_id };
}

/**
 * The fallback for a device that cannot hold a passkey: the invite buys one
 * session of 7 days and is spent. Signing in again takes a new invite.
 */
export async function redeemInviteWithoutPasskey(
  engine: Engine,
  token: string,
  preauthHash: string,
  nowMs: number = Date.now(),
): Promise<{ ok: true; memberId: string; session: { id: string; expiresAt: number } } | { ok: false; reason: InviteFailure }> {
  return engine.transaction(async (tx) => {
    const claimed = await claimReservedInvite(tx, token, preauthHash, "no_passkey", nowMs);
    if (!claimed.ok) return claimed;
    const session = await createMemberSession(tx, claimed.memberId, "invite", nowMs);
    return { ok: true, memberId: claimed.memberId, session } as const;
  });
}
