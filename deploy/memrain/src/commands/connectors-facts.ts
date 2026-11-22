/**
 * `memrain connectors facts <account-id> [--dry-run] [--json]`
 * `memrain connectors facts <account-id> --enable --cap <usd> [--apply] [--json]`
 * `memrain connectors facts <account-id> --disable [--apply] [--json]`
 * `memrain connectors facts <account-id> --forget [--apply] [--export F] [--json]`
 *
 * The opt-in for paid fact extraction from one connector account's mail, chat
 * and meeting pages (cycle/connector-facts.ts). Every form is a preview until
 * `--apply`.
 *
 * The dry run prices what the account would read: eligible pages, their
 * characters, an input-token estimate (characters / 4 plus the extractor
 * prompt per page), a typical and a worst-case dollar figure, the model, how
 * many pages a day arrived over the last seven days, and the days a full pass
 * takes at the cap. It makes no model call and writes nothing.
 *
 * `--enable` refuses unless the row write gate quarantines outside rows
 * (MEMRAIN_WRITE_GATE_ROWS=quarantine, not lowered by
 * MEMRAIN_WRITE_GATE_EXTERNAL), the brain has a daily budget
 * (MEMRAIN_DAILY_BUDGET_USD), the model has a price, the account's source is
 * not a calendar, and a fact drawn from that source would be written at the
 * external tier (an owner-tier fact passes the gate unread). The phase runs
 * only with MEMRAIN_FACTS_EXTRACTION on; the output says when it is off.
 *
 * `--forget` forgets the facts this account's extraction wrote (`written_by =
 * connector-facts:<account>`) in its source, after exporting them to a 0600
 * JSON file. Only those rows: the same claim held by another writer stays, and
 * the claim is withdrawn (a later extraction does not write it again) only when
 * no other writer holds it.
 *
 * Exit codes: 0 done or previewed; 1 refused or a usage error.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../core/config.ts";
import { costUsd, priceFor } from "../core/budget.ts";
import { Storage } from "../core/storage.ts";
import { DEFAULT_EXTRACTION_MAX_TOKENS, EXTRACT_WINDOW_CHARS, FACTS_EXTRACT_VERSION, factsExtractionEnabled, factsMaxWindows } from "../core/facts-extract.ts";
import { forgetFact } from "../core/facts-recall.ts";
import {
  CONNECTOR_FACTS_MAX_CAP_USD,
  CONNECTOR_FACTS_TYPES,
  connectorFactsModel,
  connectorFactsSetupRefusal,
  connectorFactsTier,
  connectorFactsWriter,
  eligibleConnectorPagesSql,
} from "../core/cycle/connector-facts.ts";
import { withStorage } from "./with-storage.ts";

export interface ConnectorFactsCmdOptions {
  accountId?: string;
  enable?: boolean;
  disable?: boolean;
  forget?: boolean;
  /** `--cap`, as typed. */
  cap?: string;
  apply?: boolean;
  dryRun?: boolean;
  /** `--forget --apply`: where the export goes. */
  exportPath?: string;
  json?: boolean;
  configPath?: string;
  /** Test seam: a Storage the caller opened and closes. */
  storage?: Storage;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Typical answer size per call, in output tokens. */
const TYPICAL_OUTPUT_TOKENS = 500;
/** Characters per token for the estimate. */
const CHARS_PER_TOKEN = 4;
/** The extractor's system prompt (about 3.3K characters) and framing, in tokens, sent with every call. */
const PROMPT_TOKENS = 1000;

interface AccountRow {
  id: string;
  source_id: string;
  source_kind: string | null;
  facts_extraction: boolean;
  cap_usd: string | number;
}

export interface ConnectorFactsEstimate {
  account_id: string;
  enabled: boolean;
  cap_usd: number;
  eligible_pages: number;
  total_chars: number;
  est_input_tokens: number;
  est_usd_typical: number;
  est_usd_worst: number;
  model: string;
  pages_per_day_last7: number;
  days_to_drain_at_cap: number | null;
}

function fail(json: boolean | undefined, message: string): number {
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`memrain connectors facts: ${message}`);
  return 1;
}

const round = (n: number, places = 4): number => Number(n.toFixed(places));

