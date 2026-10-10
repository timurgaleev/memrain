/**
 * Group job errors into a few stable buckets, so "40 jobs failed" reads as
 * "38 credential, 2 timeout" and points at the fix. Reads the `last_error`
 * text the worker writes; anything it cannot place is `unknown`, which is the
 * signal that a new failure shape needs a bucket.
 */

export type JobErrorBucket =
  /** The handler said no retry can fix it (`unrecoverable: …`). */
  | "unrecoverable"
  /** No handler is registered for the kind in the worker process. */
  | "no_handler"
  /** The job's wall-clock cap, or an LLM call's own deadline, ran out. */
  | "timeout"
  /** The worker running it went away more often than the stall budget allows. */
  | "stall"
  /** Waiting out an LLM outage (`deferred: …`). */
  | "deferred"
  /** Handed back by a worker that was shutting down. */
  | "worker_shutdown"
  | "credential"
  | "access"
  | "quota"
  | "throttle"
  | "model_not_found"
  /** A spend cap refused the call. */
  | "budget"
  /** The input was larger than the model accepts. */
  | "input_too_long"
  | "unknown";

const RULES: ReadonlyArray<[JobErrorBucket, RegExp]> = [
  ["unrecoverable", /^unrecoverable: /],
  ["deferred", /^deferred: /],
  ["no_handler", /^no handler registered for kind/],
  ["stall", /^stall budget exhausted|requeued after stall/],
  ["worker_shutdown", /^worker_shutdown$/],
  ["budget", /daily_cap|BudgetExhausted|budget_exhausted|spend cap|budget exhausted/i],
  ["credential", /expired ?token|security token .{0,40}(?:invalid|expired)|UnrecognizedClient/i],
  ["model_not_found", /model identifier is invalid|ResourceNotFound|model .{0,80}not found/i],
  ["access", /AccessDenied|not authorized to perform/i],
  ["quota", /ServiceQuotaExceeded|quota/i],
  ["throttle", /Throttling|too many requests|rate exceeded|\b429\b/i],
  ["input_too_long", /too long|too large|exceeds? .{0,40}(?:length|limit|tokens)/i],
  ["timeout", /timed? ?out|deadline/i],
];

/** The bucket for one `last_error`; null or empty is `unknown`. */
export function classifyJobError(lastError: string | null | undefined): JobErrorBucket {
  if (!lastError) return "unknown";
  // Bounded: error text can carry an echoed prompt.
  const text = lastError.slice(0, 500);
  for (const [bucket, re] of RULES) {
    if (re.test(text)) return bucket;
  }
  return "unknown";
}

/** Count errors per bucket, largest first, then by name. */
export function bucketJobErrors(
  errors: ReadonlyArray<string | null | undefined>,
): { bucket: JobErrorBucket; count: number }[] {
  const counts = new Map<JobErrorBucket, number>();
  for (const e of errors) {
    const b = classifyJobError(e);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket));
}
