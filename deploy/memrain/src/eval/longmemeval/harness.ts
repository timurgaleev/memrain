/**
 * LongMemEval harness: long-term conversational memory, answered from what
 * Memrain retrieves and graded by a Bedrock Claude judge.
 *
 * For each question, the conversation history (its haystack sessions) is
 * indexed into a brand-new PGLite brain through the normal indexer, the
 * question is run through the normal hybridSearch, one Bedrock Claude model
 * answers from the retrieved excerpts and a second one judges the answer
 * against the gold answer. The brain is deleted afterwards; no question ever
 * sees another's history, and the evidence labels and session ids of the
 * dataset are never indexed or shown to a model.
 *
 * Money: every paid call (chunk embeddings, the query embedding, the answer,
 * the judge) goes through SpendLedger — reserved at its worst-case price
 * before it is sent, with an explicit output cap and a bounded input, and
 * settled at the reported usage after. Unknown prices, oversized inputs and a
 * cap that cannot cover the next question or call all refuse before the call.
 * A question that has any reserved call but no result is never re-run: on
 * resume it is recorded as interrupted, and its open reservations stay charged
 * in full until the operator settles them from the provider bill.
 *
 * The score is labelled "Bedrock-Claude-judged": it is not comparable with
 * figures produced by another judge model or other prompts.
 */
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../core/storage.ts";
import { indexDocument } from "../../core/indexer.ts";
import { hybridSearch, type SearchHit, type SearchOptions } from "../../core/search/hybrid.ts";
import type { SearchMeta } from "../../core/search/search-meta.ts";
import { classifyIntentZeroLlm } from "../../core/search/intent.ts";
import { chunkMarkdown } from "../../core/chunkers/recursive.ts";
import { extractFencedCode } from "../../core/chunkers/fenced-code.ts";
import { costUsd, worstCaseUsd } from "../../core/budget.ts";
import { contextualLlmEnabled } from "../../core/search/contextual-llm.ts";
import { keywordOnlyMode } from "../../core/llm/gateway.ts";
import { DEFAULT_MODEL_ID as TITAN_EMBED_MODEL } from "../../core/embedding.ts";
import { DEFAULT_SONNET_MODEL, STOP_REASON_MAX_TOKENS } from "../../core/llm/sonnet.ts";
import { DEFAULT_HAIKU_MODEL } from "../../core/llm/haiku.ts";
import type { LmeQuestion, LmeSession } from "./dataset.ts";
import { CapExceeded, SpendLedger, type Stage } from "./ledger.ts";
import {
  ANSWER_SYSTEM,
  JUDGE_SYSTEM,
  PROMPT_HASH,
  answerPrompt,
  isAbstention,
  judgePrompt,
  parseJudgeVerdict,
  type AnswerExcerpt,
} from "./prompts.ts";

export { ANSWER_SYSTEM, parseJudgeVerdict };

export const RESULT_LABEL = "Bedrock-Claude-judged";

/** Excerpts retrieved per question. */
export const RETRIEVAL_K = 10;
export const ANSWER_MAX_TOKENS = 400;
export const JUDGE_MAX_TOKENS = 8;
/** Largest single embedding input; a chunk is far smaller, so more means something is wrong. */
export const EMBED_MAX_INPUT_BYTES = 50_000;
/** Retrieved text handed to the answer model. */
export const CONTEXT_MAX_BYTES = 40_000;
export const ANSWER_PROMPT_MAX_BYTES = 48_000;
export const JUDGE_PROMPT_MAX_BYTES = 24_000;
/** Contextual-retrieval prefix the indexer may add in front of a chunk. */
const EMBED_PREFIX_ALLOWANCE_BYTES = 4096;
/** A search embeds its query once, and once more when it retries a zero-hit query. */
const QUERY_EMBEDS_PER_QUESTION = 2;

export interface LmeModels {
  answer: string;
  judge: string;
  embed: string;
}

export const DEFAULT_MODELS: LmeModels = {
  answer: DEFAULT_SONNET_MODEL,
  judge: DEFAULT_HAIKU_MODEL,
  embed: TITAN_EMBED_MODEL,
};