async function readAccount(storage: Storage, id: string): Promise<AccountRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const r = await storage.engine().query<AccountRow>(
    `SELECT a.id::text AS id, a.source_id, s.kind AS source_kind, a.facts_extraction, a.facts_cap_usd_daily AS cap_usd
       FROM connector_accounts a LEFT JOIN sources s ON s.id = a.source_id
      WHERE a.id = $1::uuid`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** What a full pass over the account's eligible pages would cost; no call, no write. */
export async function estimateConnectorFacts(
  storage: Storage,
  account: { id: string; source_id: string; facts_extraction: boolean; cap_usd: number },
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<ConnectorFactsEstimate> {
  const model = connectorFactsModel(env);
  const maxWindows = factsMaxWindows(env["MEMRAIN_FACTS_MAX_WINDOWS"]);
  const readable = EXTRACT_WINDOW_CHARS * maxWindows;
  const engine = storage.engine();
  // A shared page counts for this account only when the phase would give it
  // to this account; an account that is off counts as if it were on. Each
  // window of a long page is its own call, with its own prompt; windows end
  // at paragraph breaks, so a long page may take every window it is allowed.
  const totals = await engine.query<{ pages: string | number; chars: string | number | null; windows: string | number | null; worst_windows: string | number | null }>(
    `SELECT count(*) AS pages, sum(least(length(e.markdown_body), ${readable})) AS chars,
            sum(least(${maxWindows}, greatest(1, ceil(length(e.markdown_body)::numeric / ${EXTRACT_WINDOW_CHARS})))) AS windows,
            sum(CASE WHEN length(e.markdown_body) <= ${EXTRACT_WINDOW_CHARS} THEN 1 ELSE ${maxWindows} END) AS worst_windows
       FROM (${eligibleConnectorPagesSql()}) e`,
    [account.id, account.source_id, [...CONNECTOR_FACTS_TYPES], FACTS_EXTRACT_VERSION, model, 1_000_000],
  );
  const recent = await engine.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM pages p
      WHERE p.source_id = $2 AND p.deleted_at IS NULL AND p.type = ANY($3::text[])
        AND p.updated_at >= $4::timestamptz - interval '7 days'
        AND EXISTS (SELECT 1 FROM connector_items ci WHERE ci.account_id = $1::uuid AND ci.page_slug = p.slug)`,
    [account.id, account.source_id, [...CONNECTOR_FACTS_TYPES], now.toISOString()],
  );
  const pages = Number(totals.rows[0]?.pages ?? 0);
  const chars = Number(totals.rows[0]?.chars ?? 0);
  const windows = Number(totals.rows[0]?.windows ?? 0);
  const worstWindows = Number(totals.rows[0]?.worst_windows ?? 0);
  const textTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const inputTokens = textTokens + windows * PROMPT_TOKENS;
  const priced = priceFor(model) !== null;
  const typical = priced ? costUsd(model, { inputTokens, outputTokens: windows * TYPICAL_OUTPUT_TOKENS }) : Number.NaN;
  // Worst, per window: the model declines it at the output cap, then reads
  // both halves and each answer is cut at the cap and retried once at twice
  // the cap. That is the text three times over with five prompts, and seven
  // caps out.
  const worst = priced
    ? costUsd(model, { inputTokens: textTokens * 3 + worstWindows * PROMPT_TOKENS * 5, outputTokens: worstWindows * DEFAULT_EXTRACTION_MAX_TOKENS * 7 })
    : Number.NaN;
  return {
    account_id: account.id,
    enabled: account.facts_extraction,
    cap_usd: account.cap_usd,
    eligible_pages: pages,
    total_chars: chars,
    est_input_tokens: inputTokens,
    est_usd_typical: round(typical),
    est_usd_worst: round(worst),
    model,
    pages_per_day_last7: round(Number(recent.rows[0]?.n ?? 0) / 7, 2),
    days_to_drain_at_cap: account.cap_usd > 0 && priced ? round(typical / account.cap_usd, 2) : null,
  };
}

/** Why `--enable` must refuse, or null when every precondition holds. */
export async function enableRefusal(
  storage: Storage,
  account: { source_id: string; source_kind: string | null },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const setup = connectorFactsSetupRefusal(env);
  if (setup !== null) return setup;
  const model = connectorFactsModel(env);
  if (priceFor(model) === null) return `model '${model}' has no price, so its spend cannot be capped`;
  if (account.source_kind === "calendar") return "calendar accounts carry no narrated claims; facts are read from mail, chat and meeting pages only";
  const tier = await connectorFactsTier(storage.engine(), account.source_id, null);
  if (tier !== "external") {
    return `facts from source '${account.source_id}' would be written at the ${tier ?? "unknown"} tier, not external; `
      + "connector facts are outside text and the write gate must check them as such (give the account a mailbox, chat or meeting source)";
  }
  return null;
}

function printEstimate(e: ConnectorFactsEstimate): void {
  console.log(`connector facts for ${e.account_id} (${e.enabled ? `enabled, cap $${e.cap_usd.toFixed(2)}/day` : "off"}):`);
  console.log(`  eligible pages      ${e.eligible_pages} (${e.total_chars} chars, ~${e.est_input_tokens} input tokens)`);
  console.log(`  full pass           ~$${e.est_usd_typical.toFixed(4)} typical, $${e.est_usd_worst.toFixed(4)} worst, on ${e.model}`);
  console.log(`  arriving            ${e.pages_per_day_last7} page(s)/day over the last 7 days`);
  if (e.days_to_drain_at_cap !== null) console.log(`  full pass at cap    ~${e.days_to_drain_at_cap} day(s)`);
}

export async function runConnectorFacts(opts: ConnectorFactsCmdOptions): Promise<number> {
  const modes = [opts.enable, opts.disable, opts.forget].filter(Boolean).length;
  if (!opts.accountId) return fail(opts.json, "an account id is required (memrain connectors status lists them)");
  if (modes > 1) return fail(opts.json, "choose one of --enable, --disable or --forget");
  if (opts.apply && opts.dryRun) return fail(opts.json, "choose --apply or --dry-run (a run without --apply is the dry run)");
  if (opts.apply && modes === 0) return fail(opts.json, "--apply needs --enable, --disable or --forget");
  if (opts.cap !== undefined && !opts.enable) return fail(opts.json, "--cap belongs to --enable");
  if (opts.exportPath !== undefined && !opts.forget) return fail(opts.json, "--export belongs to --forget");
  let cap: number | null = null;
  if (opts.enable) {
    cap = opts.cap !== undefined && /^\d+(?:\.\d{1,4})?$/.test(opts.cap.trim()) ? Number(opts.cap) : Number.NaN;
    if (!(cap > 0 && cap <= CONNECTOR_FACTS_MAX_CAP_USD)) {
      return fail(opts.json, `--enable needs --cap <usd> above 0 and at most ${CONNECTOR_FACTS_MAX_CAP_USD}`);
    }
  }
  const env = opts.env ?? process.env;
  const storage = opts.storage ?? new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const row = await readAccount(storage, opts.accountId!);
    if (row === null) return fail(opts.json, `no connector account '${opts.accountId}'`);
    const account = { ...row, cap_usd: Number(row.cap_usd) };
    if (opts.forget) return forgetAccountFacts(storage, account, opts);
    if (opts.disable) {
      if (opts.apply) {
        await storage.engine().query(`UPDATE connector_accounts SET facts_extraction = false, updated_at = now() WHERE id = $1::uuid`, [account.id]);
      }
      const out = { ok: true, account_id: account.id, applied: opts.apply === true, facts_extraction: opts.apply ? false : account.facts_extraction };
      if (opts.json) console.log(JSON.stringify(out));
      else console.log(opts.apply ? `connector facts for ${account.id}: off` : `connector facts for ${account.id}: would turn off (add --apply)`);
      return 0;
    }
    if (opts.enable) {
      const refusal = await enableRefusal(storage, account, env);
      if (refusal !== null) return fail(opts.json, refusal);
      const estimate = await estimateConnectorFacts(storage, { ...account, cap_usd: cap! }, env, opts.now?.());
      if (opts.apply) {
        await storage.engine().query(
          `UPDATE connector_accounts SET facts_extraction = true, facts_cap_usd_daily = $2, updated_at = now() WHERE id = $1::uuid`,
          [account.id, cap],
        );
      }
      if (opts.json) console.log(JSON.stringify({ ok: true, applied: opts.apply === true, ...estimate, enabled: opts.apply === true || account.facts_extraction }));
      else {
        printEstimate(estimate);
        console.log(opts.apply ? `enabled at $${cap!.toFixed(2)}/day` : `would enable at $${cap!.toFixed(2)}/day (add --apply)`);
        if (!factsExtractionEnabled(env["MEMRAIN_FACTS_EXTRACTION"])) console.log("note: the phase runs only with MEMRAIN_FACTS_EXTRACTION=1, which is off");
      }
      return 0;
    }
    const estimate = await estimateConnectorFacts(storage, account, env, opts.now?.());
    if (opts.json) console.log(JSON.stringify({ ok: true, ...estimate }));
    else printEstimate(estimate);
    return 0;
  }, { owned: opts.storage === undefined });
}

async function forgetAccountFacts(
  storage: Storage,
  account: { id: string; source_id: string },
  opts: ConnectorFactsCmdOptions,
): Promise<number> {
  const writer = connectorFactsWriter(account.id);
  const rows = (await storage.engine().query<{ id: string | number; entity_slug: string; fact: string; source_slug: string | null; visibility: string; written_at: string }>(
    `SELECT id, entity_slug, fact, source_slug, visibility, written_at::text AS written_at
       FROM entity_facts
      WHERE written_by = $1 AND source_id = $2 AND forgotten_at IS NULL
      ORDER BY id`,
    [writer, account.source_id],
  )).rows;
  if (!opts.apply) {
    if (opts.json) console.log(JSON.stringify({ ok: true, applied: false, account_id: account.id, facts: rows.length }));
    else console.log(`connector facts for ${account.id}: ${rows.length} fact(s) would be withdrawn (add --apply; they are exported first)`);
    return 0;
  }
  const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const path = resolve(opts.exportPath ?? `connector-facts-${account.id}-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify({ account_id: account.id, source_id: account.source_id, written_by: writer, facts: rows }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  let forgotten = 0;
  for (const row of rows) {
    const r = await forgetFact(storage, Number(row.id), { reason: `connector facts of account ${account.id} withdrawn`, onlyWriter: writer }, [account.source_id]);
    if (r.forgotten) forgotten += 1;
  }
  if (opts.json) console.log(JSON.stringify({ ok: true, applied: true, account_id: account.id, facts: rows.length, forgotten, export: path }));
  else console.log(`connector facts for ${account.id}: ${forgotten} of ${rows.length} fact(s) withdrawn; export at ${path}`);
  return 0;
}
