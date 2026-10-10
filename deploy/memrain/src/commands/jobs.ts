/**
 * `memrain jobs <subcommand>` — inspect / retry / cancel / manage queued jobs.
 *
 * Subcommands:
 *   list       — print rows (filterable by --status / --kind, capped by --limit)
 *   stats [--by-kind]
 *              — print counts grouped by status; --by-kind adds per-kind
 *                counts with deferred and wedged rows
 *   retry <id> — flip failed/cancelled → pending, ready for the next claim
 *   cancel <id>— flip pending/running → cancelled
 *   show <id>  — full row for a single job
 *   submit <kind> [--id X] [--priority N] [--max-retries N] [--payload '<json>']
 *              — validated enqueue (core/jobs/lifecycle.ts submitJob)
 *   progress <id> — status + handler-reported progress envelope
 *   remove <id>   — delete one TERMINAL row (cancel first if still live)
 *   prune [--older-than-days N] [--status s1,s2] [--dry-run]
 *                 — delete old terminal rows (default: all terminal, 30d);
 *                   --dry-run previews the count without deleting
 *   smoke         — end-to-end queue self-test (enqueue → claim → complete)
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { Queue } from "../core/jobs/queue.ts";
import {
  submitJob,
  getJobProgress,
  runJobsSmoke,
} from "../core/jobs/lifecycle.ts";
import type { JobStatus } from "../core/jobs/types.ts";

export type JobsSubcommand =
  | "list"
  | "stats"
  | "retry"
  | "cancel"
  | "show"
  | "submit"
  | "progress"
  | "remove"
  | "prune"
  | "smoke";

export interface JobsCmdOptions {
  sub: JobsSubcommand;
  status?: JobStatus | JobStatus[];
  kind?: string;
  limit?: number;
  id?: string;
  /** submit: payload JSON object / priority / max retries. */
  payload?: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
  /** prune: age floor in days (default 30). */
  olderThanDays?: number;
  /** prune: preview the would-be-deleted count without deleting. */
  dryRun?: boolean;
  /** stats: add per-kind counts. */
  byKind?: boolean;
  /** Test seam — config file path. */
  configPath?: string;
}

export async function runJobs(opts: JobsCmdOptions): Promise<void> {
  const config = loadConfig(opts.configPath);
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const queue = new Queue(storage.engine());
    switch (opts.sub) {
      case "submit": {
        if (!opts.kind) throw new Error("memrain jobs submit: <kind> is required");
        const job = await submitJob(queue, {
          kind: opts.kind,
          ...(opts.id ? { id: opts.id } : {}),
          ...(opts.payload ? { payload: opts.payload } : {}),
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
          ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        });
        console.log(JSON.stringify({ ok: true, job }, null, 2));
        return;
      }
      case "progress": {
        if (!opts.id) throw new Error("memrain jobs progress: <id> is required");
        const progress = await getJobProgress(queue, opts.id);
        if (!progress) {
          console.log(JSON.stringify({ ok: false, error: "not-found", id: opts.id }, null, 2));
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, ...progress }, null, 2));
        return;
      }
      case "remove": {
        if (!opts.id) throw new Error("memrain jobs remove: <id> is required");
        const removed = await queue.remove(opts.id);
        if (!removed) {
          console.log(
            JSON.stringify(
              {
                ok: false,
                error: "not-removable",
                id: opts.id,
                note: "only terminal jobs (succeeded/failed/cancelled) can be removed — cancel it first",
              },
              null,
              2,
            ),
          );
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, removed: opts.id }, null, 2));
        return;
      }
      case "prune": {
        const pruneOpts: Parameters<typeof queue.prune>[0] = {};
        if (opts.olderThanDays !== undefined) {
          pruneOpts.olderThan = new Date(Date.now() - opts.olderThanDays * 86_400_000);
        }
        if (opts.status) {
          pruneOpts.statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
        }
        if (opts.dryRun) {
          const wouldPrune = await queue.prune({ ...pruneOpts, dryRun: true });
          console.log(
            JSON.stringify({ ok: true, would_prune: wouldPrune, dry_run: true }, null, 2),
          );
          return;
        }
        const pruned = await queue.prune(pruneOpts);
        console.log(JSON.stringify({ ok: true, pruned }, null, 2));
        return;
      }
      case "smoke": {
        const result = await runJobsSmoke(storage.engine());
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
        return;
      }
      case "list": {
        const listOpts: Parameters<typeof queue.list>[0] = {};
        if (opts.status) listOpts.status = opts.status;
        if (opts.kind) listOpts.kind = opts.kind;
        if (opts.limit !== undefined) listOpts.limit = opts.limit;
        const rows = await queue.list(listOpts);
        console.log(JSON.stringify({ ok: true, count: rows.length, rows }, null, 2));
        return;
      }
      case "stats": {
        const stats = await queue.stats();
        if (opts.byKind) {
          const byKind = await queue.statsByKind();
          console.log(JSON.stringify({ ok: true, stats, by_kind: byKind }, null, 2));
          return;
        }
        console.log(JSON.stringify({ ok: true, stats }, null, 2));
        return;
      }
      case "show": {
        if (!opts.id) throw new Error("memrain jobs show: <id> is required");
        const row = await queue.get(opts.id);
        if (!row) {
          console.log(JSON.stringify({ ok: false, error: "not-found", id: opts.id }, null, 2));
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, job: row }, null, 2));
        return;
      }
      case "retry": {
        if (!opts.id) throw new Error("memrain jobs retry: <id> is required");
        const row = await queue.retry(opts.id);
        if (!row) {
          console.log(
            JSON.stringify(
              { ok: false, error: "not-retryable", id: opts.id },
              null,
              2,
            ),
          );
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, job: row }, null, 2));
        return;
      }
      case "cancel": {
        if (!opts.id) throw new Error("memrain jobs cancel: <id> is required");
        const row = await queue.cancel(opts.id);
        if (!row) {
          console.log(
            JSON.stringify(
              { ok: false, error: "not-cancellable", id: opts.id },
              null,
              2,
            ),
          );
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, job: row }, null, 2));
        return;
      }
      default: {
        const _exhaustive: never = opts.sub;
        throw new Error(`memrain jobs: unknown subcommand '${_exhaustive}'`);
      }
    }
  });
}
