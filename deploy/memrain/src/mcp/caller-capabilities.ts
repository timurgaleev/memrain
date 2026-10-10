/**
 * What one caller may do, as `whoami` reports it beyond identity: the write
 * fence, the takes-holder filter, the daily spend cap and what has been spent
 * against it today, and the exact set of tools the caller can call.
 *
 * `callable_tools` comes from the same predicate as `tools/list` (see
 * visibility.ts), so whoami can never claim a tool the caller would be
 * refused. A caller without `authInfo` (operator, public bearer, bridge)
 * carries no per-principal knobs: every one of them reads as null.
 */
import type { AuthInfo } from "../core/auth-info.ts";
import { checkClientBudget } from "../core/budget.ts";
import type { Engine } from "../core/engine/interface.ts";
import { visibleToolDefs } from "./visibility.ts";

export interface DescribeCallerInput {
  authInfo: AuthInfo | undefined;
  isPublic: boolean;
  /** The ingress denylist (isPublicMcpToolForbidden in production). */
  forbidPublic: (toolName: string) => boolean;
  /** False only when the internal token is configured and was not sent. */
  internalAuthOk?: boolean;
  /** Clock seam for the spend day boundary (tests). */
  now?: Date;
}

export interface CallerCapabilities {
  /**
   * True for the trusted operator path: no per-principal grant, not over the
   * public ingress, and past the internal-token wall. The public bearer and an
   * anonymous bridge carry no grant either but are walled, so they are not.
   */
  operator: boolean;
  /** Slug prefixes this principal's writes are fenced to; null = unbounded. */
  bound_slug_prefixes: string[] | null;
  /** Takes holders this principal reads; null = unfiltered. */
  takes_holders: string[] | null;
  /** Daily spend cap in USD; null = uncapped (always null without a grant). */
  budget_usd_per_day: number | null;
  /** Spend so far in the current UTC day, held reservations included; null without a grant. */
  spent_today_usd: number | null;
  /** The key spend is booked under (an enrollment id or the client id); null without a grant. */
  spend_id: string | null;
  /** Every tool this caller can call, in tools/list order. */
  callable_tools: string[];
}

export async function describeCaller(
  engine: Engine,
  input: DescribeCallerInput,
): Promise<CallerCapabilities> {
  const { authInfo } = input;
  const callable_tools = visibleToolDefs(
    {
      isPublic: input.isPublic,
      ...(input.internalAuthOk !== undefined ? { internalAuthOk: input.internalAuthOk } : {}),
      ...(authInfo !== undefined ? { authInfo } : {}),
    },
    input.forbidPublic,
  ).map((t) => t.name);

  if (authInfo === undefined) {
    return {
      operator: !input.isPublic && input.internalAuthOk !== false,
      bound_slug_prefixes: null,
      takes_holders: null,
      budget_usd_per_day: null,
      spent_today_usd: null,
      spend_id: null,
      callable_tools,
    };
  }

  const spendId = authInfo.spendId ?? authInfo.clientId;
  // A cap resolved with the token is reused; undefined means "not resolved",
  // and the budget check looks it up the way the spend chokepoint does.
  const budget = await checkClientBudget(engine, spendId, input.now ?? new Date(), authInfo.budgetUsdPerDay);
  const bound = authInfo.boundSlugPrefixes;
  return {
    operator: false,
    bound_slug_prefixes: bound !== undefined && bound.length > 0 ? [...bound] : null,
    takes_holders: authInfo.takesHolders !== undefined ? [...authInfo.takesHolders] : null,
    budget_usd_per_day: budget.capUsd,
    spent_today_usd: budget.spentUsd,
    spend_id: spendId,
    callable_tools,
  };
}
