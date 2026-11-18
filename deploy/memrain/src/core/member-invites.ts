/**
 * One-time member invites: a link that lets a member register a passkey for
 * /app. The token travels in the URL fragment, so proxy and server logs never
 * see it, and only its hash is stored.
 *
 * Minting is not available yet; it refuses with `not_implemented`.
 */
import type { Engine } from "./engine/interface.ts";

export type MemberInviteErrorCode = "not_implemented";

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

export async function mintMemberInvite(_engine: Engine, memberId: string, _ttlMs: number): Promise<MemberInvite> {
  throw new MemberInviteError("not_implemented", `member invites are not available yet (member '${memberId}')`);
}

export function memberInviteUrl(publicUrl: string, token: string): string {
  let end = publicUrl.length;
  while (end > 0 && publicUrl[end - 1] === "/") end--;
  return `${publicUrl.slice(0, end)}/app/invite#${token}`;
}
