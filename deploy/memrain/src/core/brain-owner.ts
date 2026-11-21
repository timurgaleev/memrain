/**
 * The brain owner. On a personal brain the owner's own agents must read the
 * whole brain, private facts included, while every other remote caller keeps
 * the ordinary read policy. The owner is named explicitly, never guessed:
 * config `access.owner_member` holds one member id, and a credential bound to
 * that enabled member reads as the owner (mcp/dispatch.ts). Owner reads widen
 * visibility only: the credential's source grant, its takes-holder list and
 * the operator-only tools stay as they are.
 *
 * A single-person install marks its owner token in three local CLI steps:
 *   memrain member add <id>
 *   memrain member bind <id> --token <name>
 *   memrain member owner <id>
 * Only the trusted local CLI writes the setting; no MCP operation does.
 */
import type { Engine } from "./engine/interface.ts";
import { existingMember, MemberError, MEMBER_ID_RE, boundCredentials, type CredentialRef } from "./members.ts";

export const OWNER_MEMBER_KEY = "access.owner_member";

export interface OwnerView {
  owner: string | null;
  /** The configured value when it names no enabled member: no caller reads as the owner. */
  inactive?: { value: string; reason: string };
  bound_credentials: CredentialRef[];
}

async function readConfig(engine: Pick<Engine, "query">, key: string): Promise<string | null> {
  const r = await engine.query<{ value: string }>(`SELECT value FROM config WHERE key = $1`, [key]);
  return r.rows[0]?.value ?? null;
}

/** The configured owner member id, or null when unset or ill-formed (fail closed). */
export async function ownerMemberId(engine: Pick<Engine, "query">): Promise<string | null> {
  try {
    const raw = (await readConfig(engine, OWNER_MEMBER_KEY))?.trim();
    return raw && MEMBER_ID_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** The configured owner, whether it is live, and the credentials that read as it. */
export async function ownerView(engine: Engine): Promise<OwnerView> {
  const raw = (await readConfig(engine, OWNER_MEMBER_KEY))?.trim() ?? "";
  if (!raw) return { owner: null, bound_credentials: [] };
  try {
    const member = await existingMember(engine, raw);
    if (member.status !== "enabled") throw new MemberError("member_not_enabled", `member "${member.id}" is ${member.status}`);
    return { owner: member.id, bound_credentials: await boundCredentials(engine, member.id) };
  } catch (e) {
    return { owner: null, inactive: { value: raw, reason: e instanceof Error ? e.message : String(e) }, bound_credentials: [] };
  }
}

/** Names the owner; refuses an ill-formed, unknown or non-enabled member before writing anything. */
export async function setOwner(engine: Engine, raw: unknown): Promise<OwnerView> {
  const member = await existingMember(engine, raw);
  if (member.status !== "enabled") {
    throw new MemberError("member_not_enabled", `member "${member.id}" is ${member.status}; only an enabled member can be the owner`);
  }
  await engine.query(
    `INSERT INTO config (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [OWNER_MEMBER_KEY, member.id],
  );
  return ownerView(engine);
}

/** Names no owner: every caller reads under the ordinary policy again. */
export async function clearOwner(engine: Engine): Promise<OwnerView> {
  await engine.query(`DELETE FROM config WHERE key = $1`, [OWNER_MEMBER_KEY]);
  return { owner: null, bound_credentials: [] };
}
