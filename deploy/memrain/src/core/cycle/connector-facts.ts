/**
 * connector-facts — opt-in, paid cycle phase that extracts facts from the mail,
 * chat and meeting pages of the connector accounts that enabled it.
 *
 * Every other paid fact phase leaves connector pages alone. An account opts in
 * per account (`connector_accounts.facts_extraction`, migration 196) with its
 * own daily dollar cap (`facts_cap_usd_daily`, at most $20): `memrain
 * connectors facts <account> --enable --cap <usd> --apply`. Calendar pages are
 * never read.
 *
 * Spend: each account's calls are booked to their own spend client
 * (`connector-facts:<account>`) at the account's cap, inside the
 * `connector-facts` wallet path, so a spent facts cap never stops the
 * account's sync (`connector:<account>`), and the brain-wide daily cap still
 * binds. Every call holds its worst case before it is sent, so two runs at
 * once stay inside the cap. Haiku by default (MEMRAIN_CONNECTOR_FACTS_MODEL).
 *
 * Per account and run: at most CONNECTOR_FACTS_PAGE_LIMIT pages, newest first,
 * mapped to the account through connector_items. A page two accounts map is
 * read once, by the lowest-id account that has the phase enabled. A page is
 * skipped when its search mirror is quarantined, when it was read at this
 * body and extractor version (`facts_backfill_scans`), while it is parked
 * after a failure (`synth_failures`, phase connector-facts), and when its
 * frontmatter says `facts_extraction: false`.
 *
 * Writes: facts carry `written_by = connector-facts:<account>` and the page as
 * `source_slug`, private by default, HIGH notability only. The write gate
 * fails closed here: a row tier that reads as anything but external, or a gate
 * that cannot assess a fact, parks the page with no fact of its batch stored.
 *
 * FALLS-OPEN per page: a failure is collected in `errors[]` and the phase
 * never throws (the cycle marks it `warn`).
 */
import type { Engine } from "../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { brainDailyCapUsd, daySpendUsd, paidPathWallet, runInWallet, runWithSpendClient } from "../budget.ts";
import { FACTS_EXTRACT_VERSION, factsExtractionEnabled, factsExtractionOptedOut } from "../facts-extract.ts";
import { DEFAULT_HAIKU_MODEL } from "../llm/haiku.ts";
import type { SonnetFn } from "../llm/sonnet.ts";
import { PAGE_MIRROR_PATH_SQL, notSynthesizedPageSql, pageSourcePath } from "../page-index.ts";
import { quarantineFilterFragment } from "../quarantine.ts";
import { recordSynthFailure, recordSynthSkip } from "../synthesis/synth-failures.ts";
import { effectiveRowTier, resolveRowGateMode, RowGateError } from "../write-gate-rows.ts";
import { acquireWorkerLock, releaseWorkerLock } from "../jobs/worker-lock.ts";
import { extractAndRecordPage, type FactsPageRow } from "./conversation-facts-backfill.ts";
import { phaseFenceCheck } from "./phase-context.ts";

/** Pages one account may have read per run; the rest wait for the next run. */
export const CONNECTOR_FACTS_PAGE_LIMIT = 50;

/** The page kinds the phase reads. Calendar entries carry no narrated claims. */
export const CONNECTOR_FACTS_TYPES: readonly string[] = ["connector-mail", "connector-chat", "connector-meeting"];

/** Backoff phase, wallet path and lock prefix. */
export const CONNECTOR_FACTS_PHASE = "connector-facts";

/** Highest daily cap an account may set (the migration 196 CHECK). */
export const CONNECTOR_FACTS_MAX_CAP_USD = 20;

const LOCK_TTL_SEC = 900;

/** The writer stamped on an account's facts; `--forget` selects by it. */
export function connectorFactsWriter(accountId: string): string {
  return `connector-facts:${accountId}`;
}

/** The spend client an account's extraction calls are booked to. */
export function connectorFactsSpendClient(accountId: string): string {
  return `connector-facts:${accountId}`;
}

