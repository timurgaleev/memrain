/**
 * One read of the brain's access settings per remote request: whom the brain
 * serves, who its owner is, and which sources are owner-only. Dispatch builds
 * the caller's access from it once, so every read path sees the same answer.
 *
 * A brain serves several people when two or more members are enabled, or
 * when config `access.serves` says `several`. Nothing turns that off while
 * two people hold enabled members: an unbound key must never read as if the
 * brain were one person's.
 */
import type { Engine } from "./engine/interface.ts";
import { OWNER_MEMBER_KEY } from "./brain-owner.ts";
import type { AuthInfo } from "./auth-info.ts";
import { OperationError } from "./operation-error.ts";

export const SERVES_KEY = "access.serves";

export interface ServesPolicy {
  several: boolean;
  /** `config` when access.serves decided it, `members` when the enabled-member count did. */
  from: "config" | "members";
  enabledMembers: number;
}

export interface BrainAccess {
  serves: ServesPolicy;
  /** The configured owner while it is an enabled member, else null. */
  ownerMember: string | null;
  /** Sources marked owner-only (sources.owner_only). */
  ownerOnlySources: string[];
  /** Every source id, for narrowing an unscoped grant. */
  allSources: string[];
}

export function servesPolicyFrom(explicit: string | null | undefined, enabledMembers: number): ServesPolicy {
  if (enabledMembers >= 2) return { several: true, from: "members", enabledMembers };
  const several = explicit?.trim().toLowerCase() === "several";
  return { several, from: several ? "config" : "members", enabledMembers };
}

export async function readBrainAccess(engine: Pick<Engine, "query">): Promise<BrainAccess> {
  const r = await engine.query<{ serves: string | null; enabled: number; owner: string | null; owner_only: string[] | null; all_sources: string[] | null }>(
    // scope: operator-only reads the brain's access settings, never page content
    `SELECT (SELECT value FROM config WHERE key = $1) AS serves,
            (SELECT count(*)::int FROM members WHERE status = 'enabled') AS enabled,
            (SELECT m.id FROM config c JOIN members m ON m.id = btrim(c.value) AND m.status = 'enabled'
              WHERE c.key = $2) AS owner,
            COALESCE((SELECT array_agg(id ORDER BY id) FROM sources WHERE owner_only), '{}') AS owner_only,
            COALESCE((SELECT array_agg(id ORDER BY id) FROM sources), '{}') AS all_sources`,
    [SERVES_KEY, OWNER_MEMBER_KEY],
  );
  const row = r.rows[0];
  return {
    serves: servesPolicyFrom(row?.serves, Number(row?.enabled ?? 0)),
    ownerMember: row?.owner ?? null,
    ownerOnlySources: Array.isArray(row?.owner_only) ? row.owner_only : [],
    allSources: Array.isArray(row?.all_sources) ? row.all_sources : [],
  };
}

export async function readServesPolicy(engine: Pick<Engine, "query">): Promise<ServesPolicy> {
  return (await readBrainAccess(engine)).serves;
}

/** A credential bound to the live owner member reads as the owner. The public ingress never does. */
export function callerIsOwner(auth: Pick<AuthInfo, "memberId" | "isPublic"> | undefined, access: Pick<BrainAccess, "ownerMember">): boolean {
  return auth !== undefined && auth.isPublic !== true && access.ownerMember !== null && auth.memberId === access.ownerMember;
}

/** How one request may read: resolved once per tool call in dispatch. */
export interface CallerAccess {
  /** The caller reads as the brain owner. */
  owner: boolean;
  /** The brain's access settings; null for the trusted operator path, which never reads them. */
  brain: BrainAccess | null;
}

export const OPERATOR_ACCESS: CallerAccess = { owner: false, brain: null };

/**
 * The trusted operator path (no credential, not the public ingress) reads no
 * settings. Every other caller does; a failed read is refused rather than
 * guessed, since guessing "one person, no owner-only source" would open them.
 */
export async function resolveCallerAccess(engine: () => Pick<Engine, "query">, auth: AuthInfo | undefined, isPublic: boolean): Promise<CallerAccess> {
  if (auth === undefined && !isPublic) return OPERATOR_ACCESS;
  let brain: BrainAccess;
  try {
    brain = await readBrainAccess(engine());
  } catch {
    throw new OperationError(
      "storage_error",
      "the brain's access settings could not be read, so nothing was read",
      "Retry the same call in a few seconds; the brain host's operator checks the database with memrain doctor.",
    );
  }
  return { owner: callerIsOwner(isPublic ? undefined : auth, brain), brain };
}
