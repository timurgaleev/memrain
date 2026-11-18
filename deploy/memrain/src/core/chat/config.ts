/**
 * The admin chat's switches and money limits, read from the environment per
 * call so a test (or a restart) sees the current values.
 *
 *   MEMRAIN_CHAT                     on/off, default off: no model is called
 *   MEMRAIN_CHAT_MODELS              comma list of model ids; only priced ones count
 *   MEMRAIN_CHAT_ANSWER_MAX_USD      most one answer may cost (default 0.02)
 *   MEMRAIN_CHAT_ANSWER_MAX_USD_CAP  hard ceiling on the above (default 0.50)
 *   MEMRAIN_CHAT_USER_DAY_USD        one owner's day (default 0.50)
 *   MEMRAIN_CHAT_RETENTION_DAYS      message age the purge removes (default 90, 0 keeps all)
 *
 * Chat is a paid path added after the spend wallet, so it also needs the
 * brain-wide day cap (MEMRAIN_DAILY_BUDGET_USD); without it chat stays off.
 */
import { brainDailyCapUsd, chargeableUsage, costUsd, priceFor } from "../budget.ts";
import { DEFAULT_HAIKU_MODEL } from "../llm/haiku.ts";

export const CHAT_DEFAULT_ANSWER_MAX_USD = 0.02;
export const CHAT_DEFAULT_ANSWER_HARD_CAP_USD = 0.5;
export const CHAT_DEFAULT_USER_DAY_USD = 0.5;
export const CHAT_DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 36_500;
const MAX_MODELS = 10;
const MODEL_ID_RE = /^[\w.:/-]{1,200}$/;

/** Gather and output sizes of one chat answer. */
export const CHAT_PAGE_HITS = 8;
export const CHAT_MAX_TAKES = 10;
export const CHAT_OUTPUT_TOKENS = 2000;
export const CHAT_CONDENSE_OUTPUT_TOKENS = 200;
/**
 * The prompt sizes the pre-send estimate assumes, in UTF-8 bytes (no token is
 * shorter than a byte). The synthesis prompt carries the system prompt, the
 * question and at most CHAT_PAGE_HITS excerpts plus CHAT_MAX_TAKES takes; the
 * condense prompt carries a bounded slice of the thread. The estimate is an
 * upper bound within these sizes; the wallet's per-call and per-answer caps
 * hold the real ceiling whatever the prompt turns out to be.
 */
export const CHAT_SYNTH_PROMPT_BYTES = 64 * 1024;
export const CHAT_CONDENSE_PROMPT_BYTES = 12 * 1024;
/** Per-message framing the provider adds on top of the text (matches budget.ts). */
const OVERHEAD_TOKENS = 64;

export interface ChatModel {
  id: string;
  label: string;
  input_usd_per_m: number;
  output_usd_per_m: number;
  /** Most one answer (condense + synthesis) can cost on this model. */
  estimate_usd: number;
}

export interface ChatConfig {
  enabled: boolean;
  /** Why chat is off, for the operator. */
  disabledReason: string | null;
  models: ChatModel[];
  defaultModel: string | null;
  answerCapUsd: number;
  userDayUsd: number;
  retentionDays: number | null;
}

function flagOn(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

/** A non-negative USD amount from the environment, else the fallback. */
function usd(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** `eu.anthropic.claude-haiku-5-5` → `Claude Haiku 5.5`. */
export function modelLabel(id: string): string {
  const base = id.split(".").filter((p) => /[a-z]/i.test(p)).pop() ?? id;
  return base
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function worstUsd(model: string, inputBytes: number, outputTokens: number): number {
  return costUsd(model, chargeableUsage({ inputTokens: inputBytes + OVERHEAD_TOKENS, outputTokens }));
}

/** Most one answer can cost on `model` within the assumed prompt sizes, or null when unpriced. */
export function estimateAnswerUsd(model: string, questionBytes = 4096): number | null {
  if (priceFor(model) === null) return null;
  return (
    worstUsd(model, CHAT_SYNTH_PROMPT_BYTES + questionBytes, CHAT_OUTPUT_TOKENS) +
    worstUsd(model, CHAT_CONDENSE_PROMPT_BYTES + questionBytes, CHAT_CONDENSE_OUTPUT_TOKENS)
  );
}

/** The configured models that have a price, in the configured order. */
export function chatModels(env: NodeJS.ProcessEnv = process.env): ChatModel[] {
  const raw = env["MEMRAIN_CHAT_MODELS"]?.trim();
  const ids = raw ? raw.split(",").map((s) => s.trim()).filter((s) => MODEL_ID_RE.test(s)) : [DEFAULT_HAIKU_MODEL];
  const out: ChatModel[] = [];
  for (const id of [...new Set(ids)].slice(0, MAX_MODELS)) {
    const price = priceFor(id);
    const estimate = estimateAnswerUsd(id);
    if (!price || estimate === null) continue;
    out.push({ id, label: modelLabel(id), input_usd_per_m: price.inputPer1M, output_usd_per_m: price.outputPer1M, estimate_usd: estimate });
  }
  return out;
}

function retentionDays(env: NodeJS.ProcessEnv): number | null {
  const raw = env["MEMRAIN_CHAT_RETENTION_DAYS"]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return CHAT_DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (days === 0) return null;
  return Math.min(days, MAX_RETENTION_DAYS);
}

export function chatConfig(env: NodeJS.ProcessEnv = process.env): ChatConfig {
  const models = chatModels(env);
  const hardCap = usd(env, "MEMRAIN_CHAT_ANSWER_MAX_USD_CAP", CHAT_DEFAULT_ANSWER_HARD_CAP_USD);
  const answerCapUsd = Math.min(usd(env, "MEMRAIN_CHAT_ANSWER_MAX_USD", CHAT_DEFAULT_ANSWER_MAX_USD), hardCap);
  let disabledReason: string | null = null;
  if (!flagOn(env["MEMRAIN_CHAT"])) disabledReason = "Chat is off. Set MEMRAIN_CHAT=1 and restart.";
  else if (brainDailyCapUsd(env) === null) {
    disabledReason = "Chat needs a brain-wide daily cap. Set MEMRAIN_DAILY_BUDGET_USD and restart.";
  } else if (models.length === 0) {
    disabledReason = "No chat model has a price. Set MEMRAIN_CHAT_MODELS to priced model ids.";
  }
  return {
    enabled: disabledReason === null,
    disabledReason,
    models,
    defaultModel: models[0]?.id ?? null,
    answerCapUsd,
    userDayUsd: usd(env, "MEMRAIN_CHAT_USER_DAY_USD", CHAT_DEFAULT_USER_DAY_USD),
    retentionDays: retentionDays(env),
  };
}
