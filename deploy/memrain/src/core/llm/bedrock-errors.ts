/**
 * What a failed Bedrock call means for the calls after it.
 *
 * A batch run (a cycle phase, a queued job, a backfill) makes the same kind of
 * call hundreds of times. When the credentials have expired, the model is not
 * enabled for the account, or the quota is spent, every one of those calls
 * fails the same way — each after its own retries and timeout. The classifier
 * names those failures; the circuit below remembers them, so the rest of the
 * run stops at the first one instead of paying for the same answer per item.
 *
 * Interactive calls never read the circuit: a person asking a question gets
 * the real error from a real attempt.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type BedrockErrorClass =
  /** The account's credentials are gone: nothing on any model will work. */
  | "credential"
  /** This model is not permitted for this account/role. */
  | "access"
  /** A service quota is exhausted for this model. */
  | "quota"
  /** Rate-limited: the SDK already retries these with backoff. */
  | "throttle"
  /** The input is larger than the model accepts; retrying cannot help. */
  | "input_too_long"
  /** The model id does not resolve for this account/region (a typo, a retired
   *  id): every call on it fails the same way until the config changes. */
  | "model_not_found"
  /** The call ran out of time (client deadline, a 408/504, a model timeout). */
  | "timeout"
  /** The service failed on its side (5xx) or the connection to it dropped. */
  | "server"
  | "other";

// Only failures that stay failed. A credentials-provider error (an instance
// metadata hiccup) or a bad signature (clock skew) often clears on its own and
// must not pause every model.
const CREDENTIAL = new Set(["ExpiredTokenException", "ExpiredToken", "UnrecognizedClientException"]);

const TIMEOUT_NAMES = new Set(["TimeoutError", "RequestTimeout", "RequestTimeoutException", "ModelTimeoutException"]);
const SERVER_NAMES = new Set(["InternalServerException", "ServiceUnavailableException", "ModelErrorException"]);
// Node socket failures carry their cause in `code`, on an error named "Error".
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT"]);
const SERVER_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENOTFOUND"]);
// Bedrock answers an unknown model id with a ValidationException, a known but
// unavailable one with ResourceNotFoundException.
const MODEL_NOT_FOUND_MSG = /model identifier is invalid|could not resolve the foundation model|model .{0,80}(?:not found|does not exist)/i;

/**
 * Classify by the SDK's error name and HTTP status. A plain `Error` (a stub, a
 * wrapper that kept only the message) falls back to its message, with status
 * codes matched only as whole numbers next to a status word — an account id or
 * ARN in an AccessDenied message must not read as a 5xx.
 */
