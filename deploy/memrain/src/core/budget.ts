/**
 * Money: what a paid Bedrock call costs, what it is allowed to cost, and where
 * the dollar went. Three layers, in that order:
 *
 *   - Pricing (`priceFor` / `costUsd`) — per-1M-token rates on Bedrock
 *     (eu-west-1 cross-region inference), matched by model-family substring so
 *     an exact version suffix doesn't have to be enumerated. Chat and
 *     embedding are separate tables: they bill on different axes.
 *   - Ceilings — the in-process `BudgetTracker` (one call site, one process)
 *     and the durable per-client reservation ledger below. A cap with NO
 *     pricing match HARD-FAILS: never spend against an unpriced model.
 *   - Attribution (`trackedInvoke`, bottom of file) — the chokepoint every
 *     paid call passes through, booking a labelled row per call (feature,
 *     spender, cycle phase, job, outcome, latency) and refusing a call that a
 *     client's, the brain's or the cycle's daily cap leaves no room for.
 */
import { randomUUID } from "node:crypto";
import { OperationError } from "./operation-error.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { noteWriteTiming } from "./write-timing.ts";
import { beginRequestCost } from "./request-cost.ts";
import { BedrockHalted, assertBedrockOpen, noteBedrockFailure, noteBedrockSuccess } from "./llm/bedrock-errors.ts";
import { keywordOnlyMode } from "./llm/gateway.ts";
import { appendAudit, auditDir } from "./audit-week-file.ts";
import { withProviderLease } from "./jobs/rate-leases.ts";
import type { Engine } from "./engine/interface.ts";
import type { SonnetUsage } from "./llm/sonnet.ts";

/**
 * Ledger key of the brain's own held calls (cycle, jobs, CLI) when a
 * brain-wide or cycle cap is on. Their ledger rows keep client_id NULL; only
 * the hold needs a key, since `mcp_spend_reservations.client_id` is NOT NULL.
 * No PAT may take this name (`patNameSpendConflict`).
 */
export const BRAIN_SPEND_ID = "memrain_brain";

/** The advisory lock every brain-wide and cycle cap check runs under. */
const BRAIN_SPEND_LOCK = "memrain_spend:brain";

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  inputPer1M: number;
  /** USD per 1,000,000 output tokens. */
  outputPer1M: number;
}

/** Bedrock per-1M CHAT pricing by model-family substring (lowercased match). */
export const MODEL_PRICING: { match: string; price: ModelPricing }[] = [
  // `opus` must precede `sonnet`/`haiku`: first substring match wins, and the
  // deep tier's opus id must not fall through to a cheaper row's pricing.
  { match: "opus", price: { inputPer1M: 15.0, outputPer1M: 75.0 } },
  // The 5-generation rows precede their family row for the same reason. Rates
  // are the Bedrock `eu.` regional-profile card (list price + 10%).
  { match: "sonnet-5", price: { inputPer1M: 2.2, outputPer1M: 11.0 } },
  { match: "sonnet", price: { inputPer1M: 3.0, outputPer1M: 15.0 } },
  { match: "haiku-5", price: { inputPer1M: 0.11, outputPer1M: 0.55 } },
  { match: "haiku", price: { inputPer1M: 1.0, outputPer1M: 5.0 } },
];

/**
 * Bedrock per-1M EMBEDDING pricing — a different axis from chat, so it is a
 * different table. An embedding call bills INPUT tokens only; there is no
 * output side at all, so `outputPer1M` is a truthful zero rather than a chat
 * rate borrowed to make the row typecheck. Consulted BEFORE the chat table so
 * a future embedder whose id happens to carry a chat family substring can
 * never be priced as a chat model.
 */
export const EMBEDDING_PRICING: { match: string; price: ModelPricing }[] = [
  // amazon.titan-embed-text-v2:0 — $0.02 per 1M input tokens.
  { match: "titan-embed", price: { inputPer1M: 0.02, outputPer1M: 0 } },
];

export function priceFor(modelId: string): ModelPricing | null {
  const id = modelId.toLowerCase();
  for (const { match, price } of EMBEDDING_PRICING) {
    if (id.includes(match)) return price;
  }
  for (const { match, price } of MODEL_PRICING) {
    if (id.includes(match)) return price;
  }
  return null;
}

/** Cost in USD for one call's token usage on a given model. */
export function costUsd(modelId: string, usage: SonnetUsage): number {
  const p = priceFor(modelId);
  if (!p) return 0;
  return (
    (usage.inputTokens / 1_000_000) * p.inputPer1M +
    (usage.outputTokens / 1_000_000) * p.outputPer1M
  );
}

/** Bedrock bills a prompt-cache READ at ~10% and a cache WRITE at ~125% of the
 *  normal input rate. */
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_RATE = 1.25;

/** Token usage as the Converse API reports it, prompt-cache fields included. */
export interface ReportedUsage extends SonnetUsage {
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

/**
 * Fold prompt-cache tokens into an equivalent plain-input count. The price
 * table knows ONE input rate per model, so cached tokens have to be translated
 * into the uncached tokens they cost the same as — otherwise a cache read is
 * either dropped (spend under-reported) or charged at 10× its real price.
 */
export function chargeableUsage(u: ReportedUsage): SonnetUsage {
  const cacheRead = u.cacheReadInputTokens ?? 0;
  const cacheWrite = u.cacheWriteInputTokens ?? 0;
  return {
    inputTokens: Math.ceil(
      u.inputTokens + cacheWrite * CACHE_WRITE_RATE + cacheRead * CACHE_READ_RATE,
    ),
    outputTokens: u.outputTokens,
  };
}

export type BudgetReason = "cost" | "no_pricing";

export class BudgetExhausted extends Error {
  constructor(
    public readonly reason: BudgetReason,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExhausted";
  }
}

export interface BudgetSnapshot {
  spentUsd: number;
  maxCostUsd: number;
  callsRecorded: number;
}

/** Budget set aside for one call in flight; settle or release it exactly once. */
export interface BudgetHold {
  usd: number;
  done: boolean;
}

export class BudgetTracker {
  private spent: number;
  private held = 0;
  private calls = 0;

  /**
   * `initialSpentUsd` seeds what has already been spent against this cap in an
   * earlier process — a resumed job starts from its persisted cost, not from
   * zero, so a crash cannot hand it a fresh budget.
   */
  constructor(
    private readonly maxCostUsd: number,
    private readonly label: string = "facts-extract",
    initialSpentUsd = 0,
  ) {
    this.spent = Number.isFinite(initialSpentUsd) && initialSpentUsd > 0 ? initialSpentUsd : 0;
  }

  /** Would recording this model's call (best-effort cost) exceed the cap? Used
   *  to skip a call BEFORE spending when the prior spend already left no room.
   *  An unpriced model is treated as "would exceed" — consistent with `record`,
   *  which hard-fails rather than spend against an unpriced model. */
  wouldExceed(modelId: string, estUsage: SonnetUsage): boolean {
    if (priceFor(modelId) === null) return true;
    return this.spent + this.held + costUsd(modelId, estUsage) > this.maxCostUsd;
  }

  /**
   * Set the estimate aside before the call, or return null when it would not
   * fit. Concurrent callers sharing one tracker each see the others' holds, so
   * a "would it fit?" check followed by an await no longer lets N of them pass
   * against the same headroom.
   */
  reserve(modelId: string, estUsage: SonnetUsage): BudgetHold | null {
    if (this.wouldExceed(modelId, estUsage)) return null;
    const usd = costUsd(modelId, estUsage);
    this.held += usd;
    return { usd, done: false };
  }

  /**
   * Grow a live hold to cover `estUsage` in total — a truncation retry replays
   * the call, so the hold must cover both. The hold's own amount is not counted
   * against itself. Returns false, leaving the hold unchanged, when the larger
   * amount would not fit (or the model is unpriced).
   */
  widen(hold: BudgetHold, modelId: string, estUsage: SonnetUsage): boolean {
    if (hold.done || priceFor(modelId) === null) return false;
    const usd = costUsd(modelId, estUsage);
    if (usd <= hold.usd) return true;
    if (this.spent + this.held - hold.usd + usd > this.maxCostUsd) return false;
    this.held += usd - hold.usd;
    hold.usd = usd;
    return true;
  }

  /** Give a hold back without spending (the call failed before it cost). */
  release(hold: BudgetHold): void {
    if (hold.done) return;
    hold.done = true;
    this.held -= hold.usd;
  }

