/**
 * Hourly housekeeping: the deterministic upkeep a brain needs while it serves.
 *
 *   purge          documents and pages soft-deleted past their TTL, with what
 *                  was derived from them (pages-purge.ts, destructive-guard.ts)
 *   mirror_pages   live pages whose search mirror is missing or stale get it
 *                  rebuilt; a page write whose inline mirror failed lands here
 *   embed_gaps     chunks written without a vector (a spent budget, a passing
 *                  Bedrock failure) get one, at most MEMRAIN_EMBED_GAPS_MAX_PER_RUN
 *   tokens         expired OAuth tokens, codes and refresh tombstones
 *   reservations   spend reservations a crashed call never settled
 *   retention      request-log rows past MEMRAIN_REQUEST_LOG_RETENTION_DAYS,
 *                  write receipts past their replay window, and chat history
 *                  a 2.x brain kept, past MEMRAIN_CHAT_RETENTION_DAYS
 *
 * One process does it at a time: the run holds the `memrain-cycle` row in
 * `cycle_locks`, the lock a 2.x maintenance cycle takes, so the two never
 * overlap on a shared database. A step that fails is recorded and the next
 * one runs; a lost lock stops the run before its next step. No model is
 * called; the only paid calls are the Titan embeds of the two embed steps,
 * under the brain's daily cap. The finish time is kept in `config` under
 * `housekeeping.last_run` for the doctor.
 */
import type { Storage } from "./storage.ts";
import type { Engine } from "./engine/interface.ts";
import { CYCLE_LOCK_ID, tryAcquireDbLock } from "./db-lock.ts";
import { purgeExpiredDocuments } from "./destructive-guard.ts";
import { purgeDeletedPages } from "./pages-purge.ts";
import { reconcilePageMirrors } from "./page-index.ts";
import { runEmbedBackfill, type EmbedBackfillOptions } from "./embed-backfill.ts";
import { expireStaleReservations } from "./budget.ts";
import { purgeRequestLog } from "./request-log-retention.ts";
import { purgeExpiredWriteRequests } from "./write-requests.ts";

export const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
/** Delay before the first run, so a restart loop does not run it every boot. */
export const HOUSEKEEPING_FIRST_RUN_MS = 5 * 60 * 1000;
export const HOUSEKEEPING_LAST_RUN_KEY = "housekeeping.last_run";
const LOCK_TTL_MINUTES = 30;
const DEFAULT_EMBED_GAPS_MAX_PER_RUN = 200;
/** A chunk whose embed failed this often for a lasting reason is left to `memrain embed`. */
const EMBED_GAPS_MAX_FAILURES = 3;
const DEFAULT_MIRROR_PAGES_MAX_PER_RUN = 200;
const CHAT_DEFAULT_RETENTION_DAYS = 90;
const CHAT_PURGE_BATCH = 5_000;

export interface HousekeepingOptions {
  /** Sweeps expired OAuth rows; absent when the server runs without its provider. */
  sweepTokens?: () => Promise<number>;
  /** Test seam; production embeds with Titan. */
  embed?: EmbedBackfillOptions["embed"];
  now?: Date;
}

export interface HousekeepingResult {
  ran: boolean;
  /** Why it did not run: another holder has the lock. */
  reason?: "locked";
  steps: Record<string, unknown>;
  /** `step: message` per step that threw. */
  errors: string[];
  /** The lock was lost mid-run; the steps after it did not run. */
  stopped?: true;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** MEMRAIN_CHAT_RETENTION_DAYS: days of chat history kept; 0 keeps all. */
export function chatRetentionDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.MEMRAIN_CHAT_RETENTION_DAYS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return CHAT_DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  return days === 0 ? null : Math.min(days, 36_500);
}

/** Delete chat messages older than the retention window, then the threads left empty. */
async function purgeOldChat(engine: Engine, days: number | null, now: Date): Promise<{ messages: number; threads: number }> {
  if (days === null) return { messages: 0, threads: 0 };
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  let messages = 0;
  for (;;) {
    // scope: operator-only retention runs over every owner's history, by age alone
    const r = await engine.query<{ n: string }>(
      `WITH doomed AS (
         SELECT id FROM chat_messages WHERE created_at < $1::timestamptz ORDER BY created_at LIMIT $2
       ), gone AS (
         DELETE FROM chat_messages m USING doomed d WHERE m.id = d.id RETURNING 1
       )
       SELECT count(*)::text AS n FROM gone`,
      [cutoff, CHAT_PURGE_BATCH],
    );
    const n = Number(r.rows[0]?.n ?? 0);
    messages += n;
    if (n < CHAT_PURGE_BATCH) break;
  }
  // scope: operator-only retention runs over every owner's history, by age alone
  const t = await engine.query<{ id: string }>(
    `DELETE FROM chat_threads t
      WHERE t.updated_at < $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.thread_id = t.id)
      RETURNING t.id::text AS id`,
    [cutoff],
  );
  return { messages, threads: t.rows.length };
}

