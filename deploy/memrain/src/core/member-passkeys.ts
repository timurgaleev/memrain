/**
 * Storage for member passkeys (/app sign-in), a port of the owner's passkey
 * store reduced to what a member needs: one random WebAuthn user handle per
 * member, credentials keyed by their id, and a counter that only moves
 * forward under a compare-and-set.
 *
 * A passkey is only ever created from an invite: the invite is claimed, the
 * passkey stored and the first session started in one transaction, so a
 * failed ceremony spends nothing and a spent invite stores nothing.
 */
import { randomBytes } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import { claimReservedInvite, type InviteFailure } from "./member-invites.ts";
import { createMemberSession } from "./member-sessions.ts";

export interface MemberPasskey {
  id: string;
  memberId: string;
  userHandle: string;
  publicKey: string;
  counter: number;
  transports: string[];
}

export interface NewMemberPasskey {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  label: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The member's WebAuthn user handle, or a fresh one for a first passkey. */
export async function memberUserHandle(engine: Engine, memberId: string): Promise<string> {
  const r = await engine.query<{ user_handle: string }>(
    `SELECT user_handle FROM member_passkeys WHERE member_id = $1 ORDER BY created_at LIMIT 1`,
    [memberId],
  );
  return r.rows[0]?.user_handle ?? randomBytes(32).toString("base64url");
}

export async function listMemberPasskeyIds(engine: Engine, memberId: string): Promise<Array<{ id: string; transports: string[] }>> {
  const r = await engine.query<{ id: string; transports: string[] | null }>(
    `SELECT id, transports FROM member_passkeys WHERE member_id = $1 ORDER BY created_at, id`,
    [memberId],
  );
  return r.rows.map((row) => ({ id: row.id, transports: row.transports ?? [] }));
}

export async function getMemberPasskey(engine: Engine, id: string): Promise<MemberPasskey | null> {
  const r = await engine.query<{
    id: string; member_id: string; user_handle: string; public_key: string; counter: unknown; transports: string[] | null;
  }>(`SELECT id, member_id, user_handle, public_key, counter, transports FROM member_passkeys WHERE id = $1`, [id]);
  const row = r.rows[0];
  return row
    ? { id: row.id, memberId: row.member_id, userHandle: row.user_handle, publicKey: row.public_key, counter: Number(row.counter), transports: row.transports ?? [] }
    : null;
}

export type InsertWithInviteResult =
  | { ok: true; memberId: string; session: { id: string; expiresAt: number } }
  | { ok: false; reason: InviteFailure | "member_mismatch" | "credential_exists" };

/**
 * Claim the invite reserved for `preauthHash`, store the passkey for the
 * invite's member and start a session, all in one transaction. `memberId`
 * is the member the ceremony's options were made for; an invite that names
 * someone else stores nothing.
 */
export async function insertMemberPasskeyWithInvite(
  engine: Engine,
  memberId: string,
  userHandle: string,
  row: NewMemberPasskey,
  invite: { token: string; preauthHash: string },
  nowMs: number = Date.now(),
): Promise<InsertWithInviteResult> {
  return engine.transaction(async (tx) => {
    const claimed = await claimReservedInvite(tx, invite.token, invite.preauthHash, "passkey", nowMs);
    if (!claimed.ok) return claimed;
    if (claimed.memberId !== memberId) throw new RollbackSignal("member_mismatch");
    const ins = await tx.query(
      `INSERT INTO member_passkeys (id, member_id, user_handle, public_key, counter, transports, device_type, backed_up, label, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10::timestamptz)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [row.id, memberId, userHandle, row.publicKey, row.counter, row.transports, row.deviceType, row.backedUp, row.label, iso(nowMs)],
    );
    if (ins.rows.length === 0) throw new RollbackSignal("credential_exists");
    const session = await createMemberSession(tx, memberId, "passkey", nowMs);
    return { ok: true, memberId, session } as const;
  }).catch((e: unknown) => {
    if (e instanceof RollbackSignal) return { ok: false, reason: e.reason } as const;
    throw e;
  });
}

/** Thrown inside a transaction to undo the invite claim, then turned into a result. */
class RollbackSignal extends Error {
  constructor(readonly reason: "member_mismatch" | "credential_exists") {
    super(reason);
  }
}

/** Move the counter from `stored` to `next` only if nobody moved it in between. */
export async function updateMemberCounterCas(
  engine: Engine,
  id: string,
  stored: number,
  next: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const r = await engine.query(
    `UPDATE member_passkeys SET counter = $3, last_used_at = $4::timestamptz
      WHERE id = $1 AND counter = $2 AND ($3 > $2 OR ($2 = 0 AND $3 = 0))
      RETURNING id`,
    [id, stored, next, iso(nowMs)],
  );
  return r.rows.length > 0;
}

/** Delete every passkey of a member. Returns how many. */
export async function deleteMemberPasskeys(engine: Pick<Engine, "query">, memberId: string): Promise<number> {
  const r = await engine.query(`DELETE FROM member_passkeys WHERE member_id = $1 RETURNING id`, [memberId]);
  return r.rows.length;
}
