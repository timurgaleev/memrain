import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestCost {
  calls: number;
  known_usd: number;
  unknown_calls: number;
  usd: number | null;
}

type CostListener = (event: "start" | "settle", usd?: number | null) => void;
const costs = new AsyncLocalStorage<readonly CostListener[]>();

export async function withRequestCost<T>(fn: () => Promise<T>): Promise<{ result: T; cost: RequestCost }> {
  let state = { calls: 0, known_usd: 0, unknown_calls: 0 };
  let closed = false;
  const listener: CostListener = (event, usd) => {
    if (closed) return;
    if (event === "start") state = { ...state, calls: state.calls + 1, unknown_calls: state.unknown_calls + 1 };
    else if (usd !== null && usd !== undefined && Number.isFinite(usd) && usd >= 0) {
      state = { ...state, known_usd: state.known_usd + usd, unknown_calls: state.unknown_calls - 1 };
    }
  };
  try {
    const result = await costs.run([...(costs.getStore() ?? []), listener], fn);
    return { result, cost: { ...state, usd: state.unknown_calls ? null : state.known_usd } };
  } finally {
    closed = true;
  }
}

/** An unsettled send remains unknown if the request returns before it finishes. */
export function beginRequestCost(): (usd: number | null) => void {
  const listeners = costs.getStore() ?? [];
  for (const listener of listeners) listener("start");
  let settled = false;
  return usd => {
    if (settled) return;
    settled = true;
    for (const listener of listeners) listener("settle", usd);
  };
}