export function classifyBedrockError(err: unknown): BedrockErrorClass {
  if (typeof err !== "object" || err === null) return "other";
  const e = err as { name?: unknown; message?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = typeof e.name === "string" ? e.name : "";
  const code = typeof e.code === "string" ? e.code : "";
  // Bounded: the patterns below scan with `.*`, and an error message can carry
  // an echoed prompt.
  const msg = typeof e.message === "string" ? e.message.slice(0, 500) : "";
  const status = e.$metadata?.httpStatusCode;

  if (CREDENTIAL.has(name)) return "credential";
  if (name === "AccessDeniedException") return "access";
  if (name === "ServiceQuotaExceededException") return "quota";
  if (name === "ThrottlingException" || name === "TooManyRequestsException" || status === 429) return "throttle";
  if (name === "ValidationException" && /too long|too large|exceeds? .*(?:length|limit|tokens)|max(?:imum)? .*tokens/i.test(msg)) {
    return "input_too_long";
  }
  if (name === "ResourceNotFoundException" || (name === "ValidationException" && MODEL_NOT_FOUND_MSG.test(msg))) {
    return "model_not_found";
  }
  if (TIMEOUT_NAMES.has(name) || TIMEOUT_CODES.has(code) || status === 408 || status === 504) return "timeout";
  if (SERVER_NAMES.has(name) || SERVER_CODES.has(code) || (typeof status === "number" && status >= 500 && status < 600)) {
    return "server";
  }
  if (name && name !== "Error") return "other";

  if (/expired ?token|security token .*(?:invalid|expired)/i.test(msg)) return "credential";
  if (/AccessDenied|not authorized to perform/i.test(msg)) return "access";
  if (/ServiceQuotaExceeded/i.test(msg)) return "quota";
  if (/Throttling|too many requests|rate exceeded|\b(?:HTTP|status)\s*429\b/i.test(msg)) return "throttle";
  if (/ResourceNotFound/i.test(msg) || MODEL_NOT_FOUND_MSG.test(msg)) return "model_not_found";
  if (/\btimed out\b|\b(?:HTTP|status)\s*(?:408|504)\b/i.test(msg)) return "timeout";
  if (/\b(?:HTTP|status)\s*5\d\d\b|ECONNRESET|socket hang up/i.test(msg)) return "server";
  return "other";
}

/**
 * A failure that says nothing about the input and is likely gone on a later
 * try: a pause the circuit imposed, a throttle, a timeout, a server-side error,
 * a spent quota. Work that can be finished later (an embedding) may defer on
 * these; credentials, access, an unknown model and an oversize input repeat
 * until someone changes something, so they still fail the call.
 */
export function isTransientBedrockError(err: unknown): boolean {
  if (err instanceof BedrockHalted) return true;
  const cls = classifyBedrockError(err);
  return cls === "throttle" || cls === "timeout" || cls === "server" || cls === "quota";
}

/** Raised instead of sending when the circuit is open for this call. */
export class BedrockHalted extends Error {
  constructor(
    readonly kind: BedrockErrorClass,
    readonly until: number,
    detail: string,
  ) {
    super(`BedrockHalted: ${detail}`);
    this.name = "BedrockHalted";
  }
}

const COOLDOWN_MS = 5 * 60 * 1000;

/** Open circuits: the key is "*" for credentials, else the model id. */
const _open = new Map<string, { until: number; cause: BedrockErrorClass; message: string }>();

/** The batch run a call belongs to, if any. */
const _batch = new AsyncLocalStorage<BatchScope>();

export function resetBedrockCircuitForTests(): void {
  _open.clear();
}

/**
 * Record a failed batch call; opens the circuit when the failure will repeat.
 * Only batch work opens it, and an open circuit is not pushed further out, so
 * interactive traffic hitting a partial failure cannot hold batch work off.
 */
export function noteBedrockFailure(model: string, err: unknown, now = Date.now()): void {
  if (!_batch.getStore()?.circuit) return;
  const cls = classifyBedrockError(err);
  if (cls !== "credential" && cls !== "access" && cls !== "quota" && cls !== "model_not_found") return;
  const key = cls === "credential" ? "*" : model;
  const open = _open.get(key);
  if (open && open.until > now) return;
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[memrain] bedrock: ${cls} failure on ${key === "*" ? "every model" : model} — ` +
      `batch work pauses these calls for ${COOLDOWN_MS / 60_000} min: ${message.slice(0, 200)}`,
  );
  _open.set(key, { until: now + COOLDOWN_MS, cause: cls, message });
}

/** A call went through: whatever paused this model (or every model) is over. */
export function noteBedrockSuccess(model: string): void {
  if (_open.size === 0) return;
  _open.delete(model);
  _open.delete("*");
}

/**
 * A batch run in progress. `stopped` is set when its phase or job timed out:
 * the orphaned work it left running must not keep paying. `circuit` is whether
 * the run stops at a repeating failure — off for queued jobs, whose retry
 * schedule (seconds) would burn through every attempt inside one pause and
 * dead-letter the job.
 */
export interface BatchScope {
  stopped: boolean;
  circuit: boolean;
  /** Why the run stopped when it was not a timeout (an abort such as
   *  `lock_stolen`), so a halted call names the real cause. */
  stopReason?: string;
}

/** Run `fn` as batch work. Inside an existing scope the outer one stays in
 *  charge, so a timed-out phase still stops the backfill it started. */
export function runInBatchScope<T>(scope: BatchScope, fn: () => Promise<T>): Promise<T> {
  return _batch.getStore() ? fn() : _batch.run(scope, fn);
}

/** Throw instead of sending when a batch call would only repeat a known failure. */
export function assertBedrockOpen(model: string, now = Date.now()): void {
  const scope = _batch.getStore();
  if (!scope) return;
  if (scope.stopped) {
    throw new BedrockHalted(
      "other",
      now,
      scope.stopReason
        ? `the batch run this call belongs to was stopped: ${scope.stopReason}`
        : "the batch run this call belongs to has already timed out",
    );
  }
  if (!scope.circuit) return;
  for (const key of ["*", model]) {
    const open = _open.get(key);
    if (open && open.until > now) {
      throw new BedrockHalted(open.cause, open.until, `${open.cause} failure on ${key === "*" ? "every model" : model}: ${open.message.slice(0, 200)}`);
    }
  }
}