  /** Replace a hold with what the call actually used. Throws like `record`. */
  settle(hold: BudgetHold, modelId: string, usage: SonnetUsage): void {
    this.release(hold);
    this.record(modelId, usage);
  }

  /**
   * Record a completed call's actual usage. Throws BudgetExhausted when the cap
   * is reached (cost) or the model has no pricing (no_pricing) — the cap is a
   * real ceiling. Writes a best-effort audit line.
   */
  record(modelId: string, usage: SonnetUsage): void {
    if (priceFor(modelId) === null) {
      throw new BudgetExhausted(
        "no_pricing",
        `no pricing for model '${modelId}' — refusing to spend against an unpriced model`,
      );
    }
    const c = costUsd(modelId, usage);
    this.spent += c;
    this.calls += 1;
    this.audit(modelId, usage, c);
    if (this.spent > this.maxCostUsd) {
      throw new BudgetExhausted(
        "cost",
        `budget exhausted: spent $${this.spent.toFixed(4)} > cap $${this.maxCostUsd.toFixed(2)} (label=${this.label})`,
      );
    }
  }

  totalSpent(): number {
    return this.spent;
  }

  snapshot(): BudgetSnapshot {
    return {
      spentUsd: this.spent,
      maxCostUsd: this.maxCostUsd,
      callsRecorded: this.calls,
    };
  }

