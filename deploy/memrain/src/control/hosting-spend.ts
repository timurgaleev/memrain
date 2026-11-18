/**
 * The hosting-wide spend cap as a tenant container reaches it: reserve a paid
 * call's worst case with `hosting_reserve` before the call, settle it with
 * `hosting_settle` after (control migration 004). The chokepoint in
 * core/budget.ts is the only caller.
 */
import type { Engine } from "../core/engine/interface.ts";
import { embedTimeoutMs, reasoningTimeoutMs, utilityTimeoutMs } from "../core/llm/gateway.ts";
import { controlClient } from "./policy.ts";

export type HostingReserveResult = { ok: true; id: string } | { ok: false; reason: string };

export interface HostingSpendBackend {
  reserve(usd: number, ttlSeconds: number): Promise<HostingReserveResult>;
  settle(id: string, actualUsd: number): Promise<{ ok: boolean; overrun?: boolean }>;
}

export function controlSpendBackend(control: Pick<Engine, "query">): HostingSpendBackend {
  return {
    async reserve(usd, ttlSeconds) {
      const r = await control.query<{ r: { ok: boolean; id?: string; reason?: string } }>(
        `SELECT hosting_reserve($1::text::numeric, $2::int) AS r`,
        [usd.toFixed(9), ttlSeconds],
      );
      const out = r.rows[0]?.r;
      if (out?.ok && typeof out.id === "string") return { ok: true, id: out.id };
      return { ok: false, reason: out?.reason ?? "no_answer" };
    },
    async settle(id, actualUsd) {
      const r = await control.query<{ r: { ok: boolean; overrun?: boolean } }>(
        `SELECT hosting_settle($1::uuid, $2::text::numeric) AS r`,
        [id, actualUsd.toFixed(9)],
      );
      return r.rows[0]?.r ?? { ok: false };
    },
  };
}

let override: HostingSpendBackend | null = null;

/** Test seam: replace the control-backed backend; null restores it. */
export function setHostingSpendBackend(b: HostingSpendBackend | null): void {
  override = b;
}

export function hostingSpendBackend(): HostingSpendBackend | null {
  if (override) return override;
  const c = controlClient();
  return c ? controlSpendBackend(c) : null;
}

/**
 * How long a reservation stays open before it turns into spend: twice the
 * longest model request timeout plus five minutes, so it never lapses while
 * its call can still be running. The control plane has its own floor too.
 */
export function reservationTtlSeconds(): number {
  const longest = Math.max(utilityTimeoutMs(), reasoningTimeoutMs(), embedTimeoutMs());
  return Math.ceil((2 * longest + 300_000) / 1000);
}