async function embedGaps(engine: Engine, opts: HousekeepingOptions): Promise<{ scanned: number; embedded: number; failed: number }> {
  if (process.env.MEMRAIN_EMBED_GAPS === "0") return { scanned: 0, embedded: 0, failed: 0 };
  const max = positiveInt(process.env.MEMRAIN_EMBED_GAPS_MAX_PER_RUN, DEFAULT_EMBED_GAPS_MAX_PER_RUN);
  const result = { scanned: 0, embedded: 0, failed: 0 };
  let cursor: string | undefined;
  while (result.scanned < max) {
    const r = await runEmbedBackfill(engine, {
      limit: Math.min(50, max - result.scanned),
      concurrency: 2,
      // Filling gaps only: a model swap's re-embed stays a deliberate operator run.
      reembedOnSignatureChange: false,
      maxFailures: EMBED_GAPS_MAX_FAILURES,
      ...(cursor !== undefined ? { startAfterId: cursor } : {}),
      ...(opts.embed ? { embed: opts.embed } : {}),
    });
    result.scanned += r.candidates;
    result.embedded += r.embedded;
    result.failed += r.failed;
    if (r.lastId === null || r.candidates === 0) break;
    // Every call in the step failed: Bedrock is not answering, the rest waits.
    if (r.embedded === 0 && r.failed > 0) break;
    cursor = r.lastId;
  }
  return result;
}

/** Run every step once under the lock. Never throws for a step's failure. */
export async function runHousekeeping(storage: Storage, opts: HousekeepingOptions = {}): Promise<HousekeepingResult> {
  const engine = storage.engine();
  const lock = await tryAcquireDbLock(engine, CYCLE_LOCK_ID, LOCK_TTL_MINUTES);
  if (!lock) return { ran: false, reason: "locked", steps: {}, errors: [] };
  const now = opts.now ?? new Date();
  const result: HousekeepingResult = { ran: true, steps: {}, errors: [] };
  const steps: [string, () => Promise<unknown>][] = [
    ["purge", async () => {
      const docs = await purgeExpiredDocuments(engine);
      const pages = await purgeDeletedPages(engine);
      return { documents_deleted: docs.purged_deleted, documents_archived: docs.purged_archived, pages: pages.count, pages_blocked: pages.blocked.length };
    }],
    ["mirror_pages", async () => {
      const r = await reconcilePageMirrors(storage, {
        maxPerRun: positiveInt(process.env.MEMRAIN_MIRROR_PAGES_MAX_PER_RUN, DEFAULT_MIRROR_PAGES_MAX_PER_RUN),
      });
      return { scanned: r.scanned, mirrored: r.mirrored, removed: r.removed, errors: r.errors.length };
    }],
    ["embed_gaps", () => embedGaps(engine, opts)],
    ["tokens", async () => ({ swept: opts.sweepTokens ? await opts.sweepTokens() : 0 })],
    ["reservations", async () => ({ expired: await expireStaleReservations(engine, now) })],
    ["retention", async () => {
      const log = await purgeRequestLog(engine, { now });
      const writeRequests = await purgeExpiredWriteRequests(engine);
      const chat = await purgeOldChat(engine, chatRetentionDays(), now);
      return { request_log: log.deleted, request_log_capped: log.capped, write_requests: writeRequests, chat_messages: chat.messages, chat_threads: chat.threads };
    }],
  ];
  try {
    for (const [name, run] of steps) {
      if (!(await lock.refresh())) {
        result.stopped = true;
        break;
      }
      try {
        result.steps[name] = await run();
      } catch (e) {
        result.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!result.stopped) {
      await engine.query(
        `INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [HOUSEKEEPING_LAST_RUN_KEY, JSON.stringify({ finished_at: new Date().toISOString(), errors: result.errors.length })],
      );
    }
  } finally {
    await lock.release();
  }
  return result;
}

/** When housekeeping last finished, and how many steps failed then; null if never. */
export async function lastHousekeepingRun(engine: Pick<Engine, "query">): Promise<{ finishedAt: string; errors: number } | null> {
  const r = await engine.query<{ value: string }>(`SELECT value FROM config WHERE key = $1`, [HOUSEKEEPING_LAST_RUN_KEY]);
  const raw = r.rows[0]?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { finished_at?: unknown; errors?: unknown };
    return typeof v.finished_at === "string" ? { finishedAt: v.finished_at, errors: Number(v.errors ?? 0) } : null;
  } catch {
    return null;
  }
}

export interface HousekeepingHandle {
  stop: () => Promise<void>;
}

/** Run housekeeping every hour, the first run a few minutes after boot; runs never overlap. */
export function startHousekeeping(
  storage: Storage,
  opts: HousekeepingOptions & { intervalMs?: number; firstRunMs?: number } = {},
): HousekeepingHandle {
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = runHousekeeping(storage, opts)
      .then((r) => {
        if (!r.ran) return;
        const failed = r.errors.length > 0 ? ` errors=${r.errors.length}: ${r.errors.join("; ")}` : "";
        console.error(`[memrain] housekeeping ${JSON.stringify(r.steps)}${r.stopped ? " stopped: lock lost" : ""}${failed}`);
      })
      .catch((e: unknown) => {
        console.error("[memrain] housekeeping failed:", e instanceof Error ? e.message : e);
      })
      .finally(() => {
        running = null;
      });
  };
  const first = setTimeout(tick, opts.firstRunMs ?? HOUSEKEEPING_FIRST_RUN_MS);
  const every = setInterval(tick, opts.intervalMs ?? HOUSEKEEPING_INTERVAL_MS);
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(every);
      if (running) await running;
    },
  };
}