  private audit(modelId: string, usage: SonnetUsage, cost: number): void {
    const dir = auditDir();
    if (!dir) return;
    appendAudit(dir, {
      kind: "budget",
      label: this.label,
      model_id: modelId,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: Number(cost.toFixed(6)),
      cumulative_usd: Number(this.spent.toFixed(6)),
      at: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// DB-backed spend ledger (migration 081) — durable, cross-process accounting
// behind oauth_clients.budget_usd_per_day. The in-process BudgetTracker above
// caps ONE call site within ONE process; this ledger is what makes a per-
// client daily cap real: actuals in mcp_spend_log, in-flight estimates in
// mcp_spend_reservations (reserve → settle/release, TTL-swept on crash).
// Amounts are stored as NUMERIC cents (fractional cents allowed); the API
// speaks USD.
// ---------------------------------------------------------------------------

/** Default reservation TTL — long enough for one LLM call, short enough that
 *  a crashed process frees its held budget quickly. */
export const SPEND_RESERVATION_TTL_MS = 120_000;

const CENTS_PER_USD = 100;

function usdToCents(usd: number): number;
function usdToCents(usd: number | null): number | null;
function usdToCents(usd: number | null): number | null {
  if (usd === null) return null;
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`spend amount must be a non-negative finite USD number (got ${usd})`);
  }
  return usd * CENTS_PER_USD;
}

/** UTC day start for the rolling per-day window (deterministic, session-
 *  timezone-independent — computed here, never via date_trunc in SQL). */
export function utcDayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Prefixes of generated OAuth client ids and enrollment ids, under both the
 *  current and the pre-rename name (existing ids keep theirs). Spend is booked
 *  under a PAT's name, so a PAT named in any of these namespaces would share
 *  another principal's ledger key and cap. */
export const RESERVED_SPEND_ID_PREFIXES = ["memrain_cl_", "memrain_enr_", "memex_cl_", "memex_enr_"] as const;

/** Why `name` cannot be minted as a PAT name, or null when it is free to use. */
export function patNameSpendConflict(name: string): string | null {
  if (name === BRAIN_SPEND_ID) {
    return (
      `the token name "${BRAIN_SPEND_ID}" is reserved — it is the ledger key of ` +
      `the brain's own paid calls and would share their holds`
    );
  }
  const prefix = RESERVED_SPEND_ID_PREFIXES.find((p) => name.startsWith(p));
  if (prefix === undefined) return null;
  return (
    `token names starting with "${prefix}" are reserved for generated ids — ` +
    `spend is booked under the name and would share that id's ledger and cap`
  );
}

export interface SpendLogInput {
  clientId?: string | null;
  tokenName?: string | null;
  operation: string;
  /** Null when the model has no price: the cost is unknown, not zero. */
  costUsd: number | null;
  provider?: string | null;
  model?: string | null;
  /** What the provider reported; omitted when it reported nothing. */
  usage?: ReportedUsage;
  /** Cycle phase the call ran under (see `runWithSpendTags`). */
  phase?: string | null;
  /** Queued job the call ran under. */
  jobId?: string | null;
  outcome?: SpendOutcome | null;
  /** Time spent in the provider call. */
  latencyMs?: number | null;
  /** Wallet path the call was spent on (see `runInWallet`). */
  role?: string | null;
  /** Daemon, and the source its run serves, the call was spent for. */
  daemon?: string | null;
  daemonSource?: string | null;
  /** Part of `costUsd` above the call's hold; left out of every cap sum. */
  overrunUsd?: number | null;
}

/** How a booked call ended; `refused` never reached the provider. */
export type SpendOutcome = "ok" | "error" | "halted" | "refused";

/** Append one completed paid call to the durable spend log. */
export async function logSpend(engine: Engine, e: SpendLogInput): Promise<void> {
  if (typeof e.operation !== "string" || e.operation.length === 0) {
    throw new Error("logSpend: operation must be a non-empty string");
  }
  await engine.query(
    `INSERT INTO mcp_spend_log (client_id, token_name, operation, spend_cents, provider, model,
                                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                phase, job_id, outcome, latency_ms, role, daemon, daemon_source, overrun_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      e.clientId ?? null,
      e.tokenName ?? null,
      e.operation,
      usdToCents(e.costUsd),
      e.provider ?? null,
      e.model ?? null,
      e.usage ? e.usage.inputTokens : null,
      e.usage ? e.usage.outputTokens : null,
      e.usage ? (e.usage.cacheReadInputTokens ?? 0) : null,
      e.usage ? (e.usage.cacheWriteInputTokens ?? 0) : null,
      e.phase ?? null,
      e.jobId ?? null,
      e.outcome ?? null,
      e.latencyMs == null ? null : Math.max(0, Math.round(e.latencyMs)),
      e.role ?? null,
      e.daemon ?? null,
      e.daemonSource ?? null,
      e.overrunUsd ? usdToCents(e.overrunUsd) : null,
    ],
  );
}

/**
 * What a settled row counts against a cap: its actual, less any overrun above
 * the hold it was given. The hold is the call's maximum cost, so an overrun is
 * an estimate error the wallet records and pauses on, never spend a cap let in.
 */
const CAPPED_SPEND_SQL = "spend_cents - COALESCE(overrun_cents, 0)";

/**
 * A client's spend so far in the current UTC day: settled actuals PLUS
 * currently-held (pending, unexpired) reservation estimates — so a check
 * during an in-flight call counts that call's held budget.
 */
export async function daySpendUsd(
  engine: Engine,
  clientId: string,
  now: Date = new Date(),
): Promise<number> {
  const dayStart = utcDayStart(now).toISOString();
  const r = await engine.query<{ actual: string | number | null; held: string | number | null }>(
    `SELECT
       (SELECT COALESCE(SUM(${CAPPED_SPEND_SQL}), 0)
          FROM mcp_spend_log
         WHERE client_id = $1 AND created_at >= $2::timestamptz) AS actual,
       (SELECT COALESCE(SUM(estimated_cents), 0)
          FROM mcp_spend_reservations
         WHERE client_id = $1 AND status = 'pending'
           AND created_at >= $2::timestamptz
           AND expires_at > $3::timestamptz) AS held`,
    [clientId, dayStart, now.toISOString()],
  );
  const row = r.rows[0];
  const cents = Number(row?.actual ?? 0) + Number(row?.held ?? 0);
  return cents / CENTS_PER_USD;
}

/**
 * Everything the brain has spent so far in the current UTC day, every spender
 * together (clients, cycle, jobs, CLI): settled actuals plus pending holds.
 * `cycleOnly` narrows both to calls made under a cycle phase.
 */
async function brainWideDaySpendUsd(engine: Engine, now: Date, cycleOnly: boolean): Promise<number> {
  const dayStart = utcDayStart(now).toISOString();
  const phaseFilter = cycleOnly ? " AND phase IS NOT NULL" : "";
  const r = await engine.query<{ actual: string | number | null; held: string | number | null }>(
    `SELECT
       (SELECT COALESCE(SUM(${CAPPED_SPEND_SQL}), 0)
          FROM mcp_spend_log
         WHERE created_at >= $1::timestamptz${phaseFilter}) AS actual,
       (SELECT COALESCE(SUM(estimated_cents), 0)
          FROM mcp_spend_reservations
         WHERE status = 'pending'
           AND created_at >= $1::timestamptz
           AND expires_at > $2::timestamptz${phaseFilter}) AS held`,
    [dayStart, now.toISOString()],
  );
  const row = r.rows[0];
  return (Number(row?.actual ?? 0) + Number(row?.held ?? 0)) / CENTS_PER_USD;
}

/** The brain's spend so far today, every spender, held calls included. */
export function brainDaySpendUsd(engine: Engine, now: Date = new Date()): Promise<number> {
  return brainWideDaySpendUsd(engine, now, false);
}

/** The cycle's spend so far today: calls made under any cycle phase. */
export function cycleDaySpendUsd(engine: Engine, now: Date = new Date()): Promise<number> {
  return brainWideDaySpendUsd(engine, now, true);
}

/** A wallet day-cap key: the ledger columns a cap sums over, and their values. */
type WalletKey =
  | { col: "role"; role: string }
  | { col: "daemon"; daemon: string }
  | { col: "daemon_source"; daemon: string; source: string };

/** Today's capped spend under one wallet key, settled actuals plus pending holds. */
async function walletKeyDaySpendUsd(engine: Engine, key: WalletKey, now: Date): Promise<number> {
  const dayStart = utcDayStart(now).toISOString();
  // Column names come from the closed WalletKey union, never from input.
  const where = key.col === "role" ? "role = $3"
    : key.col === "daemon" ? "daemon = $3"
    : "daemon = $3 AND daemon_source = $4";
  const params: unknown[] = [dayStart, now.toISOString(),
    key.col === "role" ? key.role : key.daemon,
    ...(key.col === "daemon_source" ? [key.source] : [])];
  const r = await engine.query<{ actual: string | number | null; held: string | number | null }>(
    `SELECT
       (SELECT COALESCE(SUM(${CAPPED_SPEND_SQL}), 0)
          FROM mcp_spend_log
         WHERE created_at >= $1::timestamptz AND ${where}) AS actual,
       (SELECT COALESCE(SUM(estimated_cents), 0)
          FROM mcp_spend_reservations
         WHERE status = 'pending'
           AND created_at >= $1::timestamptz
           AND expires_at > $2::timestamptz AND ${where}) AS held`,
    params,
  );
  const row = r.rows[0];
  return (Number(row?.actual ?? 0) + Number(row?.held ?? 0)) / CENTS_PER_USD;
}

/** A wallet path's spend so far today, held calls included. */
export function roleDaySpendUsd(engine: Engine, role: string, now: Date = new Date()): Promise<number> {
  return walletKeyDaySpendUsd(engine, { col: "role", role }, now);
}

/** A daemon's spend so far today over every source, or for one source. */
export function daemonDaySpendUsd(
  engine: Engine,
  daemon: string,
  sourceId?: string,
  now: Date = new Date(),
): Promise<number> {
  return walletKeyDaySpendUsd(
    engine,
    sourceId === undefined ? { col: "daemon", daemon } : { col: "daemon_source", daemon, source: sourceId },
    now,
  );
}

export interface ClientBudgetCheck {
  /** False when a cap exists and today's spend (incl. held) already meets it. */
  allowed: boolean;
  /** The client's configured daily cap; null = no cap configured. */
  capUsd: number | null;
  spentUsd: number;
  /** Remaining headroom; null when uncapped. */
  remainingUsd: number | null;
}

/**
 * Check a client against its oauth_clients.budget_usd_per_day. A client with
 * no cap (NULL) — or an unknown client id (legacy PAT paths) — is allowed.
 */
export async function checkClientBudget(
  engine: Engine,
  clientId: string,
  now: Date = new Date(),
  knownCapUsd?: number | null,
): Promise<ClientBudgetCheck> {
  const capUsd = knownCapUsd !== undefined ? knownCapUsd : await lookupClientCap(engine, clientId);
  const spentUsd = await daySpendUsd(engine, clientId, now);
  if (capUsd === null || !Number.isFinite(capUsd)) {
    return { allowed: true, capUsd: null, spentUsd, remainingUsd: null };
  }
  return {
    allowed: spentUsd < capUsd,
    capUsd,
    spentUsd,
    remainingUsd: Math.max(0, capUsd - spentUsd),
  };
}

/** The cap stored for a spender id: an OAuth client's, else the active
 *  personal access token's of that name, else an enrollment's (whose cap
 *  falls back to its connector's; the live one of a replacement chain, which
 *  shares one spend key). null when none sets one. */
async function lookupClientCap(engine: Engine, clientId: string): Promise<number | null> {
  const r = await engine.query<{ budget_usd_per_day: string | number | null }>(
    `SELECT COALESCE(
       (SELECT budget_usd_per_day FROM oauth_clients WHERE client_id = $1),
       (SELECT MIN(budget_usd_per_day) FROM access_tokens WHERE name = $1 AND revoked_at IS NULL),
       (SELECT COALESCE(e.budget_usd_per_day, c.budget_usd_per_day)
          FROM oauth_enrollments e LEFT JOIN oauth_clients c ON c.client_id = e.client_id
         WHERE COALESCE(e.spend_id, e.id) = $1
         ORDER BY (e.revoked_at IS NULL) DESC, e.created_at DESC
         LIMIT 1)
     ) AS budget_usd_per_day`,
    [clientId],
  );
  const raw = r.rows[0]?.budget_usd_per_day ?? null;
  return raw === null ? null : Number(raw);
}

export interface ReserveSpendInput {
  clientId: string;
  /** The cap resolved when the caller authenticated; omitted = look it up. */
  capUsd?: number | null;
  estimatedUsd: number;
  model: string;
  provider: string;
  /** Reservation TTL override (ms). */
  ttlMs?: number;
  /** Clock seam (tests). */
  now?: Date;
  /** Cycle phase the hold counts against; null outside one. */
  phase?: string | null;
  /** Wallet keys the hold counts against; null outside a wallet path. */
  role?: string | null;
  daemon?: string | null;
  daemonSource?: string | null;
}

export type ReserveSpendResult =
  | { reserved: true; reservationId: string }
  | { reserved: false; reason: "budget_exhausted"; check: ClientBudgetCheck };

/**
 * Pre-flight hold: reject when the client's cap leaves no room for the
 * ESTIMATE on top of today's spend (actuals + other holds), else insert a
 * pending reservation. The cap check + insert run under a per-client
 * advisory xact lock so racing reserves serialize instead of both reading
 * the pre-insert sum and overshooting the daily cap. Harmless on PGLite
 * (single connection — no concurrency to serialize).
 */
export async function reserveSpend(
  engine: Engine,
  input: ReserveSpendInput,
): Promise<ReserveSpendResult> {
  return engine.transaction((tx) => reserveWithin(tx, input));
}

/** `reserveSpend`'s body, for a caller already inside a transaction. */
async function reserveWithin(tx: Engine, input: ReserveSpendInput): Promise<ReserveSpendResult> {
  const now = input.now ?? new Date();
  const estCents = usdToCents(input.estimatedUsd);
  const reservationId = randomUUID();
  const ttl = input.ttlMs ?? SPEND_RESERVATION_TTL_MS;
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `memrain_spend:${input.clientId}`,
  ]);
  const check = await checkClientBudget(tx, input.clientId, now, input.capUsd);
  if (
    check.capUsd !== null &&
    check.spentUsd + estCents / CENTS_PER_USD > check.capUsd
  ) {
    return { reserved: false, reason: "budget_exhausted", check };
  }
  await tx.query(
    `INSERT INTO mcp_spend_reservations
       (reservation_id, client_id, estimated_cents, model, provider, status, created_at, expires_at, phase,
        role, daemon, daemon_source)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6::timestamptz, $7::timestamptz, $8, $9, $10, $11)`,
    [
      reservationId,
      input.clientId,
      estCents,
      input.model,
      input.provider,
      now.toISOString(),
      new Date(now.getTime() + ttl).toISOString(),
      input.phase ?? null,
      input.role ?? null,
      input.daemon ?? null,
      input.daemonSource ?? null,
    ],
  );
  return { reserved: true, reservationId };
}

/**
 * Settle a reservation with the ACTUAL cost: marks it settled and records
 * `actual_cents` on the reservation row. Idempotent — a second settle of the
 * same id is a no-op.
 *
 * It deliberately writes NO mcp_spend_log row. Every paid call books itself
 * against the calling client (`runWithSpendClient` + `bookSpend`), so logging
 * the handler-reported total here would charge the same tokens twice. Do not
 * restore the INSERT without removing that booking first.
 */
export async function settleSpend(
  engine: Engine,
  reservationId: string,
  actualUsd: number,
): Promise<{ settled: boolean }> {
  const actualCents = usdToCents(actualUsd);
  return engine.transaction(async (tx) => {
    const upd = await tx.query<{
      client_id: string;
      model: string;
      provider: string;
    }>(
      `UPDATE mcp_spend_reservations
          SET status = 'settled', actual_cents = $2, settled_at = NOW()
        WHERE reservation_id = $1 AND status = 'pending'
        RETURNING client_id, model, provider`,
      [reservationId, actualCents],
    );
    const row = upd.rows[0];
    if (!row) return { settled: false };
    // No ledger row here. Every paid call now books itself against the calling
    // client (see `runWithSpendClient`), so writing the handler-reported total
    // again would charge the same tokens twice. The reservation keeps
    // `actual_cents` for the audit trail; the spend itself is already logged.
    return { settled: true };
  });
}

/** Release a hold without spending (the call failed before costing money). */
export async function releaseReservation(
  engine: Engine,
  reservationId: string,
): Promise<{ released: boolean }> {
  const r = await engine.query<{ reservation_id: string }>(
    `UPDATE mcp_spend_reservations
        SET status = 'expired', settled_at = NOW()
      WHERE reservation_id = $1 AND status = 'pending'
      RETURNING reservation_id`,
    [reservationId],
  );
  return { released: r.rows.length > 0 };
}

/** TTL sweep: expire pending holds whose window lapsed (crashed callers).
 *  Safe to run from any cycle phase; returns the count expired. */
export async function expireStaleReservations(
  engine: Engine,
  now: Date = new Date(),
): Promise<number> {
  const r = await engine.query<{ reservation_id: string }>(
    `UPDATE mcp_spend_reservations
        SET status = 'expired', settled_at = NOW()
      WHERE status = 'pending' AND expires_at <= $1::timestamptz
      RETURNING reservation_id`,
    [now.toISOString()],
  );
  return r.rows.length;
}

// ---------------------------------------------------------------------------
// Paid-call chokepoint — the ONE wrapper every Bedrock invoke goes through.
//
// Before this, spend was un-attributable: eight sites each built their own
// command, the three search ones threaded no BudgetTracker at all, and the
// tracker itself only ever wrote to an audit FILE that is disabled unless
// MEMRAIN_AUDIT_DIR is set — so on the live deployment the cost was computed and
// thrown away. `trackedInvoke` books every call into mcp_spend_log under an
// operation label naming the feature, which is what makes "where did the $42
// go" answerable with a GROUP BY.
//
// For a capped client it also holds the call's worst case against the day
// before sending, and refuses the call when that would not fit (holdForCall).
// ---------------------------------------------------------------------------

/** memrain's only paid provider. */
const DEFAULT_SPEND_PROVIDER = "bedrock";

export interface TrackedCall {
  /** The feature this call is spent ON — the ledger's attribution key. */
  operation: string;
  /** Resolved model id, as it actually went on the wire (prices the call). */
  model: string;
  /** Defaults to "bedrock". */
  provider?: string;
  /**
   * What the call can cost at most, held against a capped client's day before
   * it is sent. `input` is everything sent as plain input and `cachedInput` a
   * prompt-cache prefix (billed higher when it is written); both are bounded by
   * their UTF-8 byte length, since no token is shorter than a byte.
   */
  worstCase: { input: string; cachedInput?: string; maxOutputTokens: number };
}

/** Per-message framing the provider adds on top of the text (role markers,
 *  template tokens): small, but it is what a short intent call is made of. */
const WORST_CASE_OVERHEAD_TOKENS = 64;

/** The most `call` can cost; null when its model has no price or its output
 *  has no finite bound, since then no maximum exists to hold. */
export function worstCaseUsd(call: TrackedCall): number | null {
  if (priceFor(call.model) === null) return null;
  const w = call.worstCase;
  if (!Number.isFinite(w.maxOutputTokens) || w.maxOutputTokens < 0) return null;
  return costUsd(
    call.model,
    chargeableUsage({
      inputTokens: Buffer.byteLength(w.input, "utf8") + WORST_CASE_OVERHEAD_TOKENS,
      outputTokens: w.maxOutputTokens,
      cacheWriteInputTokens: w.cachedInput ? Buffer.byteLength(w.cachedInput, "utf8") : 0,
    }),
  );
}

/** A client's daily budget refused this call. Fallbacks that swallow errors
 *  (query expansion, intent, rerank) must rethrow it: the caller is owed the
 *  refusal, not a quietly degraded answer. */
export function isBudgetRefusal(err: unknown): boolean {
  return (
    (err instanceof OperationError && err.code === "budget_exhausted") ||
    err instanceof BudgetExhausted
  );
}

/** Sink a wrapped call reports its ACTUAL billed usage to, as soon as the
 *  model reports it — which may be well before the call returns. */
export interface SpendMeter {
  report(usage: ReportedUsage): void;
}

/**
 * The ledger's engine. A module-level sink rather than a threaded argument
 * because the paid sites are leaf helpers (embed a string, classify a query)
 * that have no business taking a database handle. Wired once by whoever opens
 * the DB; until then the chokepoint is a no-op passthrough, exactly like
 * telemetry before its first `setEngine`.
 */
let _ledgerEngine: Engine | null = null;

export function setSpendLedgerEngine(engine: Engine | null): void {
  _ledgerEngine = engine;
}

/**
 * The client a paid call is being made FOR, carried per-request rather than
 * threaded through every leaf helper. The paid sites are things like "embed
 * this string" and "classify this query"; handing each of them a client id
 * would touch every signature between the MCP boundary and Bedrock, and the
 * one that got missed would be the one that books to nobody. AsyncLocalStorage
 * keeps the attribution attached to the request instead, so a helper added
 * later is attributed without being told to be.
 *
 * Empty (operator CLI, cycle, internal token) books NULL exactly as before —
 * those have no per-client cap axis.
 */
const _spendClient = new AsyncLocalStorage<SpendClient | null>();

/**
 * Who a paid call is made for. `capUsd` is the daily cap resolved when the
 * caller authenticated: a number is the cap, null means verified uncapped, and
 * undefined means unknown, so the chokepoint looks it up per call.
 */
export interface SpendClient {
  clientId: string;
  capUsd?: number | null;
}

/** Run `fn` with every paid call inside it booked to `client`. A bare id is a
 *  client whose cap is not known yet. */
export function runWithSpendClient<T>(
  client: SpendClient | string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = typeof client === "string" ? { clientId: client } : (client ?? null);
  return _spendClient.run(ctx && ctx.clientId ? ctx : null, fn);
}

/** The client id in scope for the current paid call, or null. */
export function currentSpendClient(): string | null {
  return _spendClient.getStore()?.clientId ?? null;
}

/** The whole spend context in scope, cap included — what a deferred job has to
 *  carry so it is capped exactly like the request that queued it. */
export function currentSpendContext(): SpendClient | null {
  return _spendClient.getStore() ?? null;
}

/**
 * What a paid call is spent under besides its feature and spender: the cycle
 * phase and the queued job running it. Carried like the spend client, so the
 * leaf helpers book it without being told. A call outside any phase or job
 * books NULL for that column.
 */
export interface SpendTags {
  phase?: string;
  jobId?: string;
}

const _spendTags = new AsyncLocalStorage<SpendTags>();

/** Run `fn` with `tags` on every paid call inside it. Tags merge over the
 *  enclosing ones: a job started inside a phase keeps the phase. Empty
 *  strings and undefined leave the enclosing value in place. */
export function runWithSpendTags<T>(tags: SpendTags, fn: () => T): T {
  const merged: SpendTags = { ..._spendTags.getStore() };
  if (tags.phase) merged.phase = tags.phase;
  if (tags.jobId) merged.jobId = tags.jobId;
  return _spendTags.run(merged, fn);
}

/** The tags in scope (a copy); `{}` outside any. */
export function currentSpendTags(): SpendTags {
  return { ..._spendTags.getStore() };
}

/** Why a brain-wide or cycle daily cap refused a call; the prefix of its message. */
export const DAILY_CAP_REASON = "daily_cap";

/** Which cap refused a call: a day cap (brain, cycle, wallet path, daemon, one
 *  daemon source) or a wallet limit that no rollover clears (see WalletRefusal). */
export type SpendCapScope = "brain" | "cycle" | "role" | "daemon" | "daemon_source" | WalletRefusalScope;

/** A brain-wide, cycle or wallet cap refused the call. Code `budget_exhausted`,
 *  so `isBudgetRefusal` holds too; `reason` survives the public envelope, which
 *  withholds the message. */
export class DailyCapRefusal extends OperationError {
  readonly reason = DAILY_CAP_REASON;
  constructor(
    readonly scope: SpendCapScope,
    message: string,
    suggestion: string,
    /** False when the next UTC day refuses it the same way (an unpriced
     *  model, a single call above the cap): only a config change helps. */
    readonly rollover: boolean = true,
  ) {
    super("budget_exhausted", `${DAILY_CAP_REASON}: ${message}`, suggestion);
  }
}

/** The call was refused by the brain's or the cycle's daily cap — not by a
 *  client's own budget. A batch loop stops for the UTC day on this. */
export function isDailyCapRefusal(err: unknown): boolean {
  return (
    err instanceof OperationError &&
    err.code === "budget_exhausted" &&
    (err as { reason?: unknown }).reason === DAILY_CAP_REASON
  );
}

/** A daily cap refusal the UTC day rollover clears: the day's spend, not the call itself, is over the cap. */
export function isRolloverDailyCapRefusal(err: unknown): boolean {
  return isDailyCapRefusal(err) && (err as { rollover?: unknown }).rollover !== false;
}

const _badCapWarned = new Set<string>();

/** A daily cap from the environment: a non-negative USD amount, else no cap.
 *  Blank is off; a malformed or negative value is off with one warning. */
function envCapUsd(name: string, env: NodeJS.ProcessEnv): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const usd = Number(raw);
  if (Number.isFinite(usd) && usd >= 0) return usd;
  if (!_badCapWarned.has(`${name}=${raw}`)) {
    _badCapWarned.add(`${name}=${raw}`);
    console.warn(`[memrain] ${name}=${JSON.stringify(raw)} is not a non-negative USD amount — no cap applies`);
  }
  return null;
}

/** The brain-wide daily cap over every paid call (`MEMRAIN_DAILY_BUDGET_USD`); null = none. */
export function brainDailyCapUsd(env: NodeJS.ProcessEnv = process.env): number | null {
  return envCapUsd("MEMRAIN_DAILY_BUDGET_USD", env);
}

/** The configured cycle daily cap (`MEMRAIN_CYCLE_MAX_USD_PER_DAY`), whether or
 *  not a phase is in scope; null = none. */
export function configuredCycleDailyCapUsd(env: NodeJS.ProcessEnv = process.env): number | null {
  return envCapUsd("MEMRAIN_CYCLE_MAX_USD_PER_DAY", env);
}

/** The cycle daily cap as it applies to the current call: only under a phase. */
export function cycleDailyCapUsd(env: NodeJS.ProcessEnv = process.env): number | null {
  return currentSpendTags().phase ? configuredCycleDailyCapUsd(env) : null;
}

// ---------------------------------------------------------------------------
// Spend wallet — hierarchical caps over the ledger and holds above.
//
// A paid path runs its work inside `runInWallet`, naming itself (`role`) and,
// for a daemon, the daemon and the source that run serves. Every call inside
// is then held at its maximum possible cost against each cap in scope, all or
// nothing, before it is sent:
//
//   per call      callCapUsd       the call's own maximum, in process
//   per run       runCapUsd        everything this run holds or spent, in process
//   per path/day  dayCapUsd        the path's day, durable (ledger `role`)
//   per daemon    daemon.dayCapUsd       the daemon's day over all sources
//   per source    daemon.sourceDayCapUsd the daemon's day for this source
//   per client    the spend client's budget (runWithSpendClient), as before
//   whole brain   MEMRAIN_DAILY_BUDGET_USD, as before
//
// A path is nested inside another, and every enclosing path's caps still bind.
// Inside a wallet path, a call nobody can price, or whose output has no finite
// bound, is refused even with no cap set: the wallet cannot count it. A path
// marked `requiresBrainCap` (daemons, connectors, chat — paid paths added
// after the wallet) refuses every call while MEMRAIN_DAILY_BUDGET_USD is unset.
//
// After the call a hold is settled at the reported actual. A hold is the
// maximum the call can cost, so an actual above it is an accounting error: the
// ledger keeps the full actual, the caps count only the hold, the path is
// paused (spend_path_pauses) and doctor and the advisor report it until the
// operator resumes the path.
// ---------------------------------------------------------------------------

/** One daemon run's place in the wallet. */
export interface WalletDaemon {
  name: string;
  /** The source this run serves. */
  sourceId: string;
  /** Day cap over this daemon's calls for every source; null = none. */
  dayCapUsd?: number | null;
  /** Day cap over this daemon's calls for `sourceId` alone; null = none. */
  sourceDayCapUsd?: number | null;
}

export interface WalletPath {
  /** The path's ledger name: lowercase letters, digits and `_:.-`. */
  role: string;
  daemon?: WalletDaemon;
  /** A paid path added after the wallet: no call runs until the brain has a
   *  daily cap (MEMRAIN_DAILY_BUDGET_USD). */
  requiresBrainCap?: boolean;
  callCapUsd?: number | null;
  runCapUsd?: number | null;
  dayCapUsd?: number | null;
}

/** What one run has spent and holds against its run cap, in this process. */
interface RunLedger {
  capUsd: number;
  spent: number;
  held: number;
}

interface WalletFrame {
  path: WalletPath;
  run: RunLedger | null;
}

const _wallet = new AsyncLocalStorage<readonly WalletFrame[]>();

const WALLET_ROLE_RE = /^[a-z0-9][a-z0-9_:.-]{0,99}$/;

function assertCap(what: string, v: number | null | undefined): void {
  if (v === null || v === undefined) return;
  if (!Number.isFinite(v) || v < 0) throw new Error(`runInWallet: ${what} must be a non-negative USD amount (got ${v})`);
}

/** Run `fn` as the wallet path `path`: every paid call inside is held against
 *  its caps and every enclosing path's, and booked under its name. */
export function runInWallet<T>(path: WalletPath, fn: () => Promise<T>): Promise<T> {
  if (!WALLET_ROLE_RE.test(path.role)) throw new Error(`runInWallet: invalid path name '${path.role}'`);
  assertCap("callCapUsd", path.callCapUsd);
  assertCap("runCapUsd", path.runCapUsd);
  assertCap("dayCapUsd", path.dayCapUsd);
  assertCap("daemon.dayCapUsd", path.daemon?.dayCapUsd);
  assertCap("daemon.sourceDayCapUsd", path.daemon?.sourceDayCapUsd);
  const run = path.runCapUsd === null || path.runCapUsd === undefined
    ? null
    : { capUsd: path.runCapUsd, spent: 0, held: 0 };
  return _wallet.run([...(_wallet.getStore() ?? []), { path, run }], fn);
}

function walletFrames(): readonly WalletFrame[] {
  return _wallet.getStore() ?? [];
}

/** The innermost wallet path in scope, or null outside every one. */
export function currentWalletPath(): WalletPath | null {
  const frames = walletFrames();
  return frames.length > 0 ? frames[frames.length - 1]!.path : null;
}

/** The path, daemon and daemon source a call in scope is booked under. */
function walletTags(): { role: string | null; daemon: string | null; daemonSource: string | null } {
  const frames = walletFrames();
  let daemon: WalletDaemon | undefined;
  for (const f of frames) if (f.path.daemon) daemon = f.path.daemon;
  return {
    role: frames.length > 0 ? frames[frames.length - 1]!.path.role : null,
    daemon: daemon?.name ?? null,
    daemonSource: daemon?.sourceId ?? null,
  };
}

/** Wallet refusals no UTC rollover clears: a config change, a smaller call or
 *  the operator resuming the path is what lets the next call through. */
export type WalletRefusalScope = "call" | "run" | "unconfigured" | "paused" | "no_pricing" | "accounting";

/** A wallet limit refused the call before it was sent. A non-rollover daily
 *  cap refusal, so batch loops and the job worker stop instead of retrying. */
export class WalletRefusal extends DailyCapRefusal {
  constructor(
    override readonly scope: WalletRefusalScope,
    readonly path: string,
    message: string,
    suggestion: string,
  ) {
    super(scope, message, suggestion, false);
  }
}

/** Paths paused in this process: holds even while the pause table is unreachable. */
const _pausedHere = new Set<string>();

export interface PausedSpendPath {
  path: string;
  reason: string;
  model: string | null;
  heldUsd: number | null;
  actualUsd: number | null;
  pausedAt: string;
}

/** Every path paused after an overrun and not yet resumed. */
export async function pausedSpendPaths(engine: Engine): Promise<PausedSpendPath[]> {
  // scope: operator-only a pause is brain-wide state about a paid path, read by doctor and the operator
  const r = await engine.query<{
    path: string; reason: string; model: string | null;
    held_cents: string | number | null; actual_cents: string | number | null; paused_at: string;
  }>(
    `SELECT path, reason, model, held_cents, actual_cents, paused_at::text AS paused_at
       FROM spend_path_pauses WHERE resolved_at IS NULL ORDER BY paused_at, path`,
  );
  return r.rows.map((row) => ({
    path: row.path,
    reason: row.reason,
    model: row.model,
    heldUsd: row.held_cents === null ? null : Number(row.held_cents) / CENTS_PER_USD,
    actualUsd: row.actual_cents === null ? null : Number(row.actual_cents) / CENTS_PER_USD,
    pausedAt: row.paused_at,
  }));
}

/** Resume a paused path. True when an open pause was resolved. */
export async function resumeSpendPath(engine: Engine, path: string, by: string): Promise<boolean> {
  _pausedHere.delete(path);
  const r = await engine.query<{ id: string }>(
    `UPDATE spend_path_pauses SET resolved_at = NOW(), resolved_by = $2
      WHERE path = $1 AND resolved_at IS NULL RETURNING id::text AS id`,
    [path, by.slice(0, 200)],
  );
  return r.rows.length > 0;
}

async function pausePath(engine: Engine | null, path: string, reason: string, model: string, heldUsd: number, actualUsd: number): Promise<void> {
  _pausedHere.add(path);
  console.warn(`[memrain] spend path '${path}' paused: ${reason}`);
  if (!engine) return;
  try {
    await engine.query(
      `INSERT INTO spend_path_pauses (path, reason, model, held_cents, actual_cents)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (path) WHERE resolved_at IS NULL DO NOTHING`,
      [path, reason.slice(0, 500), model, usdToCents(heldUsd), usdToCents(actualUsd)],
    );
  } catch (err) {
    console.warn(`[memrain] could not record the pause of spend path '${path}': ` +
      (err instanceof Error ? err.message : String(err)));
  }
}

/** The first path in `roles` with an open pause, or null. */
async function firstPausedPath(engine: Engine | null, roles: string[]): Promise<string | null> {
  const local = roles.find((r) => _pausedHere.has(r));
  if (local !== undefined) return local;
  if (!engine) return null;
  // scope: operator-only pauses are brain-wide state about paid paths, never tenant data
  const r = await engine.query<{ path: string }>(
    `SELECT path FROM spend_path_pauses WHERE resolved_at IS NULL AND path = ANY($1::text[]) ORDER BY path LIMIT 1`,
    [roles],
  );
  return r.rows[0]?.path ?? null;
}

/** Wallet paths in scope fail closed on an accounting error when any of them
 *  is a new paid path; the paths that predate the wallet keep failing open. */
function walletFailsClosed(frames: readonly WalletFrame[]): boolean {
  return frames.some((f) => f.path.requiresBrainCap === true);
}

/**
 * The checks a wallet path makes before anything is held: a paused path, a new
 * paid path with no brain cap, a call nobody can bound, a call over its
 * per-call cap. Each refusal is booked as a `refused` row and thrown.
 */
async function walletPreflight(
  call: TrackedCall,
  frames: readonly WalletFrame[],
  worst: number | null,
  engine: Engine | null,
): Promise<number> {
  const innermost = frames[frames.length - 1]!.path.role;
  const refuse = async (scope: WalletRefusalScope, path: string, message: string, suggestion: string): Promise<never> => {
    await bookRefusal(call);
    throw new WalletRefusal(scope, path, message, suggestion);
  };
  let paused: string | null;
  try {
    paused = await firstPausedPath(engine, [...new Set(frames.map((f) => f.path.role))]);
  } catch {
    if (walletFailsClosed(frames)) {
      return refuse("accounting", innermost, `'${call.operation}' was not sent: the spend pause table could not be read`,
        "Check the database, then retry.");
    }
    paused = null;
  }
  if (paused !== null) {
    await refuse("paused", paused,
      `spend path '${paused}' is paused after a call cost more than its hold; '${call.operation}' was not sent`,
      `Check the price table and the overrun in memrain doctor, then run: memrain spend resume ${paused}`);
  }
  const gated = frames.find((f) => f.path.requiresBrainCap === true);
  if (gated && brainDailyCapUsd() === null) {
    await refuse("unconfigured", gated.path.role,
      `'${gated.path.role}' is a paid path that runs only under a brain-wide daily cap, and MEMRAIN_DAILY_BUDGET_USD is unset`,
      "Set MEMRAIN_DAILY_BUDGET_USD (for example 10) and restart.");
  }
  if (gated && !engine) {
    await refuse("unconfigured", gated.path.role,
      `'${gated.path.role}' is a paid path, and no spend ledger is open to count it against the daily cap`,
      "Run it from a process that opened the brain (serve, the worker or the CLI).");
  }
  if (worst === null) {
    return refuse("no_pricing", innermost,
      `'${call.operation}' on model '${call.model}' has no price or no output bound, so its maximum cost is unknown`,
      "Price the model in MODEL_PRICING/EMBEDDING_PRICING and give the call an explicit maximum output.");
  }
  for (const f of frames) {
    const cap = f.path.callCapUsd;
    if (cap !== null && cap !== undefined && worst > cap) {
      await refuse("call", f.path.role,
        `'${call.operation}' may cost up to $${worst.toFixed(4)}, over the $${cap.toFixed(4)} per-call cap of '${f.path.role}'`,
        "Send less input or ask for less output, or raise the path's per-call cap.");
    }
  }
  return worst;
}

/** Hold `worst` against every run cap in scope, all or none. Synchronous, so
 *  racing calls in one process cannot both pass the same headroom. */
function reserveRuns(call: TrackedCall, frames: readonly WalletFrame[], worst: number): RunLedger[] {
  const runs = frames.map((f) => f.run).filter((r): r is RunLedger => r !== null);
  const over = frames.find((f) => f.run !== null && f.run.spent + f.run.held + worst > f.run.capUsd);
  if (over) {
    const r = over.run!;
    throw new WalletRefusal("run", over.path.role,
      `run of '${over.path.role}' has $${(r.spent + r.held).toFixed(4)} of its $${r.capUsd.toFixed(2)} cap spent or held; ` +
        `'${call.operation}' may cost up to $${worst.toFixed(4)} — refused`,
      "The run stops here; the next run starts with a fresh run cap.");
  }
  for (const r of runs) r.held += worst;
  return runs;
}

/** Settle a call's run holds: `spentUsd` is what counts against the run, never more than the hold. */
function settleRuns(runs: RunLedger[], heldUsd: number, spentUsd: number): void {
  for (const r of runs) {
    r.held -= heldUsd;
    r.spent += Math.min(spentUsd, heldUsd);
  }
}

/** Model ids already warned about — one line per unpriced model, not per call. */
const _unpricedWarned = new Set<string>();

/**
 * Run a paid model call and book it.
 *
 * `send` receives a meter and reports the usage Bedrock billed. The booking
 * happens in a `finally`, so a call that reported usage and THEN threw (a
 * parse failure, a dimension check, an aborted read of a delivered response)
 * is still billed — those tokens were charged to the account whether or not
 * the caller got an answer out of them. A call that threw before any usage was
 * reported still writes a $0 row: the attempt is attributable even when it
 * bought nothing.
 *
 * Under a provider lease limit (MEMRAIN_PROVIDER_LEASES, off by default) the
 * call first takes a slot of its model family; a call refused a slot is never
 * held, sent or booked.
 */
export async function trackedInvoke<T>(
  call: TrackedCall,
  send: (meter: SpendMeter) => Promise<T>,
): Promise<T> {
  return withProviderLease(_ledgerEngine, call.provider ?? DEFAULT_SPEND_PROVIDER, call.model,
    () => invokeTracked(call, send), { ownerJob: currentSpendTags().jobId ?? null });
}

async function invokeTracked<T>(
  call: TrackedCall,
  send: (meter: SpendMeter) => Promise<T>,
): Promise<T> {
  let usage: ReportedUsage | undefined;
  const meter: SpendMeter = {
    // A second report REPLACES the first: a retry inside `send` (the cachePoint
    // fallback) is one logical call that was billed once, at whatever the
    // attempt that actually reached the model consumed.
    report: (u) => void (usage = { ...u }),
  };
  if (keywordOnlyMode()) {
    throw new OperationError(
      "unsupported",
      `keyword-only mode (MEMRAIN_KEYWORD_ONLY) makes no model calls: ${call.operation} on ${call.model} was not sent`,
      "Semantic search, embeddings and synthesis need AWS Bedrock: unset MEMRAIN_KEYWORD_ONLY and provide AWS credentials.",
    );
  }
  // Batch work stops at a failure that would only repeat (expired credentials,
  // a model the account may not use, a spent quota) instead of paying for it
  // once per item. Nothing was sent, so nothing is held or booked.
  assertBedrockOpen(call.model);
  const refuseStart = performance.now();
  let hold: CallHold | null;
  try {
    hold = await holdForCall(call);
  } finally {
    noteWriteTiming("ledgerMs", performance.now() - refuseStart);
  }
  const sendStart = performance.now();
  const settleRequestCost = beginRequestCost();
  let failure: unknown;
  let outcome: SpendOutcome = "ok";
  try {
    const result = await send(meter);
    noteBedrockSuccess(call.model);
    return result;
  } catch (err) {
    failure = err;
    outcome = err instanceof BedrockHalted ? "halted" : "error";
    noteBedrockFailure(call.model, err);
    throw err;
  } finally {
    const bookStart = performance.now();
    noteWriteTiming("sendMs", bookStart - sendStart);
    // A call cut off mid-flight reported nothing, yet the model may have run
    // and billed it: its hold keeps counting the worst case for the day rather
    // than settling at $0.
    const keepHold = usage === undefined && failure !== undefined && mayHaveBilled(failure);
    const actualUsd = usage && priceFor(call.model) ? costUsd(call.model, chargeableUsage(usage)) : null;
    settleRequestCost(usage ? actualUsd : failure !== undefined && !keepHold ? 0 : null);
    if (hold) settleRuns(hold.runs, hold.usd, keepHold ? hold.usd : (actualUsd ?? 0));
    await bookSpend(call, usage, hold, keepHold, { outcome, latencyMs: bookStart - sendStart });
    noteWriteTiming("ledgerMs", performance.now() - bookStart);
  }
}

/** A per-call hold outlives any call; it only has to outlive the day it counts in. */
const CALL_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

/** A call's holds: the durable reservation (null when no durable cap is in
 *  scope), the run caps it counts against, and the amount held on each. */
interface CallHold {
  id: string | null;
  usd: number;
  runs: RunLedger[];
}

async function holdForCall(call: TrackedCall): Promise<CallHold | null> {
  const frames = walletFrames();
  if (frames.length === 0) {
    const id = await holdDurable(call, frames, worstCaseUsd(call));
    return id === null ? null : { id, usd: worstCaseUsd(call) ?? 0, runs: [] };
  }
  const worst = await walletPreflight(call, frames, worstCaseUsd(call), _ledgerEngine);
  let runs: RunLedger[];
  try {
    runs = reserveRuns(call, frames, worst);
  } catch (err) {
    await bookRefusal(call);
    throw err;
  }
  try {
    return { id: await holdDurable(call, frames, worst), usd: worst, runs };
  } catch (err) {
    settleRuns(runs, worst, 0);
    throw err;
  }
}

/** A durable day cap a call is held against, and how to read its spend. */
interface DurableCap {
  scope: "brain" | "cycle" | "role" | "daemon" | "daemon_source";
  capUsd: number;
  spent: (tx: Engine, now: Date) => Promise<number>;
  /** Where to raise it, for the refusal's suggestion. */
  knob: string;
}

/** The wallet's durable day caps in scope, every enclosing path's included. */
function walletDurableCaps(frames: readonly WalletFrame[]): DurableCap[] {
  const caps: DurableCap[] = [];
  for (const f of frames) {
    const p = f.path;
    if (p.dayCapUsd !== null && p.dayCapUsd !== undefined) {
      caps.push({ scope: "role", capUsd: p.dayCapUsd, knob: `the day cap of '${p.role}'`,
        spent: (tx, now) => roleDaySpendUsd(tx, p.role, now) });
    }
    const d = p.daemon;
    if (d?.dayCapUsd !== null && d?.dayCapUsd !== undefined) {
      caps.push({ scope: "daemon", capUsd: d.dayCapUsd, knob: `daemon '${d.name}' cap_usd_per_day`,
        spent: (tx, now) => daemonDaySpendUsd(tx, d.name, undefined, now) });
    }
    if (d?.sourceDayCapUsd !== null && d?.sourceDayCapUsd !== undefined) {
      caps.push({ scope: "daemon_source", capUsd: d.sourceDayCapUsd, knob: `daemon '${d.name}' cap_usd_per_day for this source`,
        spent: (tx, now) => daemonDaySpendUsd(tx, d.name, d.sourceId, now) });
    }
  }
  return caps;
}

/**
 * Hold a paid call's worst-case cost against every durable daily cap in scope —
 * the calling client's, the wallet's path, daemon and daemon-source caps, the
 * cycle's and the brain's — or refuse it when the hold would not fit one of
 * them. Returns the reservation id, or null when nothing is held.
 *
 * This is the chokepoint every paid Bedrock call passes through, so the caps
 * cover all of them, not only the ops `withClientSpend` wraps. Holding the
 * worst case BEFORE sending is what keeps concurrent calls inside the caps:
 * each one sees the others' holds under the same locks, where a bare
 * "spent < cap" check let K racing calls all pass and overshoot by K calls.
 * Near a cap this refuses a call whose actual cost would still have fit — the
 * error is on the safe side.
 *
 * Every cap above the client's is checked under ONE brain-wide advisory lock,
 * taken before the per-client one, so racing calls from any spender see each
 * other's holds. The call still takes ONE hold: under the client's id when a
 * client is in scope, else under `BRAIN_SPEND_ID`; every other sum counts the
 * hold by its phase, path or daemon columns whatever its key.
 *
 * With no cap in scope (the default) nothing is held and no query runs. A
 * failure of the accounting query itself ALLOWS the call unheld — accounting
 * must never break a paid path that predates the wallet, the same contract
 * `bookSpend` keeps — except under a new paid path, which refuses instead.
 */
async function holdDurable(call: TrackedCall, frames: readonly WalletFrame[], worst: number | null): Promise<string | null> {
  const engine = _ledgerEngine;
  if (!engine) return null;
  const ctx = currentSpendContext();
  const brainCap = brainDailyCapUsd();
  const cycleCap = cycleDailyCapUsd();
  const walletCaps = walletDurableCaps(frames);
  if (!ctx && brainCap === null && cycleCap === null && walletCaps.length === 0) return null;
  let clientCap: number | null = null;
  if (ctx) {
    try {
      clientCap = ctx.capUsd !== undefined ? ctx.capUsd : await lookupClientCap(engine, ctx.clientId);
    } catch {
      // A failed lookup only waives the client's own cap; the brain and cycle caps still bind.
      clientCap = null;
    }
  }
  if (clientCap === null && brainCap === null && cycleCap === null && walletCaps.length === 0) return null;
  const phase = currentSpendTags().phase ?? null;
  // A cap cannot be charged for a call nobody can price: it would book an
  // unknown cost and the cap would never see it. (A wallet path refused such
  // a call already, in its preflight.)
  if (worst === null) {
    await bookRefusal(call);
    if (clientCap !== null) {
      throw new OperationError(
        "budget_exhausted",
        `'${call.operation}' uses model '${call.model}', which has no price, so it ` +
          `cannot be counted against this client's daily budget`,
        "Price the model in MODEL_PRICING/EMBEDDING_PRICING, or clear the client's budget.",
      );
    }
    throw new DailyCapRefusal(
      brainCap !== null ? "brain" : "cycle",
      `'${call.operation}' uses model '${call.model}', which has no price, so it ` +
        `cannot be counted against the ${brainCap !== null ? "brain" : "cycle"} daily budget`,
      "Price the model in MODEL_PRICING/EMBEDDING_PRICING, or unset the daily cap.",
      false,
    );
  }
  const caps: DurableCap[] = [
    ...(brainCap !== null ? [{ scope: "brain" as const, capUsd: brainCap, knob: "MEMRAIN_DAILY_BUDGET_USD", spent: brainDaySpendUsd }] : []),
    ...(cycleCap !== null ? [{ scope: "cycle" as const, capUsd: cycleCap, knob: "MEMRAIN_CYCLE_MAX_USD_PER_DAY", spent: cycleDaySpendUsd }] : []),
    ...walletCaps,
  ];
  const tags = walletTags();
  type Held =
    | { held: string }
    | { refused: DurableCap; spentUsd: number }
    | { refused: "client"; check: ClientBudgetCheck };
  let held: Held;
  try {
    held = await engine.transaction(async (tx): Promise<Held> => {
      const now = new Date();
      if (caps.length > 0) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [BRAIN_SPEND_LOCK]);
        for (const cap of caps) {
          const spentUsd = await cap.spent(tx, now);
          if (spentUsd + worst > cap.capUsd) return { refused: cap, spentUsd };
        }
      }
      const r = await reserveWithin(tx, {
        clientId: ctx?.clientId ?? BRAIN_SPEND_ID,
        capUsd: clientCap,
        estimatedUsd: worst,
        model: call.model,
        provider: call.provider ?? DEFAULT_SPEND_PROVIDER,
        // Held for the rest of the day unless settled: a hold stranded by a
        // crash over-counts until the day rolls over instead of dropping out
        // while the call it stood for may still be billing.
        ttlMs: CALL_HOLD_TTL_MS,
        now,
        phase,
        ...tags,
      });
      return r.reserved ? { held: r.reservationId } : { refused: "client", check: r.check };
    });
  } catch (err) {
    if (!walletFailsClosed(frames)) return null;
    await bookRefusal(call);
    throw new WalletRefusal("accounting", frames[frames.length - 1]!.path.role,
      `'${call.operation}' was not sent: its hold could not be written (${err instanceof Error ? err.message : String(err)})`,
      "Check the database, then retry.");
  }
  if ("held" in held) return held.held;
  await bookRefusal(call);
  if (held.refused !== "client") {
    const cap = held.refused;
    const label = cap.scope === "role" || cap.scope === "daemon" || cap.scope === "daemon_source" ? cap.knob : `${cap.scope} daily budget`;
    throw new DailyCapRefusal(
      cap.scope,
      `${label} exhausted (spent $${held.spentUsd.toFixed(4)} of ` +
        `$${cap.capUsd.toFixed(2)}; '${call.operation}' may cost up to $${worst.toFixed(4)}) — refused`,
      `Wait for the UTC day to roll over, or raise ${cap.knob}.`,
      worst <= cap.capUsd,
    );
  }
  // OperationError, not BudgetExhausted: the MCP layer renders this code as a
  // proper `budget_exhausted` envelope, so the caller is told its budget ran
  // out rather than being handed a generic failure.
  const check = held.check;
  throw new OperationError(
    "budget_exhausted",
    `daily budget exhausted for this client (spent $${check.spentUsd.toFixed(4)}` +
      (check.capUsd !== null ? ` of $${check.capUsd.toFixed(2)}` : "") +
      `; '${call.operation}' may cost up to $${worst.toFixed(4)}) — refused`,
    "Wait for the UTC day to roll over, or raise the client's budget_usd_per_day.",
  );
}

