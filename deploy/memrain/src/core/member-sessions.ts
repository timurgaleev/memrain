/**
 * Member web sessions for /app: the `memrain_app` cookie resolved to an
 * enabled member and the sources that member may read.
 *
 * No member session exists yet, so every request resolves to null and every
 * /app route that needs one refuses it.
 */
import type { Engine } from "./engine/interface.ts";
import type { MemberAccess } from "./members.ts";

export interface MemberSession {
  memberId: string;
  access: MemberAccess;
}

export async function resolveMemberSession(_engine: Engine, _req: Request): Promise<MemberSession | null> {
  return null;
}
