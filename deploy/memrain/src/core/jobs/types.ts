/**
 * Job queue types — the shape of rows + handler signatures.
 */

export type JobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface JobRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  retryCount: number;
  maxRetries: number;
  nextAttemptAt: Date;
  quietHoursSkip: boolean;
  lastError: string | null;
  result: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Wall-clock until which this row's `running` claim is valid. */
  lockUntil: Date | null;
  /** Number of times handleStalled has requeued this row. */
  stallCount: number;
  /** Cap on stalls before terminal-fail. */
  maxStalled: number;
  /**
   * Hard per-job wall-clock cap (ms) the worker races the handler against; on
   * exceed the job is dead-lettered (terminal fail). NULL = use the worker's
   * process-wide default (off unless configured).
   */
  timeoutMs: number | null;
  /** Structured handler-reported progress (migration 083). NULL until set. */
  progress: Record<string, unknown> | null;
  /** Accumulated LLM input tokens for this job (migration 083). */
  tokensInput: number;
  /** Accumulated LLM output tokens for this job (migration 083). */
  tokensOutput: number;
  /** Accumulated prompt-cache-read tokens for this job (migration 083). */
  tokensCacheRead: number;
  /** Accumulated dollar estimate of paid calls made by this job (migration 083). */
  costUsd: number;
  /**
   * Bumped by every claim (migration 109). An attempt's writes match the
   * generation it claimed, so a stale attempt can't write onto a newer one.
   */
  claimGeneration: number;
  /** The OAuth client that submitted this job (migration 115); null for operator jobs. */
  submittedBy: string | null;
  /** Grant snapshot taken at submit, re-checked by the handler; null for operator jobs. */
  authority: Record<string, unknown> | null;
  /** Times this row was deferred without spending a retry (migration 128). */
  deferredCount: number;
}

/** Incremental token/cost usage a handler reports mid-run. All fields add. */
export interface JobUsageDelta {
  tokensInput?: number;
  tokensOutput?: number;
  tokensCacheRead?: number;
  costUsd?: number;
}

/**
 * Handler signature. Throw to fail; return any JSON-serialisable value
 * (or undefined) to succeed. The queue persists the return value as
 * `jobs.result`.
 *
 * `updateProgress` / `recordUsage` are provided by the Worker (optional so
 * tests can invoke handlers with a bare `{ job }` context): progress replaces
 * the row's `progress` JSONB, usage deltas accumulate onto the token/cost
 * columns. Both are no-ops once the attempt has lost its claim.
 *
 * `signal` aborts when the attempt is abandoned: its timeout fired, its claim
 * was lost (cancelled, or re-claimed after a stall), or the worker is shutting
 * down. Pass it to network calls so abandoned work stops paying.
 *
 * Throw `UnrecoverableJobError` for a failure no retry can fix (a malformed
 * payload, a missing runner): the job fails terminally instead of spending its
 * retries on the same answer.
 */
export type JobHandler = (
  payload: Record<string, unknown>,
  ctx: {
    job: JobRow;
    updateProgress?: (progress: Record<string, unknown>) => Promise<boolean>;
    recordUsage?: (usage: JobUsageDelta) => Promise<boolean>;
    signal?: AbortSignal;
  },
) => Promise<Record<string, unknown> | void>;

/** A job failure that retrying cannot fix; the worker dead-letters at once. */
export class UnrecoverableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecoverableJobError";
  }
}

export interface EnqueueInput {
  kind: string;
  payload?: Record<string, unknown>;
  /** Stable id — pass to enforce idempotency. Random UUID if omitted. */
  id?: string;
  /** 1 (highest) – 10 (lowest). Default 5. */
  priority?: number;
  maxRetries?: number;
  /** Defer first attempt until this time. Default NOW. */
  runAt?: Date;
  /** When true, the worker won't claim this job during quiet hours. */
  quietHoursSkip?: boolean;
  /**
   * Hard wall-clock cap (ms, > 0) for this job's handler. On exceed the worker
   * dead-letters it (terminal, no retry). Omit to use the worker default.
   */
  timeoutMs?: number;
  /** Submitting client, for a job run under a tenant's grant. Requires `authority`. */
  submittedBy?: string;
  /** Grant snapshot the handler re-checks against the live client. Requires `submittedBy`. */
  authority?: Record<string, unknown>;
}
