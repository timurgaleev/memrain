/**
 * Read floors (migration 186): how each tool treats a credential that may
 * read only rows at or above a trust tier (`AuthInfo.minTrust`).
 *
 *   filtered   applies the floor in its own query, at the stricter of the
 *              floor and the call's `min_trust`
 *   text-free  returns no stored text (identity, counts, status, catalogs)
 *   refused    everything else that is not a plain write: it would return
 *              stored text it cannot filter by tier, so a floored credential
 *              neither sees it in tools/list nor may call it
 *
 * A tool added later is refused under a floor until it is classified here.
 */
import { lowerTier, type TrustTier } from "../core/trust-tier.ts";
import { OPERATIONS } from "./operations.ts";

export const READ_FLOOR_FILTERED: ReadonlySet<string> = new Set(["search", "query", "context_pack"]);

export const READ_FLOOR_TEXT_FREE: ReadonlySet<string> = new Set([
  "whoami",
  "get_brain_identity",
  "stats",
  "source_health",
  "sources_list",
  "sources_status",
  "list_link_sources",
  "list_skills",
  "get_skill",
  "list_brain_skillpack",
  "daemons_status",
]);

/** Write tools whose answer is text they read from the brain: a dry run's
 *  `before` row, an edit diff's context lines, a duplicate's stored event. */
const WRITES_THAT_READ: ReadonlySet<string> = new Set([
  "think",
  "extract_facts",
  "takes_add",
  "takes_update",
  "takes_resolve",
  "page_edit",
  "add_timeline_event",
]);

const SCOPE_BY_NAME = new Map(OPERATIONS.map((o) => [o.name, o.scope ?? "read"]));

/** True when a credential with a read floor may not call `name`. */
export function refusedUnderFloor(name: string): boolean {
  if (READ_FLOOR_FILTERED.has(name) || READ_FLOOR_TEXT_FREE.has(name)) return false;
  return SCOPE_BY_NAME.get(name) !== "write" || WRITES_THAT_READ.has(name);
}

/** The stricter of a credential's floor and a call's `min_trust`. */
export function strictestFloor(floor: TrustTier, requested: unknown): TrustTier {
  if (requested !== "owner" && requested !== "member" && requested !== "agent") return floor;
  // The stricter floor is the more trusted tier: the one the lower of the two is not.
  return lowerTier(floor, requested) === floor ? requested : floor;
}
