/**
 * Chat threads and messages (migration 170). Every read and delete is keyed
 * by the owner: a thread that belongs to someone else reads exactly like one
 * that does not exist.
 */
import { randomUUID } from "node:crypto";
import type { Engine } from "../engine/interface.ts";

/** The operator's owner key: its chat reads the whole brain. */
export const OPERATOR_CHAT_OWNER = "operator";

/** Who a conversation belongs to and what it may read and spend. */
export interface ChatOwner {
  /** `operator` today; a member id once members can sign in. */
  key: string;
  /** The source the owner's threads belong to. */
  sourceId: string;
  /** Ledger key the owner's chat spend is booked and capped under. */
  spendId: string;
  /** Sources the owner may read; undefined reads the whole brain (operator). */
  readSources?: string[];
  /** Keep life/diary pages out of the evidence (any non-operator). */
  fenceDiary?: boolean;
}

export type ChatStatus = "ok" | "refused" | "budget" | "error" | "disabled";

export interface ChatCitation {
  n: number;
  slug: string;
  title: string;
  kind: "page" | "take";
  /** A page citation's passage the answer quotes, as the answer wrote it; absent when it quotes none. */
  quote?: string;
}

export interface ChatTraceEvent {
  step: string;
  count?: number;
  slugs?: string[];
  ms?: number;
  usd?: number;
  note?: string;
}

export interface ChatThread {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatThreadSummary {
  id: string;
  title: string | null;
  updated_at: string;
  message_count: number;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  status: ChatStatus | null;
  citations: ChatCitation[];
  gaps: string[];
  model: string | null;
  cost_usd: number | null;
  trace: ChatTraceEvent[];
  created_at: string;
  saved_slug: string | null;
}

export interface NewChatMessage {
  role: "user" | "assistant";
  content: string;
  status?: ChatStatus;
  citations?: ChatCitation[];
  gaps?: string[];
  model?: string | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  trace?: ChatTraceEvent[];
  evidenceTier?: string | null;
}

/** The stored trace never exceeds this many bytes of JSON. */
export const CHAT_TRACE_MAX_BYTES = 16 * 1024;
const THREAD_TITLE_MAX = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(id: string): boolean {
  return UUID_RE.test(id);
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

const byteLength = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

/**
 * Fit a trace into CHAT_TRACE_MAX_BYTES: drop the slug lists first, then keep
 * the longest prefix that fits and mark its last event `truncated`.
 */
export function capTrace(events: readonly ChatTraceEvent[]): ChatTraceEvent[] {
  if (byteLength(events) <= CHAT_TRACE_MAX_BYTES) return [...events];
  const bare = events.map(({ slugs: _slugs, ...rest }) => rest);
  if (byteLength(bare) <= CHAT_TRACE_MAX_BYTES) return bare;
  const kept: ChatTraceEvent[] = [];
  // Room for the marker the last kept event gets.
  const budget = CHAT_TRACE_MAX_BYTES - 64;
  for (const e of bare) {
    const note = e.note ? e.note.slice(0, 200) : undefined;
    const next = { ...e, ...(note !== undefined ? { note } : {}) };
    if (byteLength([...kept, next]) > budget) break;
    kept.push(next);
  }
  if (kept.length > 0) kept[kept.length - 1] = { ...kept[kept.length - 1]!, note: "truncated" };
  return kept;
}

export function threadTitle(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > THREAD_TITLE_MAX ? `${flat.slice(0, THREAD_TITLE_MAX - 1)}…` : flat;
}

export async function createChatThread(engine: Engine, owner: ChatOwner, title: string): Promise<string> {
  const id = randomUUID();
  await engine.query(
    `INSERT INTO chat_threads (id, owner_key, source_id, title) VALUES ($1, $2, $3, $4)`,
    [id, owner.key, owner.sourceId, title.slice(0, 200)],
  );
  return id;
}

export async function getChatThread(engine: Engine, owner: ChatOwner, id: string): Promise<ChatThread | null> {
  if (!isThreadId(id)) return null;
  // scope: upstream a thread is keyed by owner_key and read only by that owner; its source_id is where it lives, not a read grant
  const r = await engine.query<{ id: string; title: string | null; created_at: unknown; updated_at: unknown }>(
    `SELECT id::text AS id, title, created_at, updated_at FROM chat_threads WHERE id = $1::uuid AND owner_key = $2`,
    [id, owner.key],
  );
  const row = r.rows[0];
  return row ? { id: row.id, title: row.title, created_at: iso(row.created_at), updated_at: iso(row.updated_at) } : null;
}

export async function listChatThreads(engine: Engine, owner: ChatOwner, limit = 100): Promise<ChatThreadSummary[]> {
  // scope: upstream a thread is keyed by owner_key and read only by that owner; its source_id is where it lives, not a read grant
  const r = await engine.query<{ id: string; title: string | null; updated_at: unknown; message_count: number | string }>(
    `SELECT t.id::text AS id, t.title, t.updated_at,
            (SELECT count(*) FROM chat_messages m WHERE m.thread_id = t.id)::int AS message_count
       FROM chat_threads t
      WHERE t.owner_key = $1
      ORDER BY t.updated_at DESC, t.id
      LIMIT $2`,
    [owner.key, Math.max(1, Math.min(500, Math.trunc(limit)))],
  );
  return r.rows.map((row) => ({ id: row.id, title: row.title, updated_at: iso(row.updated_at), message_count: Number(row.message_count) }));
}

interface MessageRow {
  id: number | string;
  role: "user" | "assistant";
  content: string;
  status: ChatStatus | null;
  citations: unknown;
  gaps: unknown;
  model: string | null;
  cost_usd: number | string | null;
  trace: unknown;
  created_at: unknown;
  saved_slug: string | null;
}

const MESSAGE_COLUMNS = `m.id, m.role, m.content, m.status, m.citations, m.gaps, m.model, m.cost_usd, m.trace, m.created_at, m.saved_slug`;

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: Number(row.id),
    role: row.role,
    content: row.content,
    status: row.status,
    citations: json<ChatCitation[]>(row.citations, []),
    gaps: json<string[]>(row.gaps, []),
    model: row.model,
    cost_usd: row.cost_usd === null ? null : Number(row.cost_usd),
    trace: json<ChatTraceEvent[]>(row.trace, []),
    created_at: iso(row.created_at),
    saved_slug: row.saved_slug,
  };
}

