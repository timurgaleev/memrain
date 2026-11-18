/**
 * The plan's page and member limits of a hosted brain, counted in its own
 * database. Kept apart from tenant-guard.ts so the page write path can call it
 * without importing the MCP operation registry.
 *
 * Every table is named with its schema: the tenant owns its database and could
 * set a search_path whose own `pages` would answer the count instead.
 */
import { hostingMode } from "../control/contract.ts";
import { hostedPolicy } from "../control/policy.ts";
import type { Engine } from "./engine/interface.ts";
import { OperationError } from "./operation-error.ts";

/** Serialises every page-adding write of one brain while a page limit is in force. */
const PAGE_ROOM_LOCK = "memrain:page-room";

export function limitReached(what: string): OperationError {
  return new OperationError(
    "tenant_limit_reached",
    `this brain has reached its plan's ${what} limit`,
    "Delete what you no longer need, or ask the operator to raise the limit.",
  );
}

/** Throws `tenant_limit_reached` when `adding` more live pages would pass the plan's maximum. */
export async function assertPageRoom(engine: Pick<Engine, "query">, maxPages: number | undefined, adding = 1): Promise<void> {
  if (maxPages === undefined || adding <= 0) return;
  // scope: operator-only the plan's page limit counts the whole brain; only a yes/no leaves here
  const r = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.pages WHERE deleted_at IS NULL`);
  if ((r.rows[0]?.n ?? 0) + adding > maxPages) throw limitReached("page");
}

/**
 * Inside the transaction that is about to add a live page: in a hosted brain
 * with a page limit, take the brain-wide page-room lock and count again, so
 * two writers cannot both take the last free place. The lock is
 * transaction-scoped (safe behind a pooler) and released at commit. Outside
 * hosting mode it does nothing and reads nothing.
 */
export async function assertPageRoomInTx(tx: Pick<Engine, "query">): Promise<void> {
  if (hostingMode() === null) return;
  const max = (await hostedPolicy())?.limits.maxPages;
  if (max === undefined) return;
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [PAGE_ROOM_LOCK]);
  await assertPageRoom(tx, max);
}
