/**
 * The connector sync engine: one run of one connector account.
 *
 * A provider adapter turns its API into pages of already-rendered items per
 * stream (a mail history feed, a calendar, a channel). The engine owns
 * everything the providers share:
 *
 *   - gates before anything is decrypted or fetched: the global switch
 *     (MEMRAIN_CONNECTORS_ENABLED=1, off by default), the account being
 *     enabled and active, its daily item cap and its daily dollar cap, and a
 *     per-account run lock;
 *   - writing: live connector tokens are swept out of the text, then each item
 *     goes through putPage as outside text (secret scan, gate keys stripped)
 *     into the account's source and is mirrored into search, with every paid
 *     embedding booked to `connector:<account>` under the account's cap;
 *   - cursors: a stream's cursor moves to a page's checkpoint only when every
 *     item up to it is written, unchanged, a duplicate or held, so an
 *     interrupted run resumes without skipping anything;
 *   - holds: an item failing ITEM_HOLD_AFTER runs in a row on one version is
 *     held with a back-off and stops blocking its stream; a refusal no retry
 *     can change is held at once; when at least SOURCE_OUTAGE_MIN items of a
 *     page fail and half of them share one error, it is the source failing,
 *     and no item is blamed;
 *   - deletions: each upstream deletion is recorded as pending; at the end of
 *     the run, more than the mass-delete threshold (200 items or 5% of the
 *     account's items, both configurable) holds them all for the owner,
 *     otherwise each is handed to the deletion handler one by one; with no
 *     handler wired they stay pending, and a page a live duplicate still
 *     points at is never handed over;
 *   - a page whose mirror into search failed is not settled: it counts as an
 *     item failure, holds the cursor, and is mirrored again next run;
 *   - a credential the provider will not renew pauses the account
 *     (`markNeedsReconnect`), opens a notice and leaves every cursor where it
 *     was, so reconnecting resumes from the same place.
 */
import type { Storage } from "../storage.ts";
import type { EmbedFn } from "../indexer.ts";
import { putPage } from "../pages.ts";
import { mirrorPage } from "../page-index.ts";
import { syncWikilinksForPage } from "../links.ts";
import { logIngest } from "../ingest-log.ts";
import { OperationError } from "../operation-error.ts";
import { getSource } from "../sources.ts";
import { sweepEchoes, type SecretFinding } from "../secret-scan.ts";
import { daySpendUsd, runWithSpendClient, utcDayStart } from "../budget.ts";
import { acquireWorkerLock, heartbeatWorkerLock, releaseWorkerLock } from "../jobs/worker-lock.ts";
import type { ConnectorClient, ConnectorResponse, TokenSource } from "./client.ts";
import { isDeterministicRefusal } from "./github.ts";
import { ReauthRequiredError, type ConnectorRunStatus, type ResponseClass } from "./types.ts";
import {
  DELETE_CONFIRMED,
  DELETE_PENDING,
  getItem,
  heldItemCount,
  holdPendingDeletes,
  itemsInDeletionState,
  itemsPresent,
  itemsSeenSince,
  markDeletesPending,
  openNotice,
  pageForDedupeKey,
  pageSharedByLiveItem,
  readCursor,
  recordDeleteApplied,
  recordItemFailure,
  recordItemSettled,
  resolveNotice,
  touchItem,
  writeCursor,
  DELETION_STATES,
} from "./sync-store.ts";

/** What the engine needs to know about a connector account. */
export interface SyncAccount {
  id: string;
  sourceId: string;
  provider: string;
  enabled: boolean;
  /** Only `active` runs; `paused`, `needs_reconnect`, `revoked` and the rest are skipped. */
  status: string;
  itemCapDaily: number;
  spendCapUsdDaily: number;
}

