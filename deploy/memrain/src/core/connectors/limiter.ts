/**
 * Request pacing shared by every client of one provider account: a minimum gap
 * between requests and, for providers that meter by the day (Fireflies counts
 * requests per API key and resets at 00:00 UTC), a daily request quota.
 *
 * A client made per run would forget the quota between runs, so callers get
 * one limiter per account from `limiterFor`, which keeps it for the process.
 * The count is a courtesy, not the enforcement: after a restart it starts at
 * zero, and the provider's own refusal is still handled by the client as a
 * rate limit.
 */

export interface ProviderLimiterOptions {
  /** Minimum gap between two requests, in ms. */
  minSpacingMs: number;
  /** Requests allowed per UTC day; omit for no daily quota. */
  dailyQuota?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DAY_MS = 86_400_000;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ProviderLimiter {
  private readonly minSpacingMs: number;
  private readonly dailyQuota: number | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextAllowedAt = 0;
  private day = -1;
  private used = 0;

  constructor(opts: ProviderLimiterOptions) {
    if (!Number.isFinite(opts.minSpacingMs) || opts.minSpacingMs < 0) throw new Error("minSpacingMs must be >= 0");
    if (opts.dailyQuota !== undefined && (!Number.isInteger(opts.dailyQuota) || opts.dailyQuota < 1)) {
      throw new Error("dailyQuota must be a positive integer");
    }
    this.minSpacingMs = opts.minSpacingMs;
    this.dailyQuota = opts.dailyQuota ?? null;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
  }

  /**
   * Wait for this request's slot. Returns null when it may go, or why it may
   * not (the daily quota is spent), safe to print.
   */
  async acquire(): Promise<string | null> {
    if (this.dailyQuota !== null) {
      const day = Math.floor(this.now() / DAY_MS);
      if (day !== this.day) {
        this.day = day;
        this.used = 0;
      }
      if (this.used >= this.dailyQuota) {
        return `daily request quota of ${this.dailyQuota} reached; it resets at 00:00 UTC`;
      }
      this.used++;
    }
    // Reserve the slot before waiting, so two callers in flight queue behind
    // each other instead of both waiting the same gap.
    const at = Math.max(this.now(), this.nextAllowedAt);
    this.nextAllowedAt = at + this.minSpacingMs;
    const wait = at - this.now();
    if (wait > 0) await this.sleep(wait);
    return null;
  }
}

const LIMITERS = new Map<string, ProviderLimiter>();

/** The process-wide limiter for `key` (provider plus account), made on first use. */
export function limiterFor(key: string, opts: ProviderLimiterOptions): ProviderLimiter {
  let limiter = LIMITERS.get(key);
  if (limiter === undefined) {
    limiter = new ProviderLimiter(opts);
    LIMITERS.set(key, limiter);
  }
  return limiter;
}

/** Test-only: forget every limiter. */
export function _resetLimitersForTesting(): void {
  LIMITERS.clear();
}
