/**
 * `memrain connectors gmail-widen <account-id> --days N [--apply --plan-hash H] [--json]`
 *
 * Widen a Gmail account's history window (`config.gmail_history_days`, which
 * nothing else writes: the shared `history_days` never starts a backfill). The next
 * sync then backfills the mail between the new window floor and what the
 * account's listings have covered (google/gmail.ts). Without `--apply` this
 * is a dry run: it lists the message ids in that gap (ids only, no message is
 * read), groups them into threads, and reports
 *
 *   threads_in_range         threads with mail in the gap
 *   already_stored_spanning  of those, threads already stored: rendered again
 *                            with their older messages, never duplicated
 *   would_add                threads the backfill would add (at most: a thread
 *                            left with only Promotions or Social mail is not)
 *   would_move_in_backfill   stored threads the backfill re-renders under an
 *                            older month: the page moves to that month's slug
 *                            and the old one is soft-deleted (a thread whose
 *                            older mail is only in Promotions or Social is not
 *                            listed, so the backfill leaves it; a later reply
 *                            can still move it)
 *   quota_units, est_embed_usd  what the backfill costs in Gmail quota and
 *                            embeddings (under the account's own caps)
 *
 * and a plan hash. `--apply --plan-hash H` lists the gap again, refuses when
 * the hash no longer matches, the listing is incomplete, or the cursor keeps
 * no floor to widen from, and only then sets `gmail_history_days`. Run it in
 * the container: it reads the account's token.
 *
 * Exit codes: 0 dry run or applied; 1 refused (stale hash, incomplete listing,
 * no floor, Gmail error, not a Gmail account); 2 usage.
 */
import { createHash } from "node:crypto";
import { loadConfig } from "../core/config.ts";
import { costUsd } from "../core/budget.ts";
import { DEFAULT_MODEL_ID } from "../core/embedding.ts";
import type { Engine } from "../core/engine/interface.ts";
import { Storage } from "../core/storage.ts";
import type { ConnectorClient, FetchFn } from "../core/connectors/client.ts";
import { getAccount, setAccountConfig, type ConnectorAccount } from "../core/connectors/accounts.ts";
import { builtinProviders, type ProviderRegistry } from "../core/connectors/providers.ts";
import { connectorRuntime, toSyncAccount } from "../core/connectors/runtime.ts";
import { readCursor } from "../core/connectors/sync-store.ts";
import { loadKek, type Kek } from "../core/connectors/vault.ts";
import {
  GMAIL_HISTORY_DAYS,
  GMAIL_LIST_EXCLUSIONS,
  GMAIL_STREAM,
  GOOGLE_GMAIL_SERVICE,
  gmailHistoryDays,
  gmailWindowLow,
  MAX_MAIL_HISTORY_DAYS,
  parseGmailCursor,
} from "../core/connectors/google/gmail.ts";
import { withStorage } from "./with-storage.ts";

const DAY_MS = 86_400_000;
/** Listing pages read at most; past this the preview is incomplete and cannot be applied. */
export const MAX_LIST_PAGES = 200;
const LIST_PAGE_SIZE = 500;
/** Gmail quota units: a `messages.list` page, and a full thread read as the adapter paces for it (gmail.ts). */
const LIST_UNITS = 5;
const THREAD_READ_UNITS = 120;
/** A pessimistic thread page size for embedding, in tokens (see the backfill cost test). */
const EMBED_TOKENS_PER_THREAD = 3_000;
const MONTH_SLUG = /\/(\d{4}-\d{2})\//;

export interface GmailWidenPreview {
  account_id: string;
  days: number;
  current_days: number;
  /**
   * `none` before the first sync (it reads the whole window), `no_floor` for
   * a cursor written before the floor was kept (nothing can widen from it),
   * `ok` otherwise.
   */
  cursor_state: "none" | "no_floor" | "ok";
  /** The oldest mail the account's listings have covered, or null when the cursor keeps none. */
  covered_low: string | null;
  new_low: string;
  threads_in_range: number;
  already_stored_spanning: number;
  would_add: number;
  would_move_in_backfill: number;
  list_pages: number;
  quota_units: number;
  est_embed_usd: number;
  truncated: boolean;
  plan_hash: string;
}

/** UTC month starts splitting [low, high) so each thread's oldest month in the gap is known. */
function monthChunks(low: number, high: number): Array<{ from: number; to: number; month: string }> {
  const out: Array<{ from: number; to: number; month: string }> = [];
  let from = low;
  while (from < high) {
    const d = new Date(from);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const to = Math.min(next, high);
    out.push({ from, to, month: d.toISOString().slice(0, 7) });
    from = to;
  }
  return out;
}