/** One provider item, rendered and ready to store. */
export interface RenderedSyncItem {
  externalId: string;
  version: string | null;
  slug: string;
  type: string;
  title: string;
  body: string;
  /** Stable across providers (Message-ID, iCalUID), so one thread seen twice is stored once. */
  dedupeKey?: string | null;
  failure?: undefined;
}

/** An item the adapter could not read or render; counted toward its hold. */
export interface FailedSyncItem {
  externalId: string;
  version: string | null;
  failure: { code: string; message: string };
}

export type SyncItem = RenderedSyncItem | FailedSyncItem;

export type PageResult =
  | {
    ok: true;
    items: SyncItem[];
    /** External ids the provider reports deleted. */
    deletions?: string[];
    /** Where the stream resumes after this page; null when this page is no resume point. */
    checkpoint: string | null;
    /** No more pages in this run. */
    done: boolean;
  }
  | { ok: false; response: ConnectorResponse };

export interface SyncAdapter {
  streams(account: SyncAccount): string[];
  page(ctx: { client: ConnectorClient; account: SyncAccount; stream: string; cursor: string | null; page: number }): Promise<PageResult>;
}

export interface UpstreamDeletion {
  accountId: string;
  sourceId: string;
  externalId: string;
  pageSlug: string | null;
}

export interface AccountGateway {
  /** Pause the account until its owner reconnects it. */
  markNeedsReconnect(accountId: string): Promise<void>;
  /** Optional: remember the run on the account row. */
  recordRun?(accountId: string, result: SyncRunResult): Promise<void>;
}

export interface SyncDeps {
  adapter: SyncAdapter;
  /** Open the account's credential. Throws when it cannot (no key, no row). */
  tokenSource(account: SyncAccount): Promise<TokenSource>;
  client(account: SyncAccount, tokenSource: TokenSource): ConnectorClient;
  accounts: AccountGateway;
  /**
   * Apply one upstream deletion to the brain. Without it a deletion is only
   * recorded on the item row and the page stays.
   */
  onUpstreamDelete?(storage: Storage, item: UpstreamDeletion): Promise<void>;
  embedFn?: EmbedFn;
  now?: () => number;
  env?: Record<string, string | undefined>;
  /** This worker's name in the run lock. */
  holder?: string;
}

export type SyncStopReason =
  | "connectors_disabled"
  | "account_disabled"
  | "account_inactive"
  | "locked"
  | "lock_lost"
  | "cap_reached"
  | "item_cap_reached"
  | "credentials_unavailable"
  | "needs_reconnect"
  | "forbidden"
  | "fetch_failed"
  | "source_outage"
  | "items_failed"
  | "deletions_failed"
  | "page_limit";

export interface SyncCounts {
  items: number;
  pages_written: number;
  pages_unchanged: number;
  duplicates: number;
  items_failed: number;
  items_held: number;
  items_skipped_held: number;
  deletions_seen: number;
  deletions_applied: number;
  deletions_held: number;
  mirror_failures: number;
}

export interface SyncStreamResult {
  stream: string;
  cursor_before: string | null;
  cursor_after: string | null;
  pages: number;
  clean: boolean;
}

export interface SyncRunResult {
  account_id: string;
  source_id: string;
  status: ConnectorRunStatus | "skipped";
  /** Why the run stopped short; null for a full run. */
  stop_reason: SyncStopReason | null;
  counts: SyncCounts;
  streams: SyncStreamResult[];
  error_class: ResponseClass | null;
  http_status: number | null;
  /** Safe to print: built from status codes and classes, tokens scrubbed. */
  error: string | null;
}

const DEFAULT_MAX_ITEMS_PER_RUN = 500;
const DEFAULT_MASS_DELETE_ITEMS = 200;
const DEFAULT_MASS_DELETE_PCT = 5;
/** Pages per stream per run; past it the run stops partial instead of looping. */
export const MAX_PAGES_PER_STREAM = 1000;
export const SOURCE_OUTAGE_MIN = 5;
const RUN_LOCK_TTL_SEC = 900;
const LOG_SLUG_CAP = 500;
const WRITTEN_BY_PREFIX = "connector-";

