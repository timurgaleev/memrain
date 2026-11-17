/**
 * `memrain connectors github sync <owner/repo> --source ID [--token-file F]
 *                               [--full] [--dry-run] [--json]`
 * `memrain connectors status [--json]`
 * `memrain connectors redact-meetings [--source ID] [--apply --yes] [--json]`
 *
 * `redact-meetings` removes online-meeting credentials (ids, passcodes, PINs,
 * join links) from connector mail and calendar pages stored before the
 * renderers stripped them. Dry run by default, with counts per source;
 * `--apply --yes` writes each changed page as a new version and re-mirrors it.
 *
 * `status` lists every connector account (state, last clean sync, last run,
 * a waiting reconnect, a Google Testing-mode grant about to end) and every
 * recipe connector's watermark and last run.
 *
 * A one-shot, operator-run mirror of a GitHub repository's issues and pull
 * requests into a `github` source (see src/core/connectors/). The token comes
 * from `--token-file` or MEMRAIN_GITHUB_TOKEN; it is held in memory for the run,
 * sent only to api.github.com, and never written, logged or printed.
 *
 * `--dry-run` fetches the whole list and renders it without opening the brain,
 * so it neither needs nor moves a watermark.
 *
 * Exit codes: 0 success or nothing_new; 1 partial or a usage error; 2
 * auth_required or forbidden (the credential or its grant needs attention).
 */
import { statSync, readFileSync } from "node:fs";
import { loadConfig } from "../core/config.ts";
import type { EmbedFn } from "../core/indexer.ts";
import { OperationError } from "../core/operation-error.ts";
import { Storage } from "../core/storage.ts";
import type { FetchFn } from "../core/connectors/client.ts";
import {
  fetchIssuePages,
  githubClient,
  githubTarget,
  parseRepoRef,
  previewItems,
  syncGithub,
  type RepoRef,
} from "../core/connectors/github.ts";
import type { ConnectorRunStatus } from "../core/connectors/types.ts";
import { listConnectorStates } from "../core/connectors/watermark.ts";
import { grantExpiryText, listAccountStatus, runCountsText, type AccountStatus } from "../core/connectors/account-status.ts";
import { connectorsStatus } from "../core/connectors/vault.ts";
import { sweepMeetingCredentials, type MeetingRedactSweepResult } from "../core/connectors/meeting-redact-sweep.ts";
import { withStorage } from "./with-storage.ts";
import { runRotateKek } from "./connectors-vault.ts";

export interface ConnectorsCmdOptions {
  /** `github`, `status`, `redact-meetings` or `rotate-kek`. */
  sub: string | undefined;
  /** `sync` under `github`. */
  action?: string;
  /** `owner/repo`. */
  target?: string;
  sourceId?: string;
  tokenFile?: string;
  full?: boolean;
  dryRun?: boolean;
  /** `redact-meetings`: write the changes (needs `yes`). */
  apply?: boolean;
  yes?: boolean;
  json?: boolean;
  configPath?: string;
  /** Test seam: a Storage the caller opened and closes. */
  storage?: Storage;
  /** Test seams: recorded responses, a fake clock, a deterministic embedder. */
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  embedFn?: EmbedFn;
  /** `rotate-kek`: the current and the new connector key files. */
  oldKekFile?: string;
  newKekFile?: string;
}

const MAX_TOKEN_FILE_BYTES = 4096;
/** Printable ASCII, no whitespace: a token that could not split a header. */
const TOKEN_RE = /^[\x21-\x7E]{1,1024}$/;

export function exitCodeFor(status: ConnectorRunStatus): number {
  if (status === "success" || status === "nothing_new") return 0;
  if (status === "partial") return 1;
  return 2;
}

function fail(msg: string, json: boolean | undefined): number {
  if (json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`memrain connectors: ${msg}`);
  return 1;
}

/** The token, or an error message. Never echoes the token's content. */
export function readToken(tokenFile: string | undefined, env: NodeJS.ProcessEnv = process.env): { token: string } | { error: string } {
  let raw: string;
  if (tokenFile !== undefined) {
    let st;
    try {
      st = statSync(tokenFile);
    } catch {
      return { error: `cannot read --token-file ${tokenFile}` };
    }
    if (!st.isFile()) return { error: `--token-file ${tokenFile} is not a regular file` };
    if (st.size > MAX_TOKEN_FILE_BYTES) return { error: `--token-file ${tokenFile} is larger than ${MAX_TOKEN_FILE_BYTES} bytes` };
    try {
      raw = readFileSync(tokenFile, "utf-8");
    } catch {
      return { error: `cannot read --token-file ${tokenFile}` };
    }
  } else {
    raw = env.MEMRAIN_GITHUB_TOKEN ?? "";
  }
  const token = raw.trim();
  if (token === "") {
    return { error: tokenFile !== undefined ? `--token-file ${tokenFile} is empty` : "no token: set MEMRAIN_GITHUB_TOKEN or pass --token-file" };
  }
  if (!TOKEN_RE.test(token)) return { error: "the token contains whitespace or non-ASCII characters" };
  return { token };
}