/** The thread ids with mail in [low, high), each with the oldest UTC month it has mail in; or why the listing stopped. */
async function listGap(client: ConnectorClient, low: number, high: number): Promise<{ threads: Map<string, string>; pages: number; truncated: boolean }> {
  const threads = new Map<string, string>();
  let pages = 0;
  // Oldest month first, so the first month a thread is seen in is its oldest.
  for (const chunk of monthChunks(low, high)) {
    let token: string | null = null;
    do {
      if (pages >= MAX_LIST_PAGES) return { threads, pages, truncated: true };
      const q = new URLSearchParams({
        maxResults: String(LIST_PAGE_SIZE),
        q: `after:${Math.floor(chunk.from / 1000)} before:${Math.ceil(chunk.to / 1000)} ${GMAIL_LIST_EXCLUSIONS}`,
      });
      if (token !== null) q.set("pageToken", token);
      const res = await client.get(`/gmail/v1/users/me/messages?${q.toString()}`);
      pages++;
      if (res.class !== "ok") throw new Error(`Gmail refused the listing (${res.error ?? res.class})`);
      const body = res.body as { messages?: unknown; nextPageToken?: unknown } | null;
      if (body === null || typeof body !== "object" || (body.messages !== undefined && !Array.isArray(body.messages))) {
        throw new Error("Gmail answered the listing with an unexpected response");
      }
      for (const m of (body.messages ?? []) as unknown[]) {
        const tid = m !== null && typeof m === "object" ? (m as { threadId?: unknown }).threadId : undefined;
        if (typeof tid === "string" && tid !== "" && !threads.has(tid)) threads.set(tid, chunk.month);
      }
      token = typeof body.nextPageToken === "string" && body.nextPageToken !== "" ? body.nextPageToken : null;
    } while (token !== null);
  }
  return { threads, pages, truncated: false };
}

/**
 * What widening `account` to `days` would backfill, read live from Gmail and
 * the stored items. Writes nothing to the brain; the token source may renew a
 * stale access token in the vault, as any sync does.
 */
export async function previewGmailWiden(
  engine: Engine,
  client: ConnectorClient,
  account: ConnectorAccount,
  days: number,
  opts: { env: NodeJS.ProcessEnv; now: number },
): Promise<GmailWidenPreview> {
  const cursor = parseGmailCursor(await readCursor(engine, account.id, GMAIL_STREAM));
  const covered = cursor === null ? null : cursor.coveredLowMs ?? cursor.floorMs;
  const newLow = gmailWindowLow(account.config, opts.env, opts.now, days);
  // The adapter opens a backfill only when the window reaches more than a day below what is covered.
  const gap = covered !== null && newLow < covered - DAY_MS;
  const listed = gap ? await listGap(client, newLow, covered) : { threads: new Map<string, string>(), pages: 0, truncated: false };

  const ids = [...listed.threads.keys()];
  const stored = ids.length === 0
    ? []
    // scope: operator-only an operator CLI over one account's own items
    : (await engine.query<{ external_id: string; page_slug: string | null }>(
      `SELECT external_id, page_slug FROM connector_items WHERE account_id = $1 AND external_id = ANY($2::text[])`,
      [account.id, ids],
    )).rows;
  const moves = stored.filter(r => {
    const month = r.page_slug === null ? null : MONTH_SLUG.exec(r.page_slug)?.[1];
    return month !== null && month !== undefined && month !== listed.threads.get(r.external_id);
  }).length;
  const wouldAdd = ids.length - stored.length;
  // Everything the counts come from, not only the counts: a gap that changed under the same counts is stale.
  const byId = (a: [string, string | null], b: [string, string | null]) => a[0].localeCompare(b[0]);
  const planHash = createHash("sha256")
    .update(JSON.stringify({
      v: 1, account: account.id, days, covered_low_ms: covered, would_add: wouldAdd,
      threads: [...listed.threads.entries()].sort(byId),
      stored: stored.map((r): [string, string | null] => [r.external_id, r.page_slug]).sort(byId),
    }))
    .digest("hex");
  return {
    account_id: account.id,
    days,
    current_days: gmailHistoryDays(account.config),
    cursor_state: cursor === null ? "none" : covered === null ? "no_floor" : "ok",
    covered_low: covered === null ? null : new Date(covered).toISOString(),
    new_low: new Date(newLow).toISOString(),
    threads_in_range: ids.length,
    already_stored_spanning: stored.length,
    would_add: wouldAdd,
    would_move_in_backfill: moves,
    list_pages: listed.pages,
    quota_units: listed.pages * LIST_UNITS + ids.length * THREAD_READ_UNITS,
    est_embed_usd: Number(costUsd(DEFAULT_MODEL_ID, { inputTokens: ids.length * EMBED_TOKENS_PER_THREAD, outputTokens: 0 }).toFixed(6)),
    truncated: listed.truncated,
    plan_hash: planHash,
  };
}

