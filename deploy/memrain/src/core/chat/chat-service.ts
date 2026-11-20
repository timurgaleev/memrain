/**
 * One chat turn: the owner's question answered by `think` over the owner's
 * grant, with progress reported as it happens, and the turn stored.
 *
 *   validate → thread → [disabled] → hold → [condense] → think → number
 *   citations → settle → store → answer
 *
 * Money: the answer's ceiling (MEMRAIN_CHAT_ANSWER_MAX_USD, never above
 * MEMRAIN_CHAT_ANSWER_MAX_USD_CAP) is held in the durable ledger against the
 * owner's day (MEMRAIN_CHAT_USER_DAY_USD) before any model call, and checked
 * against the brain's day. Every live call then runs inside the `chat` wallet
 * path, whose per-call and per-run caps are that same ceiling, booked under
 * the owner's spend id. That id carries no day cap of its own inside the
 * turn: the turn's hold already reserved the owner's share and the run cap
 * keeps the turn inside it, so a second owner check would count the turn
 * twice. The brain-wide cap still checks every call, the turn's hold
 * included, which errs on the safe side near that cap. A cancelled turn
 * releases its hold; a model call already on the wire keeps its own hold
 * until it settles.
 *
 * The model gets no tools: it writes text and changes nothing. Retrieved
 * outside text reaches it only inside think's external frame, and the trace
 * carries counts and the refs of gathered evidence, never page text.
 */
import type { Storage } from "../storage.ts";
import type { SearchHit, SearchOptions } from "../search/hybrid.ts";
import { callSonnet, type SonnetFn } from "../llm/sonnet.ts";
import { embedText } from "../embedding.ts";
import {
  brainDailyCapUsd,
  costUsd,
  priceFor,
  releaseReservation,
  reserveSpend,
  runInWallet,
  runUnderHold,
  runWithSpendClient,
  settleSpend,
} from "../budget.ts";
import { runThink, type ThinkResult, type ThinkTraceEvent } from "../synthesis/think.ts";
import { quotedSpans, quoteMatcher } from "../synthesis/quote-verify.ts";
import { pageSourcePath, pageTruthSourcePath } from "../page-index.ts";
import { andSourceScope } from "../source-scope.ts";
import { chatConfig, CHAT_MAX_TAKES, CHAT_OUTPUT_TOKENS, CHAT_PAGE_HITS } from "./config.ts";
import { condenseQuestion, CONDENSE_TURNS } from "./condense.ts";
import { evidenceTier } from "./save.ts";
import { ChatError, chatErrorMessage, classifyChatFailure, type ChatErrorCode } from "./failures.ts";
import {
  appendChatMessage,
  createChatThread,
  getChatThread,
  OPERATOR_CHAT_OWNER,
  recentTurns,
  threadTitle,
  type ChatCitation,
  type ChatOwner,
  type ChatStatus,
  type ChatTraceEvent,
} from "./store.ts";

export { ChatError } from "./failures.ts";
export type { ChatOwner } from "./store.ts";

export const CHAT_MESSAGE_MAX_CHARS = 4000;
/** How long the durable hold may outlive a crashed turn. */
const CHAT_HOLD_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
/** A quoted passage longer than this is not carried on its citation. */
const MAX_CITED_QUOTE_CHARS = 300;

/** The operator's own chat: whole-brain reads, booked under its own spend id. */
export function operatorOwner(): ChatOwner {
  return { key: OPERATOR_CHAT_OWNER, sourceId: "default", spendId: "memrain_chat_operator" };
}

export interface ChatCtx {
  storage: Storage;
  owner: ChatOwner;
  /** Fires when the client goes away or the caller stops the turn. */
  signal?: AbortSignal;
  /**
   * Store a finished answer as `error` until the caller confirms it with
   * confirmAnswer once the client has it (the HTTP stream, after `done`).
   */
  confirmLater?: boolean;
  /** Environment the switches and limits are read from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Test seam: a fake model for both the condense and the answer call. */
  sonnetFn?: SonnetFn;
  /** Test seams for retrieval, forwarded to think. */
  pagesFn?: (question: string, k: number) => Promise<SearchHit[]>;
  embedFn?: ((text: string) => Promise<number[]>) | null;
  embedQuery?: SearchOptions["embedQuery"];
}

