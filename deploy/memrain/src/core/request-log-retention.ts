/**
 * Retention for `mcp_request_log`. Every caller with a credential (OAuth or
 * personal access token) and every admin-panel tool call is logged there
 * whatever MEMRAIN_REQUEST_LOG_DB says, so without pruning the table grows by
 * one row per call for good.
 *
 * MEMRAIN_REQUEST_LOG_RETENTION_DAYS sets the window: default 180, which is
 * the oldest day the Overview charts read (a 90-day view plus its 90-day
 * comparison period). `0` keeps every row. 1 to 6 are raised to 7 so the
 * 7-day latency windows stay whole; anything above 36500 is lowered to it.
 * The env var is read per call (not memoised at import) so tests can flip it.
 */
import type { Engine } from "./engine/interface.ts";

export const REQUEST_LOG_RETENTION_DEFAULT_DAYS = 180;
const MIN_DAYS = 7;
/** 100 years; a larger window would push the cutoff past what a timestamp holds. */
const MAX_DAYS = 36_500;
export const BATCH = 5000;
/** Caps one run at BATCH × MAX_BATCHES_PER_RUN rows; the next cycle carries on. */
export const MAX_BATCHES_PER_RUN = 100;

const ENV = "MEMRAIN_REQUEST_LOG_RETENTION_DAYS";
const warned = new Set<string>();

function warnOnce(raw: string, message: string): void {
  if (warned.has(raw)) return;
  warned.add(raw);
  console.error(`[memrain] ${ENV}="${raw}" ${message}`);
}

/** The retention window in days, or null when retention is off. */
export function requestLogRetentionDays(): number | null {
  const raw = (process.env[ENV] ?? "").trim();
  if (raw === "") return REQUEST_LOG_RETENTION_DEFAULT_DAYS;
  if (!/^\d+$/.test(raw)) {
    warnOnce(raw, `is not a whole number of days; using ${REQUEST_LOG_RETENTION_DEFAULT_DAYS}`);
    return REQUEST_LOG_RETENTION_DEFAULT_DAYS;
  }
  const days = Number(raw);
  if (days === 0) return null;
  if (days < MIN_DAYS) {
    warnOnce(raw, `is below the ${MIN_DAYS}-day minimum; using ${MIN_DAYS}`);
    return MIN_DAYS;
  }
  if (days > MAX_DAYS) {
    warnOnce(raw, `is above the ${MAX_DAYS}-day maximum; using ${MAX_DAYS}`);
    return MAX_DAYS;
  }
  return days;
}

/**
 * Delete rows older than the window in batches of BATCH, oldest first. The
 * cutoff is fixed once per run, so rows written during the run are never
 * touched. `between` runs after each full batch (the purge phase passes its
 * fence check). Errors are not swallowed: the caller reports them.
 */
export async function purgeRequestLog(
  engine: Engine,
  opts: { days?: number | null; now?: Date; between?: () => Promise<void> } = {},
): Promise<{ deleted: number; capped: boolean }> {
  const days = opts.days === undefined ? requestLogRetentionDays() : opts.days;
  if (days === null) return { deleted: 0, capped: false };
  const cutoff = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000).toISOString();
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    if (i > 0) await opts.between?.();
    const r = await engine.query<{ n: string }>(
      `WITH doomed AS (
         SELECT id FROM mcp_request_log
          WHERE created_at < $1::timestamptz
          ORDER BY created_at
          LIMIT $2
       ), gone AS (
         DELETE FROM mcp_request_log l USING doomed d WHERE l.id = d.id RETURNING 1
       )
       SELECT count(*)::text AS n FROM gone`,
      [cutoff, BATCH],
    );
    const n = Number(r.rows[0]?.n ?? 0);
    deleted += n;
    if (n < BATCH) return { deleted, capped: false };
  }
  return { deleted, capped: true };
}
