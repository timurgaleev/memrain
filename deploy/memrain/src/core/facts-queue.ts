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
 * Shutdown stops admission and audits pending/in-flight jobs before storage
 * closes. The existing backfill phase recovers interrupted work under its
 * normal page and dollar caps; enabled extraction schedules it once per day.
 */
import { currentSpendContext, runWithSpendClient } from "./budget.ts";


export interface FactsQueueCounters {
  enqueued: number;
  completed: number;
  dropped_overflow: number;
  dropped_shutdown: number;
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
export type FactsJobDropHook = (reason: "queue_overflow" | "queue_shutdown", sessionId: string) => Promise<void> | void;

interface QueueEntry {
  job: FactsJob;
  sessionId: string;
  onError?: FactsJobErrorHook;
  onDrop?: FactsJobDropHook;
}

export class FactsQueue {
  private readonly cap: number;
  private readonly perSessionInflightCap: number;
  private pending: QueueEntry[] = [];
  private closed = false;
  private readonly active = new Set<QueueEntry>();
  private readonly notified = new WeakSet<QueueEntry>();
  private readonly notices = new Set<Promise<void>>();
  private readonly inflightBySession = new Map<string, number>();
  private counters: FactsQueueCounters = {
    enqueued: 0,
    completed: 0,
    dropped_overflow: 0,
    dropped_shutdown: 0,
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
  enqueue(job: FactsJob, sessionId: string, onError?: FactsJobErrorHook, onDrop?: FactsJobDropHook): number {
    this.counters.enqueued += 1;
    if (this.closed) {
      this.notifyDrop({ job, sessionId, onDrop }, "queue_shutdown");
      return 0;
    }
    if (this.pending.length >= this.cap) {
      this.notifyDrop(this.pending.shift()!, "queue_overflow");
      this.counters.dropped_overflow += 1;
    }
    // Bind the ENQUEUEING client to the job. A queued job is pumped from
    // another job's `finally`, so without this it would inherit whatever
    // client happened to be in scope on that continuation — and one tenant's
    // extraction would be billed to the tenant whose job ran just before it.
    const client = currentSpendContext();
    const bound: FactsJob = () => runWithSpendClient(client, job);
    this.pending.push({ job: bound, sessionId, ...(onError ? { onError } : {}), ...(onDrop ? { onDrop } : {}) });
    queueMicrotask(() => this.pump());
    return this.pending.length;
  }

  getCounters(): FactsQueueCounters {
    return { ...this.counters };
  }

  pendingCount(): number {
    return this.pending.length;
  }

  /** Does not wait for an uninterruptible model call; records what may be lost. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const pending = this.pending;
    this.pending = [];
    for (const entry of [...pending, ...this.active]) this.notifyDrop(entry, "queue_shutdown");
    await Promise.all([...this.notices]);
  }

  private notifyDrop(entry: QueueEntry, reason: "queue_overflow" | "queue_shutdown"): void {
    if (this.notified.has(entry)) return;
    this.notified.add(entry);
    if (reason === "queue_shutdown") this.counters.dropped_shutdown += 1;
    const notice = Promise.resolve().then(() => entry.onDrop?.(reason, entry.sessionId)).catch(() => {});
    this.notices.add(notice);
    void notice.finally(() => this.notices.delete(notice));
  }

  inflightCount(): number {
    let n = 0;
    for (const v of this.inflightBySession.values()) n += v;
    return n;
  }

  /** Pick up the first entry whose session has capacity; recurse for more. */
  private pump(): void {
    if (this.closed) return;
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
    this.active.add(entry);
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
      this.active.delete(entry);
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