export interface ChatTurnInput {
  threadId?: string;
  message: string;
  model?: string;
}

export interface ChatAnswer {
  thread_id: string;
  message_id: number;
  status: ChatStatus;
  answer: string;
  citations: ChatCitation[];
  gaps: string[];
  model: string | null;
  cost_usd: number | null;
  duration_ms: number;
  code?: ChatErrorCode;
}

export type ChatStreamEvent =
  | { event: "trace"; data: ChatTraceEvent }
  | { event: "answer"; data: ChatAnswer };

function turnTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env["MEMRAIN_CHAT_TIMEOUT_MS"]);
  // Stays a minute under the hold's lifetime so the hold never lapses mid-turn.
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, CHAT_HOLD_TTL_MS - 60_000) : DEFAULT_TURN_TIMEOUT_MS;
}

/** One turn per owner at a time: a second send while one runs is refused. */
const inFlight = new Set<string>();

class TurnStopped extends Error {
  constructor() {
    super("chat turn stopped");
    this.name = "AbortError";
  }
}

function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new TurnStopped());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new TurnStopped());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

/** The slug a cited page ref names, and whether it is a page at all. */
function refSlugCandidates(ref: string): string[] {
  for (const prefix of ["page://", "page-truth://"]) {
    if (ref.startsWith(prefix)) {
      const rest = ref.slice(prefix.length);
      const cut = rest.indexOf("/");
      return cut > 0 ? [rest, rest.slice(cut + 1)] : [rest];
    }
  }
  return [];
}

/** Number the kept citations in order and give each a slug and title. */
async function numberCitations(
  storage: Storage,
  owner: ChatOwner,
  result: ThinkResult,
): Promise<ChatCitation[]> {
  const engine = storage.engine();
  const out: ChatCitation[] = [];
  const quotes = citedQuotes(result);
  const citedRefs = (result.synthesis?.citations ?? []).map((c) => c.ref);
  for (const c of result.synthesis?.citations ?? []) {
    const n = out.length + 1;
    if (c.kind === "take") {
      const t = await engine.query<{ claim_text: string }>(`SELECT claim_text FROM synth_takes WHERE take_key = $1`, [c.ref]);
      out.push({ n, slug: c.ref, title: (t.rows[0]?.claim_text ?? c.ref).slice(0, 160), kind: "take" });
      continue;
    }
    let slug = c.ref;
    let title = c.ref.split("/").pop() ?? c.ref;
    let quote: string | undefined;
    for (const candidate of refSlugCandidates(c.ref)) {
      const params: unknown[] = [candidate];
      const scope = andSourceScope("source_id", owner.readSources, params);
      const p = await engine.query<{ slug: string; title: string | null; source_id: string; markdown_body?: string | null }>(
        `SELECT slug, title, source_id${quotes.length > 0 ? ", markdown_body" : ""} FROM pages WHERE slug = $1 AND deleted_at IS NULL${scope}`,
        params,
      );
      const row = p.rows[0];
      if (!row) continue;
      if (pageSourcePath(row.slug, row.source_id) !== c.ref && pageTruthSourcePath(row.slug, row.source_id) !== c.ref) continue;
      slug = row.slug;
      title = row.title ?? row.slug;
      // The page view highlights this passage when the citation opens it: the
      // quote this citation's own marker follows, else one no other citation claims.
      if (quotes.length > 0) {
        const inPage = quoteMatcher(row.markdown_body ?? "");
        const own = (q: CitedQuote) => q.ref !== null && refMatches(c.ref, q.ref);
        const unclaimed = (q: CitedQuote) => q.ref === null || !citedRefs.some((r) => refMatches(r, q.ref!));
        quote = (quotes.find((q) => own(q) && inPage(q.text)) ?? quotes.find((q) => unclaimed(q) && inPage(q.text)))?.text;
      }
      break;
    }
    out.push({ n, slug, title: title.slice(0, 200), kind: "page", ...(quote !== undefined ? { quote } : {}) });
  }
  return out;
}

interface CitedQuote {
  text: string;
  /** The marker right after the quote, lower-cased; null when none follows before the next quote. */
  ref: string | null;
}