export function syncLockId(accountId: string): string {
  return `connector-sync:${accountId}`;
}

/** The spend ledger client every paid call of this account's runs books to. */
export function connectorSpendClient(accountId: string): string {
  return `connector:${accountId}`;
}

type Env = Record<string, string | undefined>;

export function connectorsSyncEnabled(env: Env = process.env): boolean {
  return (env.MEMRAIN_CONNECTORS_ENABLED ?? "").trim() === "1";
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const n = Number((env[name] ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function positiveNumber(env: Env, name: string, fallback: number): number {
  const raw = (env[name] ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** True when deleting `count` of `present` items needs the owner's confirmation. */
export function isMassDelete(count: number, present: number, env: Env = process.env): boolean {
  if (count === 0) return false;
  const maxItems = positiveInt(env, "MEMRAIN_CONNECTOR_MASS_DELETE_ITEMS", DEFAULT_MASS_DELETE_ITEMS);
  const pct = positiveNumber(env, "MEMRAIN_CONNECTOR_MASS_DELETE_PCT", DEFAULT_MASS_DELETE_PCT);
  return count > maxItems || count * 100 > pct * present;
}

function emptyCounts(): SyncCounts {
  return {
    items: 0, pages_written: 0, pages_unchanged: 0, duplicates: 0, items_failed: 0, items_held: 0,
    items_skipped_held: 0, deletions_seen: 0, deletions_applied: 0, deletions_held: 0, mirror_failures: 0,
  };
}

/** A token source that remembers every token it handed out, so none can be written into a page. */
function recordingSource(inner: TokenSource, seen: Map<string, string>): TokenSource {
  const keep = (t: string): string => {
    if (t.length > 0) seen.set(t, "connector-token");
    return t;
  };
  return {
    token: async () => keep(await inner.token()),
    refresh: async (stale) => keep(await inner.refresh(stale)),
  };
}

interface PageFailure {
  externalId: string;
  version: string | null;
  code: string;
  message: string;
  deterministic: boolean;
}

/** The single error code shared by most of a page's failures, when the source itself is failing. */
function sourceOutage(failures: readonly PageFailure[], pageItems: number): string | null {
  if (failures.length < SOURCE_OUTAGE_MIN) return null;
  const byCode = new Map<string, number>();
  for (const f of failures) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
  let top: [string, number] = ["", 0];
  for (const entry of byCode) if (entry[1] > top[1]) top = entry;
  return top[1] * 2 >= pageItems ? top[0] : null;
}

export async function runConnectorSync(storage: Storage, account: SyncAccount, deps: SyncDeps): Promise<SyncRunResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const engine = storage.engine();
  const result: SyncRunResult = {
    account_id: account.id,
    source_id: account.sourceId,
    status: "skipped",
    stop_reason: null,
    counts: emptyCounts(),
    streams: [],
    error_class: null,
    http_status: null,
    error: null,
  };
  const skip = (reason: SyncStopReason, status: SyncRunResult["status"] = "skipped"): SyncRunResult => {
    result.status = status;
    result.stop_reason = reason;
    return result;
  };

  if (!connectorsSyncEnabled(env)) return skip("connectors_disabled");
  if (!account.enabled) return skip("account_disabled");
  if (account.status !== "active") return skip("account_inactive");
  if ((await getSource(engine, account.sourceId)) === null) {
    throw new OperationError("invalid_params", `connector account ${account.id} points at unknown source '${account.sourceId}'`);
  }

  const dayStart = utcDayStart(new Date(now()));
  const seenToday = await itemsSeenSince(engine, account.id, dayStart);
  if (seenToday >= account.itemCapDaily) return skip("item_cap_reached", "partial");
  const spendClient = connectorSpendClient(account.id);
  const spentUsd = async (): Promise<number> => daySpendUsd(engine, spendClient, new Date(now()));
  if (account.spendCapUsdDaily <= 0 || (await spentUsd()) >= account.spendCapUsdDaily) return skip("cap_reached", "partial");

  // Unique per run, whatever worker name is given: the worker runs jobs
  // concurrently, and the lock lets its own holder back in.
  const holder = `${deps.holder ?? `pid-${process.pid}`}:${crypto.randomUUID()}`;
  const lockId = syncLockId(account.id);
  if (!(await acquireWorkerLock(engine, lockId, holder, RUN_LOCK_TTL_SEC))) return skip("locked");
  try {
    let source: TokenSource;
    try {
      source = await deps.tokenSource(account);
    } catch (e) {
      if (e instanceof ReauthRequiredError) return await needsReconnect(storage, account, deps, result, null, now);
      // A missing key or credential row is the operator's to fix, not the owner's: no pause.
      result.error = `credentials unavailable (${e instanceof Error ? e.name : "error"})`;
      return skip("credentials_unavailable", "partial");
    }
    const tokens = new Map<string, string>();
    const client = deps.client(account, recordingSource(source, tokens));
    const run = new Run(storage, account, deps, env, now, result, tokens, seenToday, spentUsd, () => heartbeatWorkerLock(engine, lockId, holder));
    await runWithSpendClient({ clientId: spendClient, capUsd: account.spendCapUsdDaily }, () => run.execute(client));
    if (result.stop_reason === "needs_reconnect") return await needsReconnect(storage, account, deps, result, result.http_status, now);
    await deps.accounts.recordRun?.(account.id, result);
    return result;
  } finally {
    await releaseWorkerLock(engine, lockId, holder);
  }
}

async function needsReconnect(
  storage: Storage,
  account: SyncAccount,
  deps: SyncDeps,
  result: SyncRunResult,
  httpStatus: number | null,
  now: () => number,
): Promise<SyncRunResult> {
  result.status = "auth_required";
  result.stop_reason = "needs_reconnect";
  result.error_class = "auth_required";
  result.http_status = httpStatus;
  result.error ??= "the provider will not renew the credential; reconnect the account";
  await deps.accounts.markNeedsReconnect(account.id);
  await openNotice(
    storage.engine(),
    account.id,
    "needs_reconnect",
    `${account.provider} account for source '${account.sourceId}' needs a reconnect: sync is paused, its data and cursors are kept`,
    new Date(now()),
  );
  await deps.accounts.recordRun?.(account.id, result);
  return result;
}

/** One run's mutable state, split out so each step stays small. */
class Run {
  private readonly changed: Array<{ slug: string; body: string }> = [];
  private itemsThisRun = 0;
  private fetchStopped = false;

  constructor(
    private readonly storage: Storage,
    private readonly account: SyncAccount,
    private readonly deps: SyncDeps,
    private readonly env: Env,
    private readonly now: () => number,
    private readonly result: SyncRunResult,
    private readonly tokens: Map<string, string>,
    private readonly seenToday: number,
    private readonly spentUsd: () => Promise<number>,
    private readonly heartbeat: () => Promise<boolean>,
  ) {}

  private get engine() {
    return this.storage.engine();
  }

  private stop(reason: SyncStopReason): void {
    // The first reason wins: it is the one that cut the run short.
    this.result.stop_reason ??= reason;
  }

  async execute(client: ConnectorClient): Promise<void> {
    for (const stream of this.deps.adapter.streams(this.account)) {
      if (this.fetchStopped) break;
      await this.syncStream(client, stream);
    }
    if (this.result.stop_reason !== "needs_reconnect" && this.result.stop_reason !== "forbidden") {
      await this.settleDeletions();
    }
    for (const page of this.changed) {
      await syncWikilinksForPage(this.storage, page.slug, page.body, this.account.sourceId);
    }
    await this.updateHeldNotice();
    this.finishStatus();
    // A clean run proves the credential works again.
    if (this.result.status === "success" || this.result.status === "nothing_new") {
      await resolveNotice(this.engine, this.account.id, "needs_reconnect", this.date());
    }
    await this.logRun();
  }

  private async syncStream(client: ConnectorClient, stream: string): Promise<void> {
    const before = await readCursor(this.engine, this.account.id, stream);
    const s: SyncStreamResult = { stream, cursor_before: before, cursor_after: before, pages: 0, clean: false };
    this.result.streams.push(s);
    let cursor = before;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES_PER_STREAM) {
        this.stop("page_limit");
        return;
      }
      if (!(await this.heartbeat())) {
        this.stop("lock_lost");
        this.fetchStopped = true;
        return;
      }
      const res = await this.deps.adapter.page({ client, account: this.account, stream, cursor, page });
      if (!res.ok) {
        this.fetchFailed(res.response);
        return;
      }
      s.pages++;
      const settled = await this.processPage(res.items);
      this.result.counts.deletions_seen += await markDeletesPending(this.engine, this.account.id, res.deletions ?? [], this.date());
      if (!settled) return;
      if (res.checkpoint !== null && res.checkpoint !== cursor) {
        await writeCursor(this.engine, this.account.id, stream, res.checkpoint, this.date());
        cursor = res.checkpoint;
        s.cursor_after = cursor;
      }
      if (res.done) {
        s.clean = true;
        return;
      }
    }
  }

  private fetchFailed(res: ConnectorResponse): void {
    this.result.error_class = res.class;
    this.result.http_status = res.status === 0 ? null : res.status;
    this.result.error = res.error;
    if (res.class === "auth_required" && res.reauth === true) {
      this.stop("needs_reconnect");
      this.fetchStopped = true;
    } else if (res.class === "auth_required" || res.class === "forbidden") {
      this.stop("forbidden");
      this.fetchStopped = true;
    } else {
      this.stop("fetch_failed");
      // A rate limit is the provider's for the whole account; other failures may be one stream's.
      if (res.class === "rate_limited") this.fetchStopped = true;
    }
  }

  private date(): Date {
    return new Date(this.now());
  }

  /** Process one page. True when every item on it is settled, so its checkpoint may be committed. */
  private async processPage(items: readonly SyncItem[]): Promise<boolean> {
    const failures: PageFailure[] = [];
    const maxPerRun = positiveInt(this.env, "MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN", DEFAULT_MAX_ITEMS_PER_RUN);
    for (const item of items) {
      if (this.itemsThisRun >= maxPerRun || this.seenToday + this.itemsThisRun >= this.account.itemCapDaily) {
        this.stop("item_cap_reached");
        this.fetchStopped = true;
        return false;
      }
      if (await this.spentUsd() >= this.account.spendCapUsdDaily) {
        this.stop("cap_reached");
        this.fetchStopped = true;
        return false;
      }
      // A page can take longer than the lock lives; a run that lost it stops
      // before writing anything else another run may now be writing too.
      if (!(await this.heartbeat())) {
        this.stop("lock_lost");
        this.fetchStopped = true;
        return false;
      }
      this.itemsThisRun++;
      this.result.counts.items++;
      const failure = await this.processItem(item);
      if (failure !== null) failures.push(failure);
    }
    if (failures.length === 0) return true;

    const outageCode = sourceOutage(failures, items.length);
    if (outageCode !== null) {
      this.stop("source_outage");
      this.result.error ??= `${failures.length} of ${items.length} items failed with ${outageCode}; treated as a source failure`;
      return false;
    }
    let blocking = 0;
    for (const f of failures) {
      this.result.counts.items_failed++;
      const outcome = await recordItemFailure(this.engine, {
        accountId: this.account.id, externalId: f.externalId, version: f.version,
        code: f.code, message: f.message, now: this.date(), holdNow: f.deterministic,
      });
      if (outcome.held) this.result.counts.items_held++;
      else blocking++;
    }
    if (blocking > 0) this.stop("items_failed");
    return blocking === 0;
  }

  /** Settle one item; the failure to count when it could not be settled. */
  private async processItem(item: SyncItem): Promise<PageFailure | null> {
    const row = await getItem(this.engine, this.account.id, item.externalId);
    const sameVersion = row !== null && row.external_version === item.version;
    if (row !== null && sameVersion && row.held_reason !== null && !DELETION_STATES.includes(row.held_reason)
      && row.held_until !== null && row.held_until.getTime() > this.now()) {
      this.result.counts.items_skipped_held++;
      return null;
    }
    if (item.failure !== undefined) {
      return { externalId: item.externalId, version: item.version, code: item.failure.code, message: item.failure.message, deterministic: false };
    }
    const settle = (pageSlug: string, contentHash: string | null) => recordItemSettled(this.engine, {
      accountId: this.account.id, externalId: item.externalId, version: item.version, pageSlug,
      contentHash, dedupeKey: item.dedupeKey ?? null, now: this.date(),
    });
    const settled = row !== null && row.fail_count === 0 && row.held_reason === null
      && row.deleted_upstream_at === null && row.page_slug === item.slug;
    // Without a version there is nothing to compare: the write below decides
    // by content hash.
    if (settled && sameVersion && item.version !== null) {
      await touchItem(this.engine, this.account.id, item.externalId, this.date());
      this.result.counts.pages_unchanged++;
      return null;
    }
    if (item.dedupeKey) {
      const existing = await pageForDedupeKey(this.engine, this.account.id, item.dedupeKey, item.externalId);
      if (existing !== null) {
        await settle(existing, null);
        this.result.counts.duplicates++;
        return null;
      }
    }
    let hash: string | null;
    try {
      hash = await this.write(item, settled ? row.content_hash : null);
    } catch (e) {
      if (!(e instanceof OperationError)) throw e;
      return { externalId: item.externalId, version: item.version, code: e.code, message: e.message, deterministic: isDeterministicRefusal(e) };
    }
    // A page that is not searchable is not settled: the cursor stays before
    // it, and the next run, finding the page unchanged, mirrors it again.
    if (hash === null) {
      return { externalId: item.externalId, version: item.version, code: "mirror_failed", message: "the page was written but its mirror into search failed", deterministic: false };
    }
    await settle(item.slug, hash);
    return null;
  }

  /**
   * Write the page and mirror it into search. Returns the stored content hash,
   * or null when the mirror failed. An unchanged page is mirrored again unless
   * `settledHash` (the hash this item last settled with) says it already was:
   * that covers a page whose earlier mirror failed.
   */
  private async write(item: RenderedSyncItem, settledHash: string | null): Promise<string | null> {
    // A live connector token must never reach a page, whatever the scan disposition.
    const findings: SecretFinding[] = [];
    const body = this.tokens.size > 0 ? sweepEchoes(item.body, this.tokens, findings) : item.body;
    const title = this.tokens.size > 0 ? sweepEchoes(item.title, this.tokens, findings) : item.title;
    const put = await putPage(this.storage, {
      slug: item.slug,
      type: item.type,
      allowAdHocType: true,
      title,
      markdown_body: body,
      written_by: `${WRITTEN_BY_PREFIX}${this.account.provider}`,
      source_id: this.account.sourceId,
      outsideText: true,
    });
    if (put.held) throw new OperationError("conflict", `Import held: ${put.held}`);
    const stored = put.outside_body ?? body;
    if (!put.changed && !put.created) {
      this.result.counts.pages_unchanged++;
      if (put.content_hash === settledHash) return put.content_hash;
    } else {
      this.result.counts.pages_written++;
      this.changed.push({ slug: item.slug, body: stored });
    }
    const ok = await mirrorPage(
      this.storage,
      { slug: item.slug, title, markdown_body: stored, content_hash: put.content_hash, source_id: this.account.sourceId },
      { remote: true, timingLabel: `connector_${this.account.provider}`, ...(this.deps.embedFn ? { embedFn: this.deps.embedFn } : {}) },
    );
    if (ok) return put.content_hash;
    this.result.counts.mirror_failures++;
    return null;
  }

  /** Apply or hold the deletions this and earlier runs recorded. */
  private async settleDeletions(): Promise<void> {
    const engine = this.engine;
    const pending = await itemsInDeletionState(engine, this.account.id, DELETE_PENDING);
    if (pending.length > 0 && isMassDelete(pending.length, await itemsPresent(engine, this.account.id), this.env)) {
      this.result.counts.deletions_held += await holdPendingDeletes(engine, this.account.id);
      await openNotice(
        engine,
        this.account.id,
        "mass_delete_held",
        `${pending.length} item(s) deleted upstream are held for confirmation; nothing was deleted`,
        this.date(),
      );
      await this.apply(await itemsInDeletionState(engine, this.account.id, DELETE_CONFIRMED));
      return;
    }
    await this.apply([...pending, ...await itemsInDeletionState(engine, this.account.id, DELETE_CONFIRMED)]);
  }

  private async apply(rows: ReadonlyArray<{ external_id: string; page_slug: string | null }>): Promise<void> {
    const handler = this.deps.onUpstreamDelete;
    // Without a handler nothing can be deleted: the rows stay pending, so the
    // deletion still runs once one is wired, although the cursor has moved on.
    if (handler === undefined) return;
    let failed = 0;
    for (const row of rows) {
      // A page a live duplicate still points at stays; only this item's claim on it ends.
      const shared = row.page_slug !== null
        && await pageSharedByLiveItem(this.engine, this.account.id, row.page_slug, row.external_id);
      if (!shared) {
        try {
          await handler(this.storage, {
            accountId: this.account.id, sourceId: this.account.sourceId, externalId: row.external_id, pageSlug: row.page_slug,
          });
        } catch (e) {
          if (!(e instanceof OperationError)) throw e;
          failed++;
          continue;
        }
        this.result.counts.deletions_applied++;
      }
      await recordDeleteApplied(this.engine, this.account.id, row.external_id);
    }
    if (failed > 0) this.stop("deletions_failed");
  }

  private async updateHeldNotice(): Promise<void> {
    const held = await heldItemCount(this.engine, this.account.id);
    if (held > 0) {
      await openNotice(this.engine, this.account.id, "items_held", `${held} item(s) held after repeated failures`, this.date());
    } else {
      await resolveNotice(this.engine, this.account.id, "items_held", this.date());
    }
  }

  private finishStatus(): void {
    const r = this.result;
    if (r.stop_reason === "needs_reconnect") return;
    if (r.stop_reason === "forbidden") {
      r.status = "forbidden";
      return;
    }
    if (r.stop_reason !== null) {
      r.status = "partial";
      return;
    }
    const c = r.counts;
    r.status = c.items === 0 && c.deletions_seen === 0 ? "nothing_new" : "success";
  }

  private async logRun(): Promise<void> {
    if (this.changed.length === 0) return;
    const c = this.result.counts;
    await logIngest(this.engine, {
      source_type: `connector-${this.account.provider}`,
      source_ref: this.account.id,
      pages_updated: this.changed.slice(0, LOG_SLUG_CAP).map((p) => p.slug),
      summary:
        `status ${this.result.status}, items ${c.items}, written ${c.pages_written}, unchanged ${c.pages_unchanged}, ` +
        `failed ${c.items_failed}, held ${c.items_held}, deletions applied ${c.deletions_applied}, held ${c.deletions_held}`,
      source_id: this.account.sourceId,
    });
  }
}
