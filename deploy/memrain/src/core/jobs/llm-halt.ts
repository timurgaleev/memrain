/**
 * Outage cooldowns for queued jobs.
 *
 * When Bedrock is down for everyone — expired credentials, a model the account
 * may not use, a spent quota, sustained throttling — every queued LLM job fails
 * the same way. Retrying on the job backoff (seconds) would spend each job's
 * whole retry budget inside one outage and dead-letter work that only needed
 * to wait. The worker instead defers such a job to the end of a cooldown kept
 * here, without spending a retry.
 *
 * A cooldown is keyed "*" for credentials (nothing works) and by model id
 * otherwise. Failures during a cooldown all wait for its end; the first failure
 * after it ends doubles the next one, up to 30 minutes. A key that stays quiet
 * for a full maximum cooldown starts over.
 *
 * In-process state: one worker, one view. MEMRAIN_JOB_LLM_HALT=0 turns the
 * whole mechanism off, and queued jobs fail and retry as before.
 */
import { BedrockHalted, classifyBedrockError } from "../llm/bedrock-errors.ts";

export type HaltClass = "credential" | "access" | "quota" | "throttle" | "model_not_found";

const HALT_CLASSES: ReadonlySet<string> = new Set<HaltClass>([
  "credential",
  "access",
  "quota",
  "throttle",
  "model_not_found",
]);

/** First cooldown per class; doubles per repeat. Throttles clear on their own. */
const BASE_MS: Record<HaltClass, number> = {
  credential: 5 * 60_000,
  access: 5 * 60_000,
  quota: 5 * 60_000,
  throttle: 60_000,
  model_not_found: 5 * 60_000,
};
export const LLM_HALT_MAX_MS = 30 * 60_000;

interface HaltState {
  until: number;
  strikes: number;
}

const _halts = new Map<string, HaltState>();

export function _resetLlmHaltForTests(): void {
  _halts.clear();
}

/** False when MEMRAIN_JOB_LLM_HALT is 0 / false / off. */
export function llmHaltEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MEMRAIN_JOB_LLM_HALT ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * A model id the account cannot reach. Matched here by error name and message
 * until the shared Bedrock classifier names the class itself.
 */
function isModelNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; message?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  const msg = typeof e.message === "string" ? e.message.slice(0, 500) : "";
  if (name === "ResourceNotFoundException") return true;
  return (
    (name === "ValidationException" || name === "" || name === "Error") &&
    /model identifier is invalid|model .{0,80}not found/i.test(msg)
  );
}

/**
 * The outage a job failure stands for, or null when it is the job's own
 * failure. A circuit the job's own scope tripped (its run was stopped) is the
 * job's own, so a `BedrockHalted` counts only when its cause is an outage.
 */
export function haltOf(err: unknown): { cls: HaltClass; key: string } | null {
  let cls: string;
  let model: string | null = null;
  if (err instanceof BedrockHalted) {
    cls = err.kind;
    model = /failure on (?!every model)(\S+):/.exec(err.message)?.[1] ?? null;
  } else {
    // A string, so a class the shared classifier adds later is read as-is.
    cls = classifyBedrockError(err);
    if (cls === "other" && isModelNotFound(err)) cls = "model_not_found";
  }
  if (!HALT_CLASSES.has(cls)) return null;
  return { cls: cls as HaltClass, key: cls === "credential" ? "*" : (model ?? "*") };
}

/**
 * Note an outage failure and return when jobs hitting it may try again (epoch
 * ms). Inside an active cooldown this is that cooldown's end; once it has
 * ended, the next cooldown is twice as long.
 */
export function noteHalt(key: string, cls: HaltClass, now: number = Date.now()): number {
  const prev = _halts.get(key);
  if (prev && now < prev.until) return prev.until;
  const strikes = prev && now - prev.until < LLM_HALT_MAX_MS ? prev.strikes : 0;
  const until = now + Math.min(BASE_MS[cls] * 2 ** strikes, LLM_HALT_MAX_MS);
  _halts.set(key, { until, strikes: strikes + 1 });
  return until;
}

/** Milliseconds left on `key`'s cooldown; 0 when none is active. */
export function llmHaltRemainingMs(key: string, now: number = Date.now()): number {
  const s = _halts.get(key);
  return s ? Math.max(0, s.until - now) : 0;
}