/** A marker names a citation by its full ref or by the ref's last path segments, as renderMarkers reads it. */
function refMatches(citationRef: string, marker: string): boolean {
  const r = citationRef.toLowerCase();
  return r === marker || r.endsWith(`/${marker}`);
}

/** The answer's checked quotes short enough to carry, each with the citation marker that follows it. */
function citedQuotes(result: ThinkResult): CitedQuote[] {
  const answer = result.synthesis?.answer ?? "";
  const spans = quotedSpans(answer);
  return spans
    .map((s, i) => {
      const upTo = spans[i + 1]?.start ?? answer.length;
      const marker = /\[([^[\]\n]{1,300})\]/.exec(answer.slice(s.end, upTo));
      return { text: s.text, ref: marker ? marker[1]!.trim().toLowerCase() : null };
    })
    .filter((q) => q.text.length <= MAX_CITED_QUOTE_CHARS);
}

/** Rewrite `[ref]` markers to `[n]`; markers for refs that were dropped go. */
function renderMarkers(answer: string, result: ThinkResult): string {
  const index = new Map<string, number>();
  (result.synthesis?.citations ?? []).forEach((c, i) => index.set(c.ref.toLowerCase(), i + 1));
  const dropped = new Set((result.droppedCitations ?? []).map((r) => r.toLowerCase()));
  // Bounded marker body, no nesting: linear in the answer.
  return answer.replace(/\[([^[\]\n]{1,300})\]/g, (whole, ref: string) => {
    const key = ref.trim().toLowerCase();
    const n = index.get(key) ?? [...index].find(([r]) => r.endsWith(`/${key}`))?.[1];
    if (n !== undefined) return `[${n}]`;
    return dropped.has(key) ? "" : whole;
  }).replace(/ {2,}/g, " ");
}

function emitSafe(onEvent: (e: ChatStreamEvent) => void, e: ChatStreamEvent): void {
  try {
    onEvent(e);
  } catch {
    // A listener that went away does not stop the turn.
  }
}

export async function runChatTurn(
  ctx: ChatCtx,
  input: ChatTurnInput,
  onEvent: (e: ChatStreamEvent) => void,
): Promise<ChatAnswer> {
  const started = Date.now();
  const env = ctx.env ?? process.env;
  const engine = ctx.storage.engine();
  const owner = ctx.owner;
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) throw new ChatError("invalid_params", "Ask a question.");
  if (message.length > CHAT_MESSAGE_MAX_CHARS) {
    throw new ChatError("invalid_params", `A question is at most ${CHAT_MESSAGE_MAX_CHARS} characters.`);
  }
  const cfg = chatConfig(env);
  const model = input.model ?? cfg.defaultModel;
  if (cfg.enabled && (!model || !cfg.models.some((m) => m.id === model))) {
    throw new ChatError("invalid_params", "That model is not offered for chat.");
  }
  if (inFlight.has(owner.key)) throw new ChatError("rate_limited", "An answer is still on its way. Wait for it, or stop it.");
  inFlight.add(owner.key);
  try {
    return await turn(ctx, { ...input, message }, onEvent, { env, cfg, model, started, engine });
  } finally {
    inFlight.delete(owner.key);
  }
}