/** MEMRAIN_CONNECTOR_FACTS_MODEL, else Haiku. */
export function connectorFactsModel(env: NodeJS.ProcessEnv = process.env): string {
  return env["MEMRAIN_CONNECTOR_FACTS_MODEL"]?.trim() || DEFAULT_HAIKU_MODEL;
}

export interface ConnectorFactsAccount {
  id: string;
  source_id: string;
  cap_usd: number;
}

/** Accounts with the phase enabled and a cap above zero, by id. */
export async function enabledConnectorFactsAccounts(engine: Engine): Promise<ConnectorFactsAccount[]> {
  // scope: operator-only the cycle lists every opted-in account; each is then read in its own source
  const r = await engine.query<{ id: string; source_id: string; cap_usd: string | number }>(
    `SELECT id::text AS id, source_id, facts_cap_usd_daily AS cap_usd
       FROM connector_accounts
      WHERE facts_extraction AND facts_cap_usd_daily > 0
      ORDER BY id`,
  );
  return r.rows.map((row) => ({ id: row.id, source_id: row.source_id, cap_usd: Number(row.cap_usd) }));
}

/**
 * Why the phase must not spend now, or null: the row write gate must
 * quarantine outside rows (MEMRAIN_WRITE_GATE_ROWS=quarantine, not lowered by
 * MEMRAIN_WRITE_GATE_EXTERNAL) and the brain must have a daily budget.
 */
export function connectorFactsSetupRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env["MEMRAIN_WRITE_GATE_ROWS"]?.trim().toLowerCase() !== "quarantine"
    || resolveRowGateMode("external", "", env) !== "quarantine") {
    return "the row write gate does not quarantine outside rows: set MEMRAIN_WRITE_GATE_ROWS=quarantine (and leave MEMRAIN_WRITE_GATE_EXTERNAL unset or quarantine) first";
  }
  if (brainDailyCapUsd(env) === null) return "the brain has no daily budget: set MEMRAIN_DAILY_BUDGET_USD first";
  return null;
}

/**
 * Whether the daemon schedules the phase: extraction is on and at least one
 * account enabled it. An unreadable table (a schema before 196) schedules
 * nothing.
 */
export async function connectorFactsScheduled(engine: Engine, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!factsExtractionEnabled(env["MEMRAIN_FACTS_EXTRACTION"])) return false;
  try {
    return (await enabledConnectorFactsAccounts(engine)).length > 0;
  } catch {
    return false;
  }
}

/**
 * The live pages `accountId` may have read, newest first: its own mapped
 * mail, chat and meeting pages in its source, long enough to carry a claim,
 * not quarantined, not read at this body, not parked, and not owned by a
 * lower-id account that has the phase enabled. `$1` account id, `$2` source,
 * `$3` types, `$4` extractor version, `$5` model, `$6` limit.
 */
export function eligibleConnectorPagesSql(): string {
  return `SELECT p.slug, p.type, p.markdown_body, p.source_id, p.content_hash
            FROM pages p
           WHERE p.source_id = $2
             AND p.deleted_at IS NULL
             AND p.type = ANY($3::text[])
             AND length(btrim(p.markdown_body)) >= 80
             AND ${notSynthesizedPageSql("p")}
             AND EXISTS (
               SELECT 1 FROM connector_items ci
                WHERE ci.account_id = $1::uuid AND ci.page_slug = p.slug
             )
             AND NOT EXISTS (
               SELECT 1 FROM connector_items lo
                 JOIN connector_accounts la ON la.id = lo.account_id
                WHERE lo.page_slug = p.slug AND la.source_id = p.source_id
                  AND la.facts_extraction AND la.facts_cap_usd_daily > 0
                  AND la.id < $1::uuid
             )
             AND NOT EXISTS (
               SELECT 1 FROM documents qd
                WHERE qd.source_path = ${PAGE_MIRROR_PATH_SQL}
                  AND NOT (${quarantineFilterFragment("qd")})
             )
             AND NOT EXISTS (
               SELECT 1 FROM facts_backfill_scans s
                WHERE s.source_id = p.source_id AND s.slug = p.slug
                  AND s.content_hash = p.content_hash AND s.extractor_version = $4
             )
             AND NOT EXISTS (
               SELECT 1 FROM synth_failures f
                WHERE f.doc_id = ${PAGE_MIRROR_PATH_SQL} AND f.phase = '${CONNECTOR_FACTS_PHASE}'
                  AND f.content_hash = p.content_hash AND f.model = $5
                  AND f.next_eligible_at > now()
             )
           ORDER BY p.updated_at DESC, p.slug
           LIMIT $6`;
}