async function runDryRun(ref: RepoRef, token: string, opts: ConnectorsCmdOptions): Promise<number> {
  const client = githubClient(token, clientSeams(opts));
  const fetched = await fetchIssuePages(client, ref, null);
  const preview = previewItems(ref, fetched.items);
  const status: ConnectorRunStatus =
    fetched.stopClass === "auth_required" || fetched.stopClass === "forbidden"
      ? fetched.stopClass
      : fetched.stopClass !== null || preview.rejected + preview.invalid > 0
        ? "partial"
        : preview.items === 0
          ? "nothing_new"
          : "success";
  if (opts.json) {
    console.log(
      JSON.stringify(
        { ok: exitCodeFor(status) === 0, dry_run: true, target: `${ref.owner}/${ref.repo}`, status, error_class: fetched.stopClass, http_status: fetched.stopStatus, error: fetched.stopError, preview },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `${ref.owner}/${ref.repo}: ${status} — ${preview.issues} issues, ${preview.pull_requests} pull requests, ` +
        `${preview.redactions} credentials to redact` +
        (preview.rejected > 0 ? `, ${preview.rejected} items would be refused` : "") +
        (fetched.stopError ? ` (stopped: ${fetched.stopError})` : "") +
        " — dry-run, nothing written",
    );
  }
  return exitCodeFor(status);
}

function clientSeams(opts: ConnectorsCmdOptions) {
  return {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  };
}

async function runGithubSync(opts: ConnectorsCmdOptions): Promise<number> {
  if (opts.action !== "sync") return fail("github: subcommand required (sync <owner/repo>)", opts.json);
  if (!opts.target) return fail("github sync: <owner/repo> is required", opts.json);
  const ref = parseRepoRef(opts.target);
  if (ref === null) return fail(`github sync: ${JSON.stringify(opts.target.slice(0, 200))} is not <owner>/<repo>`, opts.json);
  if (!opts.sourceId) return fail("github sync: --source <id> is required (a source registered with --kind github)", opts.json);
  const tok = readToken(opts.tokenFile);
  if ("error" in tok) return fail(tok.error, opts.json);

  if (opts.dryRun) return runDryRun(ref, tok.token, opts);

  const sourceId = opts.sourceId;
  const storage = new Storage(loadConfig(opts.configPath));
  let result;
  try {
    // syncGithub checks the source before its first request, so a typo in
    // --source never spends API quota.
    result = await withStorage(storage, () =>
      syncGithub(storage, {
        ref,
        sourceId,
        client: githubClient(tok.token, clientSeams(opts)),
        ...(opts.full ? { full: true } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.embedFn ? { embedFn: opts.embedFn } : {}),
      }),
    );
  } catch (e) {
    if (e instanceof OperationError) return fail(e.message, opts.json);
    throw e;
  }
  const code = exitCodeFor(result.status);
  if (opts.json) {
    console.log(JSON.stringify({ ok: code === 0, dry_run: false, ...result }, null, 2));
  } else {
    const c = result.counts;
    console.log(
      `${githubTarget(ref, sourceId)}: ${result.status} — ${c.items} items, ${c.pages_written} written, ` +
        `${c.pages_unchanged} unchanged, ${result.links_added} links added, ${result.redactions} credentials redacted` +
        (result.mirror_failures > 0 ? `, ${result.mirror_failures} not yet searchable` : "") +
        (result.error ? ` (stopped: ${result.error})` : ""),
    );
    for (const r of result.rejected) console.log(`  refused ${r.slug}: ${r.reason}`);
    for (const f of result.failed) {
      console.log(`  ${f.retryable ? "failed, retried next run" : "refused"} ${f.slug} (${f.code}): ${f.reason}`);
    }
    if (code === 2) console.log("  the token was refused or cannot read this repository; replace it and re-run");
  }
  return code;
}

/** One account as the operator reads it in a terminal. */
export function accountStatusLine(a: AccountStatus): string[] {
  const head = `${a.provider} ${a.account_label} (${a.id.slice(0, 8)}) into ${a.source_id}: ${a.state}`;
  const run = a.last_run;
  const parts = [
    ...(a.services.length > 0 ? [`services ${a.services.join(", ")}`] : []),
    `last clean sync ${a.last_success_at ?? "never"}`,
    ...(run
      ? [`last run ${run.status}${run.stop_reason ? ` (${run.stop_reason})` : ""} at ${run.at}, ${runCountsText(run)}` + (run.error ? ` — ${run.error}` : "")]
      : ["no run recorded yet"]),
  ];
  const lines = [`${head}, ${parts.join(", ")}`];
  if (a.needs_reconnect) {
    lines.push(`  needs a reconnect since ${a.reconnect_since}${a.status_reason ? ` (${a.status_reason})` : ""}: reconnect it on the admin Connections page; its data and cursors are kept`);
  }
  if (a.grant_expiry) lines.push(`  ${grantExpiryText(a.grant_expiry)}`);
  return lines;
}

async function runStatus(opts: ConnectorsCmdOptions): Promise<number> {
  const storage = new Storage(loadConfig(opts.configPath));
  const { states, accounts } = await withStorage(storage, async () => ({
    states: await listConnectorStates(storage.engine()),
    accounts: await listAccountStatus(storage.engine()),
  }));
  const gate = connectorsStatus();
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, connectors_enabled: gate.enabled, connectors_reason: gate.reason, connectors: states, accounts }, null, 2));
    return 0;
  }
  if (states.length === 0 && accounts.length === 0) {
    console.log("no connector account and no connector has run");
    return 0;
  }
  // An account's "sync on" is its own switch; this says whether any sync can run in this process at all.
  console.log(gate.enabled ? "connectors: on" : `connectors: off (${gate.reason ?? "unknown"})`);
  if (accounts.length > 0) console.log("accounts:");
  for (const a of accounts) for (const line of accountStatusLine(a)) console.log(`  ${line}`);
  if (states.length > 0) console.log("recipe connectors:");
  for (const s of states) {
    const run = s.last_run;
    console.log(
      `  ${s.recipe_id}: watermark ${s.watermark ?? "none"}` +
        (run ? `, last run ${run.status} at ${run.at}, last clean run ${run.last_success_at ?? "never"}` : "") +
        (s.refused.length > 0 ? `, ${s.refused.length} item(s) refused` : ""),
    );
  }
  return 0;
}

