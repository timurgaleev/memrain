/**
 * Usage per tenant and day, for billing later: seats, live pages, paid model
 * spend and database size. Written to a sink and nowhere else; nothing here
 * makes a network call. A day reported twice replaces its earlier lines, so a
 * rerun is harmless.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Engine } from "../core/engine/interface.ts";
import { asTenantOwner } from "./tenant-session.ts";
import { requireTenant } from "./tenants.ts";

export type UsageMetric = "seats" | "pages" | "llm_usd" | "storage_bytes";

export interface UsageEvent {
  tenant: string;
  /** UTC day, YYYY-MM-DD. */
  date: string;
  metric: UsageMetric;
  value: number;
}

export interface UsageSink {
  write(events: readonly UsageEvent[]): Promise<void>;
}

export const noopSink: UsageSink = { write: async () => {} };

/** One JSON object per line; a (tenant, date, metric) written again replaces the old line. */
export class JsonlFileSink implements UsageSink {
  constructor(private readonly path: string) {}

  async write(events: readonly UsageEvent[]): Promise<void> {
    const key = (e: UsageEvent) => `${e.tenant}\u0000${e.date}\u0000${e.metric}`;
    const replaced = new Set(events.map(key));
    const kept = existsSync(this.path)
      ? readFileSync(this.path, "utf8").split("\n").filter((l) => l.trim() !== "")
        .filter((l) => !replaced.has(key(JSON.parse(l) as UsageEvent)))
      : [];
    const lines = [...kept, ...events.map((e) => JSON.stringify(e))];
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A tenant's usage on `date`. Seats, pages and size are read now; spend is the day's. */
export async function tenantUsage(ctx: { masterUrl: string; control: Engine }, id: string, date: string): Promise<UsageEvent[]> {
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`date must be YYYY-MM-DD, got '${date}'`);
  const t = await requireTenant(ctx.control, id);
  const spend = await ctx.control.query<{ usd: string | null }>(
    `SELECT spent_usd::text AS usd FROM tenant_spend_windows WHERE tenant_id = $1 AND day = $2::date`,
    [id, date],
  );
  const size = await ctx.control.query<{ bytes: string }>(`SELECT pg_database_size($1)::text AS bytes`, [t.dbName]);
  return asTenantOwner(ctx.masterUrl, id, async (brain) => {
    const seats = await brain.query<{ n: number }>(`SELECT count(*)::int AS n FROM members WHERE status = 'enabled'`);
    const pages = await brain.query<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL`);
    return [
      { tenant: id, date, metric: "seats", value: seats.rows[0]?.n ?? 0 },
      { tenant: id, date, metric: "pages", value: pages.rows[0]?.n ?? 0 },
      { tenant: id, date, metric: "llm_usd", value: Number(spend.rows[0]?.usd ?? 0) },
      { tenant: id, date, metric: "storage_bytes", value: Number(size.rows[0]?.bytes ?? 0) },
    ];
  });
}

/** Per day and tenant: what the hosting spend windows hold. */
export async function spendSummary(control: Engine, days: number): Promise<{
  days: { day: string; cap_usd: number; spent_usd: number; reserved_usd: number; llm_off: boolean }[];
  tenants: { tenant: string; day: string; spent_usd: number; reserved_usd: number }[];
  overruns: { tenant: string; at: string; detail: Record<string, unknown> }[];
}> {
  const since = `${Math.max(1, Math.floor(days))} days`;
  const d = await control.query<{ day: string; cap_usd: string; spent_usd: string; reserved_usd: string; llm_off: boolean }>(
    `SELECT day::text, cap_usd::text, spent_usd::text, reserved_usd::text, llm_off FROM hosting_spend_windows
      WHERE day > (now() AT TIME ZONE 'UTC')::date - $1::interval ORDER BY day DESC`,
    [since],
  );
  const t = await control.query<{ tenant: string; day: string; spent_usd: string; reserved_usd: string }>(
    `SELECT tenant_id AS tenant, day::text, spent_usd::text, reserved_usd::text FROM tenant_spend_windows
      WHERE day > (now() AT TIME ZONE 'UTC')::date - $1::interval ORDER BY day DESC, tenant_id`,
    [since],
  );
  const o = await control.query<{ tenant: string; at: string; detail: Record<string, unknown> | string }>(
    `SELECT tenant_id AS tenant, at::text, detail FROM tenant_events
      WHERE kind = 'hosting_overrun' AND at > now() - $1::interval ORDER BY at DESC`,
    [since],
  );
  return {
    days: d.rows.map((r) => ({ day: r.day, cap_usd: Number(r.cap_usd), spent_usd: Number(r.spent_usd), reserved_usd: Number(r.reserved_usd), llm_off: r.llm_off })),
    tenants: t.rows.map((r) => ({ tenant: r.tenant, day: r.day, spent_usd: Number(r.spent_usd), reserved_usd: Number(r.reserved_usd) })),
    overruns: o.rows.map((r) => ({ tenant: r.tenant, at: r.at, detail: typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail })),
  };
}

/** The operator's hosting-wide switches: the daily cap and paid calls on or off. */
export async function setHostingCap(control: Engine, opts: { capUsd?: number; llmOff?: boolean }): Promise<void> {
  await control.transaction(async (tx) => {
    if (opts.capUsd !== undefined) {
      if (!Number.isFinite(opts.capUsd) || opts.capUsd < 0) throw new Error("the cap must be a non-negative USD amount");
      await tx.query(`UPDATE hosting_settings SET cap_usd = $1::text::numeric, updated_at = now()`, [String(opts.capUsd)]);
      await tx.query(
        `UPDATE hosting_spend_windows SET cap_usd = $1::text::numeric WHERE day = (now() AT TIME ZONE 'UTC')::date`,
        [String(opts.capUsd)],
      );
    }
    if (opts.llmOff !== undefined) {
      await tx.query(`UPDATE hosting_settings SET llm_off = $1, updated_at = now()`, [opts.llmOff]);
      // Turning paid calls back on also clears today's overrun switch: the
      // operator has seen it.
      if (!opts.llmOff) await tx.query(`UPDATE hosting_spend_windows SET llm_off = false WHERE day = (now() AT TIME ZONE 'UTC')::date`);
    }
  });
}

/** Record that the isolation smoke passed for tenant `id`'s container (master role only). */
export async function recordSmoke(control: Engine, id: string, stamp: { startedAt: Date; bootId: string; imageStamp: string }): Promise<void> {
  await requireTenant(control, id);
  if (Number.isNaN(stamp.startedAt.getTime()) || stamp.startedAt.getTime() > Date.now() + 60_000) {
    throw new Error("--started-at must be the container's start time, not in the future");
  }
  if (!/^[0-9a-f-]{8,64}$/i.test(stamp.bootId)) throw new Error("--boot-id must be the host's /proc/sys/kernel/random/boot_id");
  if (!/^[\w.+-]{1,100}$/.test(stamp.imageStamp)) throw new Error("--image-stamp must be the image's version stamp");
  await control.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO tenant_isolation (tenant_id, container_started_at, boot_id, image_stamp, passed_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id) DO UPDATE SET container_started_at = EXCLUDED.container_started_at,
         boot_id = EXCLUDED.boot_id, image_stamp = EXCLUDED.image_stamp, passed_at = now()`,
      [id, stamp.startedAt.toISOString(), stamp.bootId, stamp.imageStamp],
    );
    await tx.query(`INSERT INTO tenant_events (tenant_id, kind, detail) VALUES ($1, 'smoke', $2::text::jsonb)`, [
      id,
      JSON.stringify({ boot_id: stamp.bootId, image_stamp: stamp.imageStamp }),
    ]);
  });
}
