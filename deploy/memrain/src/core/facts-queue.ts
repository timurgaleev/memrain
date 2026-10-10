/**
 * Bounded in-memory queue for best-effort, on-write fact extraction.
 *
 * The page-write path enqueues a fire-and-forget extraction job instead of
 * blocking the write on a
 * paid Sonnet call. The queue's only responsibilities are order, concurrency,
 * and shedding load:
 *   - cap `cap` pending jobs; drop the OLDEST on overflow (a counter records it),
 *   - per-session in-flight = 1 (burst writes in one session serialize rather
 *     than fanning out N parallel paid calls),
 *   - absorb every job failure into a counter + a single warn line — a failed
 *     extraction must never surface to, or fail, the triggering write.
 *
 * Process-singleton (`getFactsQueue`); tests reset it with the test helper.
 * Deliberately simple: no shutdown/drain choreography — memrain is single-holder
 * and extraction is strictly best-effort. The queue lives in memory only, so
 * every job pending or in flight at exit — each restart and deploy — is lost,
 * and nothing re-runs it on its own. The `conversation-facts-backfill` cycle
 * phase re-covers such pages only when the operator runs it: it is not in the
 * default phase set and needs MEMRAIN_FACTS_BACKFILL=1.
 */
import { currentSpendContext, runWithSpendClient } from "./budget.ts";


export interface FactsQueueCounters {
  enqueued: number;
  completed: number;
  dropped_overflow: number;
  failed: number;
}

export interface FactsQueueOptions {
  /** Max pending jobs. Default 100. */
  cap?: number;
  /** Per-session in-flight cap. Default 1. */
  perSessionInflightCap?: number;
}

/** A job body — cooperatively runs to completion; the queue awaits it. */
export type FactsJob = () => Promise<void>;

/** Best-effort failure hook — e.g. the durable facts:absorb writer
 *  (core/ingest-log.ts). Its own failure is swallowed: observability must
 *  never cascade into the queue. */
export type FactsJobErrorHook = (err: unknown) => Promise<void> | void;

interface QueueEntry {
  job: FactsJob;
  sessionId: string;
  onError?: FactsJobErrorHook;
}

export class FactsQueue {
  private readonly cap: number;
  private readonly perSessionInflightCap: number;
  private pending: QueueEntry[] = [];
  private readonly inflightBySession = new Map<string, number>();
  private counters: FactsQueueCounters = {
    enqueued: 0,
    completed: 0,
    dropped_overflow: 0,
    failed: 0,
  };

  constructor(opts: FactsQueueOptions = {}) {
    this.cap = Math.max(1, opts.cap ?? 100);
    this.perSessionInflightCap = Math.max(1, opts.perSessionInflightCap ?? 1);
  }

  /**
   * Enqueue a job for a session. Returns the pending depth after insertion.
   * Drop-oldest-on-overflow (the dropped job never runs — enqueue is
   * fire-and-forget by contract). Non-blocking: the pump runs on a microtask.
   */
  enqueue(job: FactsJob, sessionId: string, onError?: FactsJobErrorHook): number {
    if (this.pending.length >= this.cap) {
      this.pending.shift();
      this.counters.dropped_overflow += 1;
    }
    // Bind the ENQUEUEING client to the job. A queued job is pumped from
    // another job's `finally`, so without this it would inherit whatever
    // client happened to be in scope on that continuation — and one tenant's
    // extraction would be billed to the tenant whose job ran just before it.
    const client = currentSpendContext();
    const bound: FactsJob = () => runWithSpendClient(client, job);
    this.pending.push({ job: bound, sessionId, ...(onError ? { onError } : {}) });
    this.counters.enqueued += 1;
    queueMicrotask(() => this.pump());
    return this.pending.length;
  }

  getCounters(): FactsQueueCounters {
    return { ...this.counters };
  }

  pendingCount(): number {
    return this.pending.length;
  }

  inflightCount(): number {
    let n = 0;
    for (const v of this.inflightBySession.values()) n += v;
    return n;
  }

  /** Pick up the first entry whose session has capacity; recurse for more. */
  private pump(): void {
    for (let i = 0; i < this.pending.length; i++) {
      const entry = this.pending[i]!;
      const inflight = this.inflightBySession.get(entry.sessionId) ?? 0;
      if (inflight < this.perSessionInflightCap) {
        this.pending.splice(i, 1);
        this.inflightBySession.set(entry.sessionId, inflight + 1);
        void this.runEntry(entry);
        this.pump();
        return;
      }
    }
  }

  private async runEntry(entry: QueueEntry): Promise<void> {
    try {
      await entry.job();
      this.counters.completed += 1;
    } catch (err) {
      this.counters.failed += 1;
      console.warn(
        `[facts-queue] extraction job failed for session=${entry.sessionId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      if (entry.onError) {
        try {
          await entry.onError(err);
        } catch {
          // The hook is observability-only; its failure never cascades.
        }
      }
    } finally {
      const remaining = (this.inflightBySession.get(entry.sessionId) ?? 1) - 1;
      if (remaining <= 0) this.inflightBySession.delete(entry.sessionId);
      else this.inflightBySession.set(entry.sessionId, remaining);
      queueMicrotask(() => this.pump());
    }
  }
}

let _singleton: FactsQueue | null = null;

export function getFactsQueue(opts?: FactsQueueOptions): FactsQueue {
  if (!_singleton) _singleton = new FactsQueue(opts);
  return _singleton;
}

/** Test helper: reset the process-level singleton. */
export function __resetFactsQueueForTests(): void {
  _singleton = null;
}