/** Book a refused call as a $0 `refused` row, best-effort: the refusal is
 *  attributable, and a failed write never replaces the refusal itself. */
async function bookRefusal(call: TrackedCall): Promise<void> {
  const engine = _ledgerEngine;
  if (!engine) return;
  try {
    await logSpend(engine, spendEntry(call, 0, undefined, { outcome: "refused", latencyMs: null }));
  } catch (err) {
    console.warn(
      `[memrain] spend ledger write failed for refused '${call.operation}': ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** The ledger row for one call, attributed to the client and tags in scope. */
function spendEntry(
  call: TrackedCall,
  cost: number | null,
  usage: ReportedUsage | undefined,
  end: { outcome: SpendOutcome; latencyMs: number | null },
): SpendLogInput {
  const tags = currentSpendTags();
  return {
    operation: call.operation,
    costUsd: cost,
    ...(usage ? { usage } : {}),
    provider: call.provider ?? DEFAULT_SPEND_PROVIDER,
    model: call.model,
    clientId: currentSpendClient(),
    phase: tags.phase ?? null,
    jobId: tags.jobId ?? null,
    outcome: end.outcome,
    latencyMs: end.latencyMs,
    ...walletTags(),
  };
}

/** A timeout or an aborted read (including `withDeadline`'s): the request may
 *  have reached the model. An
 *  error returned BY the service (throttling, validation, access) was not billed. */
function mayHaveBilled(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  return /timed? ?out|socket hang up|ECONNRESET/i.test(err.message);
}


/** Float slack when comparing an actual with the hold priced by the same table. */
const OVERRUN_EPSILON_USD = 1e-9;

/**
 * Append one call to the durable ledger. Every failure is logged and swallowed:
 * accounting must never break a paid path, the same contract search telemetry
 * already keeps.
 *
 * A wallet-path call whose actual came out above its hold books the full
 * actual and the excess as `overrun`, which no cap sum counts, and pauses its
 * path. With `keepHold` (the call may have billed without reporting) the row is
 * written and the hold stays pending, still counting the call's worst case.
 */
async function bookSpend(
  call: TrackedCall,
  usage: ReportedUsage | undefined,
  hold: CallHold | null,
  keepHold: boolean,
  end: { outcome: SpendOutcome; latencyMs: number | null },
): Promise<void> {
  const engine = _ledgerEngine;
  const priced = priceFor(call.model) !== null;
  if (!priced && !_unpricedWarned.has(call.model)) {
    _unpricedWarned.add(call.model);
    console.warn(
      `[memrain] spend ledger: no pricing for model '${call.model}' — its calls ` +
        `book an unknown (NULL) cost until MODEL_PRICING/EMBEDDING_PRICING learns it`,
    );
  }
  // Nothing reported means nothing billed; an unpriced model's cost is unknown.
  const cost = !usage ? 0 : priced ? costUsd(call.model, chargeableUsage(usage)) : null;
  // Only a wallet path settles at most its hold: a call outside every path
  // keeps counting its full actual, exactly as before the wallet.
  const role = walletTags().role;
  const overrun = role !== null && hold && cost !== null && cost > hold.usd + OVERRUN_EPSILON_USD ? cost - hold.usd : 0;
  const entry = { ...spendEntry(call, cost, usage, end), ...(overrun > 0 ? { overrunUsd: overrun } : {}) };
  if (overrun > 0) {
    const reason = `'${call.operation}' on ${call.model} reported $${(cost ?? 0).toFixed(6)} against a hold of $${hold!.usd.toFixed(6)}`;
    await pausePath(engine, role!, `overrun: ${reason}`, call.model, hold!.usd, cost ?? 0);
  }
  if (!engine) return;
  const holdId = keepHold ? null : (hold?.id ?? null);
  try {
    if (!holdId) {
      await logSpend(engine, entry);
      return;
    }
    // The actual and the settled hold land in ONE commit, so the call is never
    // counted twice (row + hold) nor dropped (hold gone, row missing). If this
    // fails the hold stays pending and keeps counting its worst case. A hold
    // never settles above itself: the excess is the row's overrun.
    await engine.transaction(async (tx) => {
      await logSpend(tx, entry);
      await tx.query(
        `UPDATE mcp_spend_reservations
            SET status = 'settled', actual_cents = $2, settled_at = NOW()
          WHERE reservation_id = $1 AND status = 'pending'`,
        [holdId, usdToCents(overrun > 0 ? hold!.usd : (cost ?? 0))],
      );
    });
  } catch (err) {
    console.warn(
      `[memrain] spend ledger write failed for '${call.operation}': ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}