/** The invocation boundary: production wires Bedrock, tests a stub. */
export interface LmeBedrock {
  embed(text: string, modelId: string): Promise<{ vector: number[]; inputTokens: number }>;
  converse(input: { modelId: string; system: string; user: string; maxTokens: number }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    /** Converse's stop reason; "max_tokens" means the output cap cut the reply. */
    stopReason?: string;
  }>;
}

export class UnknownPrice extends Error {
  override name = "UnknownPrice";
}
/** A setting would route a paid call around the ledger. */
export class UnsafeConfig extends Error {
  override name = "UnsafeConfig";
}
export class ResumeMismatch extends Error {
  override name = "ResumeMismatch";
}
export class RunLocked extends Error {
  override name = "RunLocked";
}

/**
 * Search exactly as production ranks, minus every stage that could make a paid
 * call the ledger cannot see: the intent comes from the zero-LLM classifier
 * (MEMRAIN_INTENT_LLM would otherwise spend), and rerank and expansion are off.
 */
export function lmeSearchOptions(
  question: string,
  embedQuery: (text: string) => Promise<number[]>,
  onMeta: (meta: SearchMeta) => void,
): SearchOptions {
  return {
    k: RETRIEVAL_K,
    intent: classifyIntentZeroLlm(question),
    embedQuery,
    noCache: true,
    noTelemetry: true,
    rerank: false,
    graphRerank: false,
    expansion: false,
    noExpansion: true,
    onMeta,
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One process per run directory: two runs sharing a ledger would each check
 * the cap against their own snapshot of it. The lock file is written under a
 * private name and hard-linked into place, so it never exists without its
 * PID, and it is never removed by anyone but its owner: a lock left by a
 * crashed run is reported, and the operator removes it.
 */
function acquireRunLock(outDir: string): () => void {
  const path = join(outDir, "run.lock");
  const mine = join(outDir, `.run.lock.${process.pid}.${randomBytes(4).toString("hex")}`);
  writeFileSync(mine, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  try {
    linkSync(mine, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const holder = Number.parseInt(readFileSync(path, "utf8"), 10);
    const state = Number.isInteger(holder) && holder > 0 && pidAlive(holder)
      ? `is in use by process ${holder}`
      : `holds a lock from process ${Number.isNaN(holder) ? "unknown" : holder}, which is not running`;
    throw new RunLocked(`${outDir} ${state}; remove ${path} only if no run is using the directory`);
  } finally {
    rmSync(mine, { force: true });
  }
  return () => rmSync(path, { force: true });
}
class PaidCallFailed extends Error {
  override name = "PaidCallFailed";
}
class CeilingBreached extends Error {
  override name = "CeilingBreached";
}
class UnboundedInput extends Error {
  override name = "UnboundedInput";
}

/** "incomplete": every question was tried, but some were interrupted and cannot be scored. */
export type RunOutcome = "complete" | "incomplete" | "cap_exceeded" | "call_failed" | "ceiling_breached" | "refused";

export interface TypeScore {
  scored: number;
  correct: number;
  interrupted: number;
  /** correct / scored; null when nothing of the type was scored. */
  accuracy: number | null;
  /** correct / (scored + interrupted): an interrupted question counts as wrong. */
  accuracy_with_interrupted: number | null;
}

export interface LongMemEvalSummary {
  label: string;
  dataset: { url: string; sha256: string };
  prompt_hash: string;
  models: LmeModels;
  retrieval_k: number;
  selected: number;
  /** Questions with a verdict — the accuracy denominator. */
  scored: number;
  correct: number;
  accuracy: number | null;
  /** correct / (scored + interrupted): an interrupted question counts as wrong. */
  accuracy_with_interrupted: number | null;
  by_type: Record<string, TypeScore>;
  judge_unparseable: number;
  /** Scored answers the output cap cut off (stop reason "max_tokens"). */
  answer_truncated: number;
  evidence_recall_mean: number | null;
  interrupted: string[];
  not_run: number;
  spent_usd: number;
  unsettled_reservations: { id: string; question_id: string; stage: Stage; max_usd: number }[];
}

export interface LongMemEvalRunOptions {
  questions: readonly LmeQuestion[];
  dataset: { url: string; sha256: string };
  outDir: string;
  maxUsd: number;
  models?: Partial<LmeModels>;
  limit?: number;
  bedrock: LmeBedrock;
  log?: (line: string) => void;
}

export interface LongMemEvalRunResult {
  outcome: RunOutcome;
  message?: string;
  summary: LongMemEvalSummary;
}

function resolveModels(partial: Partial<LmeModels> = {}): LmeModels {
  const models = { ...DEFAULT_MODELS, ...partial };
  for (const [role, model] of Object.entries(models)) {
    if (worstCaseUsd({ operation: "longmemeval", model, worstCase: { input: "", maxOutputTokens: 0 } }) === null) {
      throw new UnknownPrice(`no price for the ${role} model '${model}': refusing to spend against it`);
    }
  }
  return models;
}

/** Cost of one call's fixed framing plus `bytes` of input and `outputTokens` of output. */
function boundUsd(model: string, bytes: number, outputTokens: number, calls = 1): number {
  const framing = worstCaseUsd({ operation: "longmemeval", model, worstCase: { input: "", maxOutputTokens: 0 } })!;
  return costUsd(model, { inputTokens: bytes, outputTokens: outputTokens * calls }) + framing * calls;
}

export function renderSession(session: LmeSession): string {
  const turns = session.turns.map((t) => `**${t.role}:** ${t.content}`).join("\n\n");
  return `# Conversation on ${session.date}\n\n${turns}\n`;
}

interface StageBound {
  calls: number;
  max_input_bytes: number;
  max_tokens: number;
  max_usd: number;
}

function questionBounds(q: LmeQuestion, models: LmeModels): Record<Stage, StageBound> {
  let calls = 0;
  let bytes = 0;
  for (const s of q.sessions) {
    const text = renderSession(s);
    for (const chunk of chunkMarkdown(text).chunks) {
      calls += 1;
      bytes += Buffer.byteLength(chunk) + EMBED_PREFIX_ALLOWANCE_BYTES;
    }
    // A fenced code block is also embedded symbol by symbol; nested symbols
    // overlap, hence twice its size, and no symbol is shorter than a line.
    for (const fence of extractFencedCode(text)) {
      calls += fence.source.split("\n").length;
      bytes += 2 * Buffer.byteLength(fence.source);
    }
  }
  const queryBytes = Buffer.byteLength(q.question);
  return {
    embed: { calls, max_input_bytes: bytes, max_tokens: 0, max_usd: boundUsd(models.embed, bytes, 0, calls) },
    query_embed: {
      calls: QUERY_EMBEDS_PER_QUESTION,
      max_input_bytes: QUERY_EMBEDS_PER_QUESTION * queryBytes,
      max_tokens: 0,
      max_usd: boundUsd(models.embed, QUERY_EMBEDS_PER_QUESTION * queryBytes, 0, QUERY_EMBEDS_PER_QUESTION),
    },
    answer: {
      calls: 1, max_input_bytes: ANSWER_PROMPT_MAX_BYTES, max_tokens: ANSWER_MAX_TOKENS,
      max_usd: boundUsd(models.answer, ANSWER_PROMPT_MAX_BYTES, ANSWER_MAX_TOKENS),
    },
    judge: {
      calls: 1, max_input_bytes: JUDGE_PROMPT_MAX_BYTES, max_tokens: JUDGE_MAX_TOKENS,
      max_usd: boundUsd(models.judge, JUDGE_PROMPT_MAX_BYTES, JUDGE_MAX_TOKENS),
    },
  };
}

function totalUsd(bounds: Record<Stage, StageBound>): number {
  return Object.values(bounds).reduce((sum, b) => sum + b.max_usd, 0);
}

export interface DryRunEstimate {
  questions: number;
  sessions: number;
  models: LmeModels;
  stages: Record<Stage, StageBound>;
  max_usd: number;
  cap_usd: number | null;
  cap_covers: boolean | null;
}

/** Worst-case spend of a run, computed without any call. */
export function estimateLongMemEval(opts: {
  questions: readonly LmeQuestion[];
  limit?: number;
  models?: Partial<LmeModels>;
  maxUsd?: number;
}): DryRunEstimate {
  const models = resolveModels(opts.models);
  const selected = opts.questions.slice(0, opts.limit ?? opts.questions.length);
  const stages: Record<Stage, StageBound> = {
    embed: { calls: 0, max_input_bytes: 0, max_tokens: 0, max_usd: 0 },
    query_embed: { calls: 0, max_input_bytes: 0, max_tokens: 0, max_usd: 0 },
    answer: { calls: 0, max_input_bytes: 0, max_tokens: ANSWER_MAX_TOKENS, max_usd: 0 },
    judge: { calls: 0, max_input_bytes: 0, max_tokens: JUDGE_MAX_TOKENS, max_usd: 0 },
  };
  for (const q of selected) {
    for (const [stage, b] of Object.entries(questionBounds(q, models)) as [Stage, StageBound][]) {
      stages[stage].calls += b.calls;
      stages[stage].max_input_bytes += b.max_input_bytes;
      stages[stage].max_usd += b.max_usd;
    }
  }
  const maxUsd = Object.values(stages).reduce((sum, b) => sum + b.max_usd, 0);
  return {
    questions: selected.length,
    sessions: selected.reduce((n, q) => n + q.sessions.length, 0),
    models,
    stages,
    max_usd: maxUsd,
    cap_usd: opts.maxUsd ?? null,
    cap_covers: opts.maxUsd === undefined ? null : maxUsd <= opts.maxUsd,
  };
}

/** Every paid call of one question, each reserved and settled on the ledger. */
class QuestionCalls {
  private readonly pending = new Set<Promise<unknown>>();
  private failure: Error | null = null;

  constructor(
    private readonly ledger: SpendLedger,
    private readonly capUsd: number,
    private readonly questionId: string,
    private readonly models: LmeModels,
    private readonly bedrock: LmeBedrock,
  ) {}

  private fail(e: Error): Error {
    this.failure ??= e;
    return e;
  }

  /** Rethrow the first failure — the indexer and search may have swallowed it. */
  check(): void {
    if (this.failure) throw this.failure;
  }

  /** Wait for calls a search gave up waiting for; their settlement must still land. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private reserve(stage: Stage, model: string, input: string, maxInputBytes: number, maxTokens: number): { id: string; maxUsd: number } {
    const bytes = Buffer.byteLength(input);
    if (bytes > maxInputBytes) {
      throw this.fail(new UnboundedInput(`${stage} input for ${this.questionId} is ${bytes} bytes, over the ${maxInputBytes}-byte bound`));
    }
    const maxUsd = worstCaseUsd({ operation: "longmemeval", model, worstCase: { input, maxOutputTokens: maxTokens } });
    if (maxUsd === null) throw this.fail(new UnknownPrice(`no price for '${model}'`));
    try {
      const id = this.ledger.reserve({
        question_id: this.questionId, stage, model, max_usd: maxUsd, max_input_bytes: bytes, max_tokens: maxTokens,
      }, this.capUsd);
      return { id, maxUsd };
    } catch (e) {
      throw this.fail(e as Error);
    }
  }

  private settle(id: string, maxUsd: number, model: string, usage: { inputTokens: number; outputTokens: number } | null): void {
    const usd = usage ? costUsd(model, usage) : maxUsd;
    this.ledger.settle(id, {
      usd, outcome: "ok", source: usage ? "reported" : "reservation", ...(usage ? { usage } : {}),
    });
    if (usd > maxUsd) {
      throw this.fail(new CeilingBreached(`call ${id} cost $${usd} against a $${maxUsd} reservation`));
    }
  }

  private async invoke<T>(id: string, maxUsd: number, call: () => Promise<T>): Promise<T> {
    const p = call();
    this.pending.add(p);
    try {
      return await p;
    } catch (e) {
      // Sent, so it may have been billed: charge the reservation in full.
      this.ledger.settle(id, { usd: maxUsd, outcome: "error", source: "reservation" });
      throw this.fail(new PaidCallFailed(`${this.questionId}: ${e instanceof Error ? e.message : String(e)}`));
    } finally {
      this.pending.delete(p);
    }
  }

  async embed(stage: "embed" | "query_embed", text: string): Promise<number[]> {
    const model = this.models.embed;
    const { id, maxUsd } = this.reserve(stage, model, text, EMBED_MAX_INPUT_BYTES, 0);
    const res = await this.invoke(id, maxUsd, () => this.bedrock.embed(text, model));
    this.settle(id, maxUsd, model, res.inputTokens > 0 ? { inputTokens: res.inputTokens, outputTokens: 0 } : null);
    return res.vector;
  }

  async converse(stage: "answer" | "judge", system: string, user: string): Promise<{ text: string; usd: number; stopReason?: string }> {
    const model = stage === "answer" ? this.models.answer : this.models.judge;
    const maxTokens = stage === "answer" ? ANSWER_MAX_TOKENS : JUDGE_MAX_TOKENS;
    const maxBytes = stage === "answer" ? ANSWER_PROMPT_MAX_BYTES : JUDGE_PROMPT_MAX_BYTES;
    const { id, maxUsd } = this.reserve(stage, model, system + user, maxBytes, maxTokens);
    const res = await this.invoke(id, maxUsd, () => this.bedrock.converse({ modelId: model, system, user, maxTokens }));
    const reported = res.inputTokens > 0;
    this.settle(id, maxUsd, model, reported ? { inputTokens: res.inputTokens, outputTokens: res.outputTokens } : null);
    return {
      text: res.text, usd: reported ? costUsd(model, res) : maxUsd, ...(res.stopReason ? { stopReason: res.stopReason } : {}),
    };
  }
}

function excerptsFrom(hits: readonly SearchHit[], sessions: ReadonlyMap<string, LmeSession>): AnswerExcerpt[] {
  const out: AnswerExcerpt[] = [];
  let used = 0;
  for (const h of hits) {
    const s = sessions.get(h.sourcePath);
    if (!s) continue;
    const room = CONTEXT_MAX_BYTES - used;
    if (room <= 0) break;
    const buf = Buffer.from(h.content, "utf8");
    const text = buf.byteLength <= room ? h.content : buf.subarray(0, room).toString("utf8").replace(/�$/, "");
    used += Buffer.byteLength(text);
    out.push({ date: s.date, text });
  }
  return out;
}

async function runQuestion(
  q: LmeQuestion,
  calls: QuestionCalls,
  models: LmeModels,
): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "memrain-lme-q-"));
  const storage = new Storage({ dbPath: join(dir, "brain") });
  let opened = false;
  try {
    await storage.init();
    opened = true;
    // Paths carry only a position: the dataset's session ids can name the
    // evidence sessions, and the retrieved text must not.
    const sessions = new Map<string, LmeSession>();
    for (const [i, s] of q.sessions.entries()) {
      const sourcePath = `conversations/session-${String(i + 1).padStart(3, "0")}.md`;
      sessions.set(sourcePath, s);
      await indexDocument(storage, { sourcePath, text: renderSession(s) }, {
        embeddingModel: models.embed,
        embedFn: (text) => calls.embed("embed", text),
        inferFrontmatter: false,
        requireCompleteEmbeddings: true,
      });
      calls.check();
    }
    let degraded: string[] = [];
    const hits = await hybridSearch(storage, q.question, {
      ...lmeSearchOptions(q.question, (text) => calls.embed("query_embed", text), (m) => { degraded = [...m.degraded]; }),
      embeddingModel: models.embed,
    });
    await calls.drain();
    calls.check();

    const retrieved = [...new Set(hits.map((h) => sessions.get(h.sourcePath)?.id).filter((x): x is string => !!x))];
    const gold = q.answer_session_ids;
    const evidenceRecall = gold.length === 0 ? null : gold.filter((id) => retrieved.includes(id)).length / gold.length;

    const answer = await calls.converse("answer", ANSWER_SYSTEM, answerPrompt(q, excerptsFrom(hits, sessions)));
    const judge = await calls.converse("judge", JUDGE_SYSTEM, judgePrompt(q, answer.text));
    const verdict = parseJudgeVerdict(judge.text);
    return {
      status: "scored",
      question_type: q.question_type,
      abstention: isAbstention(q),
      correct: verdict === true,
      judge_verdict: verdict === null ? "unparseable" : verdict ? "yes" : "no",
      judge_raw: judge.text.slice(0, 200),
      hypothesis: answer.text.slice(0, 4000),
      answer_stop_reason: answer.stopReason ?? null,
      retrieved_session_ids: retrieved,
      evidence_recall: evidenceRecall,
      search_degraded: degraded,
    };
  } finally {
    if (opened) await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function runHeader(dataset: { url: string; sha256: string }, models: LmeModels): Record<string, unknown> {
  return {
    label: RESULT_LABEL,
    dataset,
    prompt_hash: PROMPT_HASH,
    models,
    retrieval_k: RETRIEVAL_K,
    bounds: {
      answer_max_tokens: ANSWER_MAX_TOKENS,
      judge_max_tokens: JUDGE_MAX_TOKENS,
      embed_max_input_bytes: EMBED_MAX_INPUT_BYTES,
      context_max_bytes: CONTEXT_MAX_BYTES,
      answer_prompt_max_bytes: ANSWER_PROMPT_MAX_BYTES,
      judge_prompt_max_bytes: JUDGE_PROMPT_MAX_BYTES,
    },
  };
}

function summarize(
  ledger: SpendLedger,
  header: Record<string, unknown>,
  selected: readonly LmeQuestion[],
): LongMemEvalSummary {
  const results = ledger.results();
  const byType: LongMemEvalSummary["by_type"] = {};
  const typeOf = (q: LmeQuestion): TypeScore => {
    const type = isAbstention(q) ? "abstention" : q.question_type;
    return (byType[type] ??= { scored: 0, correct: 0, interrupted: 0, accuracy: null, accuracy_with_interrupted: null });
  };
  let scored = 0;
  let correct = 0;
  let unparseable = 0;
  let truncated = 0;
  const recalls: number[] = [];
  const interrupted: string[] = [];
  let notRun = 0;
  for (const q of selected) {
    const r = results.get(q.question_id);
    if (!r) {
      notRun++;
      continue;
    }
    if (r.status === "interrupted") {
      interrupted.push(q.question_id);
      typeOf(q).interrupted++;
      continue;
    }
    scored++;
    const ok = r.correct === true;
    if (ok) correct++;
    if (r.judge_verdict === "unparseable") unparseable++;
    if (r.answer_stop_reason === STOP_REASON_MAX_TOKENS) truncated++;
    if (typeof r.evidence_recall === "number") recalls.push(r.evidence_recall);
    const t = typeOf(q);
    t.scored++;
    if (ok) t.correct++;
  }
  for (const t of Object.values(byType)) {
    t.accuracy = t.scored === 0 ? null : t.correct / t.scored;
    t.accuracy_with_interrupted = t.correct / (t.scored + t.interrupted);
  }
  return {
    label: RESULT_LABEL,
    dataset: header.dataset as LongMemEvalSummary["dataset"],
    prompt_hash: header.prompt_hash as string,
    models: header.models as LmeModels,
    retrieval_k: header.retrieval_k as number,
    selected: selected.length,
    scored,
    correct,
    accuracy: scored === 0 ? null : correct / scored,
    accuracy_with_interrupted: scored + interrupted.length === 0 ? null : correct / (scored + interrupted.length),
    by_type: byType,
    judge_unparseable: unparseable,
    answer_truncated: truncated,
    evidence_recall_mean: recalls.length === 0 ? null : recalls.reduce((a, b) => a + b, 0) / recalls.length,
    interrupted,
    not_run: notRun,
    spent_usd: ledger.spentUsd(),
    unsettled_reservations: ledger.unsettled().map((r) => ({
      id: r.id, question_id: r.question_id, stage: r.stage, max_usd: r.max_usd,
    })),
  };
}

export function ledgerPath(outDir: string): string {
  return join(outDir, "ledger.jsonl");
}

export async function runLongMemEval(opts: LongMemEvalRunOptions): Promise<LongMemEvalRunResult> {
  if (!Number.isFinite(opts.maxUsd) || opts.maxUsd <= 0) throw new Error("--max-usd must be a positive number");
  const models = resolveModels(opts.models);
  if (keywordOnlyMode()) {
    throw new UnsafeConfig(
      "MEMRAIN_KEYWORD_ONLY is on: nothing would be embedded and no model could answer, so the score would not measure Memrain's retrieval",
    );
  }
  if (contextualLlmEnabled()) {
    throw new UnsafeConfig("MEMRAIN_CONTEXTUAL_LLM is on: the indexer would make paid calls outside this run's ledger");
  }
  const log = opts.log ?? (() => {});
  const selected = opts.questions.slice(0, opts.limit ?? opts.questions.length);
  mkdirSync(opts.outDir, { recursive: true, mode: 0o700 });
  const release = acquireRunLock(opts.outDir);
  try {
    return await runLocked(opts, models, selected, log);
  } finally {
    release();
  }
}

async function runLocked(
  opts: LongMemEvalRunOptions,
  models: LmeModels,
  selected: readonly LmeQuestion[],
  log: (line: string) => void,
): Promise<LongMemEvalRunResult> {
  const ledger = SpendLedger.open(ledgerPath(opts.outDir));
  const header = runHeader(opts.dataset, models);
  const existing = ledger.header();
  if (existing === null) {
    ledger.writeHeader(header);
  } else if (JSON.stringify(existing) !== JSON.stringify(header)) {
    throw new ResumeMismatch(
      `${ledgerPath(opts.outDir)} was written under a different dataset, prompts, models or bounds; use a new --out`,
    );
  }
  ledger.recordCap(opts.maxUsd);

  for (const qid of ledger.questionsWithCalls()) {
    if (!ledger.results().has(qid)) {
      ledger.appendResult(qid, {
        status: "interrupted",
        reason: "a paid call was reserved but the question never finished; it is not run again",
      });
    }
  }

  let outcome: RunOutcome = "complete";
  let message: string | undefined;
  for (const q of selected) {
    if (ledger.results().has(q.question_id)) continue;
    const worst = totalUsd(questionBounds(q, models));
    if (ledger.spentUsd() + worst > opts.maxUsd) {
      outcome = "cap_exceeded";
      message = `${q.question_id} could cost up to $${worst.toFixed(4)}; $${ledger.spentUsd().toFixed(4)} ` +
        `of the $${opts.maxUsd} cap is already spent or reserved`;
      break;
    }
    const calls = new QuestionCalls(ledger, opts.maxUsd, q.question_id, models, opts.bedrock);
    try {
      const fields = await runQuestion(q, calls, models);
      ledger.appendResult(q.question_id, { ...fields, cost_usd: ledger.questionSpendUsd(q.question_id) });
      log(`${q.question_id}: ${fields.judge_verdict}`);
    } catch (e) {
      await calls.drain();
      if (e instanceof CapExceeded) outcome = "cap_exceeded";
      else if (e instanceof PaidCallFailed) outcome = "call_failed";
      else if (e instanceof CeilingBreached) outcome = "ceiling_breached";
      else if (e instanceof UnboundedInput || e instanceof UnknownPrice) outcome = "refused";
      else throw e;
      message = (e as Error).message;
      break;
    }
  }

  const summary = summarize(ledger, header, selected);
  if (outcome === "complete" && summary.interrupted.length > 0) {
    outcome = "incomplete";
    message = `${summary.interrupted.length} question(s) were interrupted and are not scored: ${summary.interrupted.join(", ")}`;
  }
  writeFileSync(join(opts.outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return { outcome, ...(message ? { message } : {}), summary };
}

/** Record what the provider billed for a call the run reserved but never settled. */
export function settleReservation(outDir: string, id: string, usd: number): void {
  const release = acquireRunLock(outDir);
  try {
    SpendLedger.open(ledgerPath(outDir)).operatorSettle(id, usd);
  } finally {
    release();
  }
}
