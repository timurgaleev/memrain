/**
 * `memrain connectors github sync <owner/repo> --source ID [--token-file F]
 *                               [--full] [--dry-run] [--json]`
 * `memrain connectors status [--json]`
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
import { withStorage } from "./with-storage.ts";
import { runRotateKek } from "./connectors-vault.ts";

export interface ConnectorsCmdOptions {
  /** `github`, `status` or `rotate-kek`. */
  sub: string | undefined;
  /** `sync` under `github`. */
  action?: string;
  /** `owner/repo`. */
  target?: string;
  sourceId?: string;
  tokenFile?: string;
  full?: boolean;
  dryRun?: boolean;
  json?: boolean;
  configPath?: string;
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

async function runStatus(opts: ConnectorsCmdOptions): Promise<number> {
  const storage = new Storage(loadConfig(opts.configPath));
  const states = await withStorage(storage, () => listConnectorStates(storage.engine()));
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, connectors: states }, null, 2));
    return 0;
  }
  if (states.length === 0) {
    console.log("no connector has run");
    return 0;
  }
  for (const s of states) {
    const run = s.last_run;
    console.log(
      `${s.recipe_id}: watermark ${s.watermark ?? "none"}` +
        (run ? `, last run ${run.status} at ${run.at}, last clean run ${run.last_success_at ?? "never"}` : "") +
        (s.refused.length > 0 ? `, ${s.refused.length} item(s) refused` : ""),
    );
  }
  return 0;
}

export async function runConnectors(opts: ConnectorsCmdOptions): Promise<number> {
  if (opts.sub === "status") return runStatus(opts);
  if (opts.sub === "github") return runGithubSync(opts);
  if (opts.sub === "rotate-kek") return runRotateKek(opts);
  console.error("memrain connectors: subcommand required (github sync <owner/repo> | status | rotate-kek)");
  return 1;
}