/** The pages the next run of `account` would read, at most `limit`. */
export async function eligibleConnectorPages(
  engine: Engine,
  account: { id: string; source_id: string },
  model: string,
  limit: number,
): Promise<FactsPageRow[]> {
  const r = await engine.query<FactsPageRow>(eligibleConnectorPagesSql(), [
    account.id, account.source_id, [...CONNECTOR_FACTS_TYPES], FACTS_EXTRACT_VERSION, model, limit,
  ]);
  return r.rows;
}

/**
 * The trust tier a connector fact on `sourceId` (drawn from `sourceSlug`, when
 * given) is written at. The phase writes only at `external`: an owner-tier
 * fact would pass the write gate unread.
 */
export async function connectorFactsTier(engine: Engine, sourceId: string, sourceSlug: string | null): Promise<string | null> {
  const at = await effectiveRowTier(engine, { newFact: { principal: null, sourceId, sourceSlug } });
  return at?.tier ?? null;
}

export interface ConnectorFactsOptions {
  /** Test seam — inject a fake model; bypasses the MEMRAIN_FACTS_EXTRACTION gate. */
  sonnetFn?: SonnetFn;
  modelId?: string;
  /** Pages per account per run. Default CONNECTOR_FACTS_PAGE_LIMIT. */
  maxPagesPerAccount?: number;
  now?: () => Date;
}

export interface ConnectorFactsAccountResult {
  accountId: string;
  pagesConsidered: number;
  pagesProcessed: number;
  factsWritten: number;
  zeroYieldRecorded: number;
  spentUsd: number;
  /** The account's facts cap for the UTC day was reached; its other pages wait. */
  capReached: boolean;
  /** Another run holds this account. */
  locked: boolean;
}

export interface ConnectorFactsResult {
  ran: boolean;
  reason?: string;
  accounts: ConnectorFactsAccountResult[];
  pagesProcessed: number;
  factsWritten: number;
  spentUsd: number;
  errors: { slug: string; message: string }[];
}

export async function connectorFactsPhase(storage: Storage, opts: ConnectorFactsOptions = {}): Promise<ConnectorFactsResult> {
  const result: ConnectorFactsResult = { ran: false, accounts: [], pagesProcessed: 0, factsWritten: 0, spentUsd: 0, errors: [] };
  if (!opts.sonnetFn && !factsExtractionEnabled()) {
    return { ...result, reason: "extraction disabled: set MEMRAIN_FACTS_EXTRACTION=1" };
  }
  const engine = storage.engine();
  const accounts = await enabledConnectorFactsAccounts(engine);
  if (accounts.length === 0) return { ...result, reason: "no connector account has facts extraction enabled" };
  // Checked on every run, not only at enable: a gate lowered since then
  // stops the phase rather than letting outside text through unheld.
  const refusal = connectorFactsSetupRefusal();
  if (refusal !== null) return { ...result, reason: refusal, errors: [{ slug: CONNECTOR_FACTS_PHASE, message: refusal }] };
  result.ran = true;
  const model = opts.modelId ?? connectorFactsModel();
  for (const account of accounts) {
    const r = await runAccount(storage, account, model, opts, result.errors);
    result.accounts.push(r);
    result.pagesProcessed += r.pagesProcessed;
    result.factsWritten += r.factsWritten;
    result.spentUsd += r.spentUsd;
  }
  result.spentUsd = Number(result.spentUsd.toFixed(6));
  return result;
}

