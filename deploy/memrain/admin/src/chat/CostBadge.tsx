import { fmtCost, fmtDuration } from "./copy.ts";

/** What one answer cost, which model gave it, and how long it took. */
export function CostBadge({ costUsd, model, durationMs }: { costUsd: number | null; model: string | null; durationMs: number | null }) {
  const parts = [fmtCost(costUsd), model, fmtDuration(durationMs)].filter((p): p is string => !!p);
  return <span className="chat-cost num">{parts.join(" · ")}</span>;
}