/** The thread's messages in order, or null when the owner has no such thread. */
export async function threadMessages(engine: Engine, owner: ChatOwner, threadId: string): Promise<ChatMessage[] | null> {
  if (!(await getChatThread(engine, owner, threadId))) return null;
  const r = await engine.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM chat_messages m WHERE m.thread_id = $1::uuid ORDER BY m.id`,
    [threadId],
  );
  return r.rows.map(toMessage);
}

/** The last `limit` turns of a thread, oldest first, for the condense step. */
export async function recentTurns(engine: Engine, threadId: string, limit: number): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const r = await engine.query<{ role: "user" | "assistant"; content: string }>(
    `SELECT role, content FROM (
       SELECT id, role, content FROM chat_messages
        WHERE thread_id = $1::uuid AND (role = 'user' OR status = 'ok')
        ORDER BY id DESC LIMIT $2
     ) t ORDER BY id`,
    [threadId, limit],
  );
  return r.rows;
}

export async function appendChatMessage(engine: Engine, threadId: string, m: NewChatMessage): Promise<number> {
  return engine.transaction(async (tx) => {
    const r = await tx.query<{ id: number | string }>(
      `INSERT INTO chat_messages (thread_id, role, content, status, citations, gaps, model, cost_usd, input_tokens, output_tokens, trace, evidence_tier)
       VALUES ($1::uuid, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7, $8, $9, $10, $11::text::jsonb, $12)
       RETURNING id`,
      [
        threadId,
        m.role,
        m.content,
        m.status ?? null,
        m.citations ? JSON.stringify(m.citations) : null,
        m.gaps ? JSON.stringify(m.gaps) : null,
        m.model ?? null,
        m.costUsd ?? null,
        m.inputTokens ?? null,
        m.outputTokens ?? null,
        m.trace ? JSON.stringify(capTrace(m.trace)) : null,
        m.evidenceTier ?? null,
      ],
    );
    await tx.query(`UPDATE chat_threads SET updated_at = NOW() WHERE id = $1::uuid`, [threadId]);
    return Number(r.rows[0]!.id);
  });
}

export async function deleteChatThread(engine: Engine, owner: ChatOwner, id: string): Promise<boolean> {
  if (!isThreadId(id)) return false;
  const r = await engine.query<{ id: string }>(
    `DELETE FROM chat_threads WHERE id = $1::uuid AND owner_key = $2 RETURNING id::text AS id`,
    [id, owner.key],
  );
  return r.rows.length > 0;
}

/**
 * An assistant message of the owner's, with its thread's question and the
 * least trusted tier of everything it was written from (null when unknown),
 * or null.
 */
export async function ownedAnswer(
  engine: Engine,
  owner: ChatOwner,
  messageId: number,
): Promise<{ message: ChatMessage; threadId: string; question: string | null; evidenceTier: string | null } | null> {
  if (!Number.isSafeInteger(messageId) || messageId < 1) return null;
  // scope: upstream a thread is keyed by owner_key and read only by that owner; its source_id is where it lives, not a read grant
  const r = await engine.query<MessageRow & { thread_id: string; question: string | null; evidence_tier: string | null }>(
    `SELECT ${MESSAGE_COLUMNS}, m.thread_id::text AS thread_id, m.evidence_tier,
            (SELECT q.content FROM chat_messages q
              WHERE q.thread_id = m.thread_id AND q.role = 'user' AND q.id < m.id
              ORDER BY q.id DESC LIMIT 1) AS question
       FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
      WHERE m.id = $1 AND t.owner_key = $2 AND m.role = 'assistant'`,
    [messageId, owner.key],
  );
  const row = r.rows[0];
  return row ? { message: toMessage(row), threadId: row.thread_id, question: row.question, evidenceTier: row.evidence_tier } : null;
}

/**
 * A finished answer the stream stores before the client has it is kept as
 * `error` until `done` reaches an open stream; this then marks it `ok`. A
 * client that left, or a process that died, before that leaves it `error`, so
 * an answer nobody saw confirmed can never be saved.
 */
export async function confirmAnswer(engine: Engine, messageId: number): Promise<void> {
  await engine.query(
    `UPDATE chat_messages SET status = 'ok' WHERE id = $1 AND role = 'assistant' AND status = 'error'`,
    [messageId],
  );
}

/** Undo confirmAnswer for a client that left before `done` reached it. */
export async function withdrawAnswer(engine: Engine, messageId: number): Promise<void> {
  await engine.query(
    `UPDATE chat_messages SET status = 'error' WHERE id = $1 AND role = 'assistant' AND status = 'ok' AND saved_slug IS NULL`,
    [messageId],
  );
}

export async function setSavedSlug(engine: Engine, messageId: number, slug: string): Promise<void> {
  await engine.query(`UPDATE chat_messages SET saved_slug = $2 WHERE id = $1`, [messageId, slug]);
}

const PURGE_BATCH = 5000;
const PURGE_MAX_BATCHES = 100;

/**
 * A thread is titled by its first question. Once retention took that
 * question, the title is the oldest question left, or none: the expired
 * text must not outlive itself in the thread list.
 */
async function retitleThreads(engine: Engine, threadIds: readonly string[]): Promise<void> {
  if (threadIds.length === 0) return;
  const first = await engine.query<{ id: string; content: string }>(
    `SELECT DISTINCT ON (thread_id) thread_id::text AS id, content FROM chat_messages
      WHERE thread_id = ANY($1::uuid[]) AND role = 'user' ORDER BY thread_id, id`,
    [threadIds],
  );
  const titles = new Map(first.rows.map((r) => [r.id, threadTitle(r.content)]));
  await engine.query(
    `UPDATE chat_threads t SET title = v.title FROM unnest($1::uuid[], $2::text[]) AS v(id, title) WHERE t.id = v.id`,
    [threadIds, threadIds.map((id) => titles.get(id) ?? null)],
  );
}

/**
 * Retention: delete messages older than `days`, then the threads left empty.
 * Batched, oldest first; the cutoff is fixed once per run. Each batch
 * retitles the threads it took messages from in the same transaction.
 * `between` runs after each full batch (the purge phase passes its fence
 * check).
 */
export async function purgeOldChat(
  engine: Engine,
  opts: { days: number | null; now?: Date; between?: () => Promise<void> },
): Promise<{ messages: number; threads: number; capped: boolean }> {
  if (opts.days === null) return { messages: 0, threads: 0, capped: false };
  const cutoff = new Date((opts.now ?? new Date()).getTime() - opts.days * 86_400_000).toISOString();
  let messages = 0;
  let capped = true;
  for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
    if (i > 0) await opts.between?.();
    const n = await engine.transaction(async (tx) => {
      const r = await tx.query<{ n: string; threads: string[] | null }>(
        `WITH doomed AS (
           SELECT id FROM chat_messages WHERE created_at < $1::timestamptz ORDER BY created_at LIMIT $2
         ), gone AS (
           DELETE FROM chat_messages m USING doomed d WHERE m.id = d.id RETURNING m.thread_id
         )
         SELECT count(*)::text AS n, array_agg(DISTINCT thread_id::text) AS threads FROM gone`,
        [cutoff, PURGE_BATCH],
      );
      await retitleThreads(tx, r.rows[0]?.threads ?? []);
      return Number(r.rows[0]?.n ?? 0);
    });
    messages += n;
    if (n < PURGE_BATCH) {
      capped = false;
      break;
    }
  }
  // scope: operator-only retention runs over every owner's history, by age alone
  const t = await engine.query<{ id: string }>(
    `DELETE FROM chat_threads t
      WHERE t.updated_at < $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.thread_id = t.id)
      RETURNING t.id::text AS id`,
    [cutoff],
  );
  return { messages, threads: t.rows.length, capped };
}

/** Count, and with `apply` delete, every thread and message of one owner. */
export async function eraseOwnerChat(
  engine: Engine,
  ownerKey: string,
  apply: boolean,
): Promise<{ threads: number; messages: number }> {
  return engine.transaction(async (tx) => {
    // scope: operator-only the operator's erase command, keyed by the owner it names
    const c = await tx.query<{ threads: number | string; messages: number | string }>(
      `SELECT (SELECT count(*) FROM chat_threads WHERE owner_key = $1)::int AS threads,
              (SELECT count(*) FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE t.owner_key = $1)::int AS messages`,
      [ownerKey],
    );
    const counts = { threads: Number(c.rows[0]?.threads ?? 0), messages: Number(c.rows[0]?.messages ?? 0) };
    if (apply) await tx.query(`DELETE FROM chat_threads WHERE owner_key = $1`, [ownerKey]);
    return counts;
  });
}

export interface ExportedThread extends ChatThread {
  owner_key: string;
  source_id: string;
  messages: ChatMessage[];
}

/** Threads for a data export, narrowed to sources and/or one owner. */
export async function exportChatThreads(
  engine: Engine,
  filter: { sourceIds?: string[]; ownerKey?: string } = {},
): Promise<ExportedThread[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.sourceIds !== undefined) {
    params.push(filter.sourceIds);
    where.push(`source_id = ANY($${params.length}::text[])`);
  }
  if (filter.ownerKey !== undefined) {
    params.push(filter.ownerKey);
    where.push(`owner_key = $${params.length}`);
  } else if (filter.sourceIds !== undefined) {
    // The operator's threads read the whole brain, so a source-scoped export
    // carries them only when it names the operator.
    params.push(OPERATOR_CHAT_OWNER);
    where.push(`owner_key <> $${params.length}`);
  }
  // scope: operator-only the operator's export command; the filter narrows by source and owner
  const threads = await engine.query<{ id: string; title: string | null; created_at: unknown; updated_at: unknown; owner_key: string; source_id: string }>(
    `SELECT id::text AS id, title, created_at, updated_at, owner_key, source_id FROM chat_threads
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`,
    params,
  );
  const out: ExportedThread[] = [];
  for (const t of threads.rows) {
    const m = await engine.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM chat_messages m WHERE m.thread_id = $1::uuid ORDER BY m.id`,
      [t.id],
    );
    out.push({
      id: t.id, title: t.title, created_at: iso(t.created_at), updated_at: iso(t.updated_at),
      owner_key: t.owner_key, source_id: t.source_id, messages: m.rows.map(toMessage),
    });
  }
  return out;
}