async function runAccount(
  storage: Storage,
  account: ConnectorFactsAccount,
  model: string,
  opts: ConnectorFactsOptions,
  errors: ConnectorFactsResult["errors"],
): Promise<ConnectorFactsAccountResult> {
  const engine = storage.engine();
  const now = opts.now ?? (() => new Date());
  const out: ConnectorFactsAccountResult = {
    accountId: account.id, pagesConsidered: 0, pagesProcessed: 0, factsWritten: 0, zeroYieldRecorded: 0,
    spentUsd: 0, capReached: false, locked: false,
  };
  const client = connectorFactsSpendClient(account.id);
  const lockId = `${CONNECTOR_FACTS_PHASE}:${account.id}`;
  const holder = `pid-${process.pid}:${crypto.randomUUID()}`;
  if (!(await acquireWorkerLock(engine, lockId, holder, LOCK_TTL_SEC))) {
    out.locked = true;
    return out;
  }
  try {
    const pages = await eligibleConnectorPages(engine, account, model, opts.maxPagesPerAccount ?? CONNECTOR_FACTS_PAGE_LIMIT);
    for (const page of pages) {
      await phaseFenceCheck();
      const spent = await daySpendUsd(engine, client, now());
      if (spent >= account.cap_usd) {
        out.capReached = true;
        break;
      }
      out.pagesConsidered += 1;
      const docId = pageSourcePath(page.slug, page.source_id);
      // An opted-out page is parked on this body without any call.
      if (factsExtractionOptedOut(page.markdown_body)) {
        await recordSynthSkip(engine, { docId, phase: CONNECTOR_FACTS_PHASE, contentHash: page.content_hash, model });
        continue;
      }
      try {
        // Fails closed: facts drawn from outside text are written at the
        // external tier, never at one the gate trusts more (the owner's it
        // does not check at all).
        const tier = await connectorFactsTier(engine, page.source_id, page.slug);
        if (tier !== "external") {
          throw new RowGateError(`facts from ${page.slug} would be written at the ${tier ?? "unknown"} tier, not external`);
        }
        const r = await runWithSpendClient({ clientId: client, capUsd: account.cap_usd }, () =>
          runInWallet(paidPathWallet(CONNECTOR_FACTS_PHASE), () => extractAndRecordPage(storage, page, {
            phase: CONNECTOR_FACTS_PHASE,
            model,
            modelId: model,
            ...(opts.sonnetFn ? { sonnetFn: opts.sonnetFn } : {}),
            maxBudgetUsd: Math.max(account.cap_usd - spent, 0.000001),
            writtenBy: connectorFactsWriter(account.id),
            gateOnError: "throw",
            notabilityFilter: "high-only",
          })));
        out.spentUsd += r.result.spentUsd;
        out.factsWritten += r.result.factsWritten;
        out.pagesProcessed += 1;
        if (r.recorded === "zero_yield") out.zeroYieldRecorded += 1;
        for (const message of r.errors) errors.push({ slug: page.slug, message });
        // The cap refused the call: the page waits for the next UTC day.
        if (r.result.absorbed === "budget_exhausted") {
          out.capReached = true;
          break;
        }
        // The phase runs every tick: a page left open by a failed call or a
        // failed write is parked, so it is not paid for again until the backoff
        // ends (an unreadable answer the routine parked already).
        const absorbed = r.result.absorbed;
        if (r.result.factsFailed > 0 || (absorbed !== null && absorbed !== "parse_failure" && absorbed !== "output_truncated")) {
          await recordSynthFailure(engine, { docId, phase: CONNECTOR_FACTS_PHASE, contentHash: page.content_hash, model, kind: "llm_error" });
          if (absorbed !== null && absorbed !== "parse_failure" && absorbed !== "output_truncated") {
            errors.push({ slug: page.slug, message: `extraction absorbed: ${absorbed}` });
          }
        }
      } catch (e) {
        // A gate that cannot assess the batch stores none of it: the page is
        // parked and asked again after the backoff.
        await recordSynthFailure(engine, { docId, phase: CONNECTOR_FACTS_PHASE, contentHash: page.content_hash, model, kind: "llm_error" });
        errors.push({ slug: page.slug, message: e instanceof RowGateError ? `write gate: ${e.message}` : e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    await releaseWorkerLock(engine, lockId, holder);
  }
  out.spentUsd = Number(out.spentUsd.toFixed(6));
  return out;
}