async function turn(
  ctx: ChatCtx,
  input: ChatTurnInput & { message: string },
  onEvent: (e: ChatStreamEvent) => void,
  t: { env: NodeJS.ProcessEnv; cfg: ReturnType<typeof chatConfig>; model: string | null; started: number; engine: ReturnType<Storage["engine"]> },
): Promise<ChatAnswer> {
  const { env, cfg, engine, started } = t;
  const owner = ctx.owner;
  const db = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ChatError) throw e;
      console.error("[chat] database step failed:", e instanceof Error ? e.message : e);
      throw new ChatError("db_busy", chatErrorMessage("db_busy"));
    }
  };

  let threadId = input.threadId;
  let history: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (threadId !== undefined) {
    const existing = await db(() => getChatThread(engine, owner, threadId!));
    if (!existing) throw new ChatError("invalid_params", "That conversation does not exist.");
    history = await db(() => recentTurns(engine, threadId!, CONDENSE_TURNS));
  } else {
    threadId = await db(() => createChatThread(engine, owner, threadTitle(input.message)));
  }
  await db(() => appendChatMessage(engine, threadId!, { role: "user", content: input.message }));

  const trace: ChatTraceEvent[] = [];
  const emitTrace = (e: ChatTraceEvent): void => {
    trace.push(e);
    emitSafe(onEvent, { event: "trace", data: e });
  };
  const finish = async (
    a: Omit<ChatAnswer, "thread_id" | "message_id" | "duration_ms">,
    tokens?: { input: number; output: number },
    evidence?: string,
  ): Promise<ChatAnswer> => {
    const id = await db(() => appendChatMessage(engine, threadId!, {
      role: "assistant",
      content: a.answer,
      status: ctx.confirmLater && a.status === "ok" ? "error" : a.status,
      citations: a.citations,
      gaps: a.gaps,
      model: a.model,
      costUsd: a.cost_usd,
      ...(tokens ? { inputTokens: tokens.input, outputTokens: tokens.output } : {}),
      trace,
      ...(evidence !== undefined ? { evidenceTier: evidence } : {}),
    }));
    const out: ChatAnswer = { thread_id: threadId!, message_id: id, duration_ms: Date.now() - started, ...a };
    emitSafe(onEvent, { event: "answer", data: out });
    return out;
  };
  const refusal = (status: ChatStatus, code: ChatErrorCode, model: string | null = null) =>
    finish({ status, code, answer: "", citations: [], gaps: [], model, cost_usd: null });

  if (!cfg.enabled) return refusal("disabled", "chat_disabled");
  const model = t.model!;
  const answerCap = cfg.answerCapUsd;

  // The brain's day and the owner's, in one hold before any model is called.
  // The turn's calls run under it (runUnderHold), so the day counts the turn once.
  const hold = await db(() => reserveSpend(engine, {
    clientId: owner.spendId,
    capUsd: cfg.userDayUsd,
    estimatedUsd: answerCap,
    model,
    provider: "bedrock",
    ttlMs: CHAT_HOLD_TTL_MS,
    role: "chat",
    brainCapUsd: brainDailyCapUsd(env),
  }));
  if (!hold.reserved) return refusal("budget", "budget_exhausted", model);

  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop.abort(); }, turnTimeoutMs(env));
  (timer as unknown as { unref?: () => void }).unref?.();
  const onClientAbort = () => stop.abort();
  if (ctx.signal?.aborted) stop.abort();
  ctx.signal?.addEventListener("abort", onClientAbort, { once: true });

  let failure: ChatErrorCode | null = null;
  const tokens = { input: 0, output: 0 };
  const guard = (fn: SonnetFn): SonnetFn => async (call) => {
    try {
      // A turn stopped while it was still gathering never starts a paid call.
      if (stop.signal.aborted) throw new TurnStopped();
      const resp = await untilAborted(fn(call), stop.signal);
      tokens.input += resp.usage.inputTokens;
      tokens.output += resp.usage.outputTokens;
      return resp;
    } catch (e) {
      if (failure === null) failure = stop.signal.aborted ? "timeout" : classifyChatFailure(e);
      if (!stop.signal.aborted) console.error("[chat] model call failed:", e instanceof Error ? e.message : e);
      throw e;
    }
  };
  const live = (operation: string): SonnetFn => (call) => callSonnet(call, { modelId: model, operation });
  const condenseModel = guard(ctx.sonnetFn ?? live("chat-condense"));
  const answerModel = guard(ctx.sonnetFn ?? live("chat"));

  let spentUsd = 0;
  let settled = false;
  try {
    const run = async (): Promise<ThinkResult | null> => {
      let question = input.message;
      if (history.length > 0) {
        const t0 = Date.now();
        try {
          const c = await condenseQuestion(condenseModel, history, input.message);
          const usd = priceFor(c.modelId) ? costUsd(c.modelId, c.usage) : 0;
          spentUsd += usd;
          question = c.question;
          emitTrace({ step: "condense", ms: Date.now() - t0, usd, note: c.rewritten ? "rewritten" : "unchanged" });
        } catch {
          emitTrace({ step: "condense", ms: Date.now() - t0, note: "failed" });
          if (stop.signal.aborted || failure === "budget_exhausted") return null;
          failure = null;
        }
      }
      const left = answerCap - spentUsd;
      if (left <= 0) return null;
      return runThink(ctx.storage, {
        question,
        modelId: model,
        sonnetFn: answerModel,
        k: CHAT_PAGE_HITS,
        maxTakes: CHAT_MAX_TAKES,
        maxTokens: CHAT_OUTPUT_TOKENS,
        maxBudgetUsd: left,
        ...(owner.readSources !== undefined ? { sourceIds: owner.readSources } : {}),
        ...(owner.fenceDiary ? { fenceDiary: true } : {}),
        embedFn: ctx.embedFn !== undefined ? ctx.embedFn : ctx.sonnetFn ? null : (s: string) => embedText(s),
        ...(ctx.embedQuery ? { embedQuery: ctx.embedQuery } : {}),
        ...(ctx.pagesFn ? { pagesFn: ctx.pagesFn } : {}),
        onTrace: (e: ThinkTraceEvent) => { if (e.step !== "settle") emitTrace(e); },
      });
    };
    // Stop and the timeout end the turn at once, even mid-gather, so the
    // owner can ask again. The run left behind starts no model call (guard),
    // but whatever it already started still spends inside the run's cap, so
    // the turn's hold stays until that run ends and is closed then.
    const runP = runInWallet(
      { role: "chat", requiresBrainCap: true, callCapUsd: answerCap, runCapUsd: answerCap },
      () => runWithSpendClient({ clientId: owner.spendId, capUsd: null }, () => runUnderHold(hold.reservationId, run)),
    );
    let result: ThinkResult | null = null;
    let leftBehind = false;
    try {
      result = await untilAborted(runP, stop.signal);
    } catch (e) {
      if (e instanceof TurnStopped) leftBehind = true;
      // A run that throws still ends as a stored error turn, not a bare question.
      else if (failure === null) failure = classifyChatFailure(e);
    }
    if (result) spentUsd += result.spentUsd;
    const spentBefore = spentUsd;
    const closeHold = async (cancelled: boolean): Promise<void> => {
      settled = true;
      const close = (extraUsd: number): Promise<unknown> => cancelled
        ? releaseReservation(engine, hold.reservationId)
        : settleSpend(engine, hold.reservationId, spentBefore + extraUsd);
      if (!leftBehind) {
        await close(0).catch(() => undefined);
        return;
      }
      void runP.then((r) => close(r?.spentUsd ?? 0), () => close(0)).catch(() => undefined);
    };

    if (stop.signal.aborted && !timedOut) {
      await closeHold(true);
      emitTrace({ step: "settle", usd: spentUsd, note: "cancelled" });
      // Nobody is listening for a code: the client stopped the turn.
      return await finish({ status: "error", answer: "", citations: [], gaps: [], model, cost_usd: spentUsd }, tokens);
    }
    await closeHold(false);
    emitTrace({ step: "settle", usd: spentUsd });

    if (result === null || failure !== null || !result.synthesis) {
      const code: ChatErrorCode = timedOut ? "timeout"
        : failure ?? (result === null || result.budgetExhausted ? "budget_exhausted" : "provider_error");
      return await finish({
        status: code === "budget_exhausted" ? "budget" : "error",
        code, answer: "", citations: [], gaps: [], model, cost_usd: spentUsd,
      }, tokens);
    }
    const citations = await db(() => numberCitations(ctx.storage, owner, result));
    // The model read every gathered page and take, cited or not; a saved answer keeps their least trusted tier.
    const evidence = result.evidence ? await db(() => evidenceTier(engine, result.evidence!)) : undefined;
    return await finish({
      status: citations.length > 0 ? "ok" : "refused",
      // Text no citation backs is not shown, stored or fed to the next turn.
      answer: citations.length > 0 ? renderMarkers(result.synthesis.answer, result) : "",
      citations,
      gaps: result.synthesis.gaps,
      model: result.modelId ?? model,
      cost_usd: spentUsd,
    }, tokens, evidence);
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onClientAbort);
    if (!settled) await releaseReservation(engine, hold.reservationId).catch(() => undefined);
  }
}