function printMeetingRedact(r: MeetingRedactSweepResult): void {
  console.log(`connector meeting credentials (${r.applied ? "apply" : "dry run"}): ${r.pages_changed} of ${r.pages_scanned} page(s), ${r.removals} credential(s)`);
  for (const [source, c] of Object.entries(r.by_source).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${source}: ${c.pages_changed} of ${c.pages_scanned} page(s), ${c.removals} credential(s)`);
  }
  if (r.applied) {
    console.log(`  ${r.rewritten} page(s) written as a new version`);
    if (r.mirror_failed > 0) console.log(`  ${r.mirror_failed} written page(s) whose search mirror failed; run again`);
    if (r.moved > 0) console.log(`  ${r.moved} page(s) changed by a sync meanwhile; run again`);
  } else if (r.pages_changed > 0) {
    console.log("Older version snapshots keep their text. Run with --apply --yes to write the redacted pages.");
  }
  for (const e of r.errors) console.log(`  ${e}`);
}

async function runRedactMeetings(opts: ConnectorsCmdOptions): Promise<number> {
  if (opts.apply && !opts.yes) {
    console.error("memrain connectors redact-meetings: --apply writes a new version of each changed page; add --yes to confirm (run without --apply first to review)");
    return 2;
  }
  const storage = opts.storage ?? new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const r = await sweepMeetingCredentials(storage, {
      ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
      apply: opts.apply === true,
      ...(opts.embedFn ? { mirror: { embedFn: opts.embedFn } } : {}),
    });
    if (opts.json) console.log(JSON.stringify({ ok: r.errors.length === 0, ...r }, null, 2));
    else printMeetingRedact(r);
    return r.errors.length + r.mirror_failed + r.moved > 0 ? 1 : 0;
  }, { owned: opts.storage === undefined });
}

export async function runConnectors(opts: ConnectorsCmdOptions): Promise<number> {
  if (opts.sub === "status") return runStatus(opts);
  if (opts.sub === "github") return runGithubSync(opts);
  if (opts.sub === "redact-meetings") return runRedactMeetings(opts);
  if (opts.sub === "rotate-kek") return runRotateKek(opts);
  console.error("memrain connectors: subcommand required (github sync <owner/repo> | status | redact-meetings | rotate-kek)");
  return 1;
}