export interface GmailWidenOptions {
  accountId: string | undefined;
  days: string | undefined;
  apply?: boolean;
  planHash?: string;
  json?: boolean;
  configPath?: string;
  /** Test seams: a Storage the caller opened and closes, recorded responses, a fixed clock, the key and providers. */
  storage?: Storage;
  fetch?: FetchFn;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  kek?: Kek;
  providers?: ProviderRegistry;
  sleep?: (ms: number) => Promise<void>;
}

function printPreview(p: GmailWidenPreview, applied: boolean): void {
  console.log(`gmail-widen ${p.account_id} (${applied ? "applied" : "dry run"}): gmail_history_days ${p.current_days} -> ${p.days}`);
  if (p.cursor_state === "no_floor") console.log("  the account's cursor keeps no window floor, so nothing can be widened from it; --apply refuses");
  console.log(`  window floor ${p.new_low}; listings cover mail from ${p.covered_low ?? "nothing yet (the first sync reads the whole window)"}`);
  console.log(`  threads in the gap: ${p.threads_in_range} (${p.already_stored_spanning} already stored, rendered again with older messages; ${p.would_add} to add at most)`);
  console.log(`  stored threads the backfill would move to an older month's page: ${p.would_move_in_backfill}`);
  console.log(`  cost: ${p.list_pages} listing page(s) read; about ${p.quota_units} Gmail quota units and $${p.est_embed_usd} of embeddings for the backfill`);
  if (p.truncated) console.log(`  the listing stopped at ${MAX_LIST_PAGES} pages: the counts are incomplete and --apply refuses`);
  console.log(`  plan hash: ${p.plan_hash}`);
  if (!applied && !p.truncated) console.log(`  apply with: memrain connectors gmail-widen ${p.account_id} --days ${p.days} --apply --plan-hash ${p.plan_hash}`);
}

function refuse(msg: string, json: boolean | undefined, code: number, preview?: GmailWidenPreview): number {
  if (json) console.log(JSON.stringify({ ok: false, error: msg, ...(preview ? { preview } : {}) }, null, 2));
  else console.error(`memrain connectors gmail-widen: ${msg}`);
  return code;
}

export async function runGmailWiden(opts: GmailWidenOptions): Promise<number> {
  const days = Number(opts.days);
  if (opts.accountId === undefined || opts.days === undefined || !Number.isInteger(days) || days < 1 || days > MAX_MAIL_HISTORY_DAYS) {
    return refuse(`usage: connectors gmail-widen <account-id> --days N (1..${MAX_MAIL_HISTORY_DAYS}) [--apply --plan-hash H] [--json]`, opts.json, 2);
  }
  if (opts.apply && !opts.planHash) return refuse("--apply needs the --plan-hash a dry run printed", opts.json, 2);
  if (!opts.apply && opts.planHash) return refuse("--plan-hash belongs to --apply", opts.json, 2);
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const kek = opts.kek ?? loadKek(env).kek;
  if (!kek) return refuse("no usable connector key (MEMRAIN_CONNECTOR_KEK or MEMRAIN_CONNECTOR_KEK_FILE)", opts.json, 1);
  const storage = opts.storage ?? new Storage(loadConfig(opts.configPath));
  const accountId = opts.accountId;
  return withStorage(storage, async () => {
    const engine = storage.engine();
    const account = await getAccount(engine, accountId);
    if (account === null) return refuse(`no connector account ${accountId}`, opts.json, 1);
    if (account.provider !== "google" || !account.services.includes(GOOGLE_GMAIL_SERVICE)) {
      return refuse(`account ${accountId} is not a Gmail account`, opts.json, 1);
    }
    const rt = connectorRuntime(storage, {
      kek, providers: opts.providers ?? builtinProviders(), env,
      ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.now ? { now: opts.now } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    const sync = toSyncAccount(account);
    const deps = rt.depsFor(sync);
    let preview: GmailWidenPreview;
    try {
      const client = deps.client(sync, await deps.tokenSource(sync, () => {}));
      preview = await previewGmailWiden(engine, client, account, days, { env, now: now() });
    } catch (e) {
      return refuse(e instanceof Error ? e.message : "the preview failed", opts.json, 1);
    }
    if (opts.apply) {
      if (preview.cursor_state === "no_floor") {
        return refuse("the account's cursor keeps no window floor, so no backfill can open from it; nothing was changed", opts.json, 1, preview);
      }
      if (preview.truncated) return refuse(`the listing is incomplete (over ${MAX_LIST_PAGES} pages); nothing was changed`, opts.json, 1, preview);
      if (preview.plan_hash !== opts.planHash) return refuse("stale plan hash: the gap changed since the dry run; preview again", opts.json, 1, preview);
      await setAccountConfig(engine, account.id, { [GMAIL_HISTORY_DAYS]: days });
    }
    if (opts.json) console.log(JSON.stringify({ ok: true, dry_run: !opts.apply, applied: opts.apply === true, ...preview }, null, 2));
    else printPreview(preview, opts.apply === true);
    return 0;
  }, { owned: opts.storage === undefined });
}
