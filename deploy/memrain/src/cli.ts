#!/usr/bin/env bun
/**
 * memrain CLI entrypoint.
 */
import "./core/env-compat.ts";
import { VERSION } from "./version.ts";
import { normalizeSourceFilterParam } from "./core/source-scope.ts";
import { runInit } from "./commands/init.ts";
import { runServe } from "./commands/serve.ts";
import { runReindex } from "./commands/reindex.ts";
import { runEngineStatus } from "./commands/engine-status.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runExport } from "./commands/export.ts";
import { runImport } from "./commands/import.ts";
import { runErase } from "./commands/erase.ts";
import { runPurgeLeftovers, runUnpurge } from "./commands/purge-leftovers.ts";
import { runBackupStatus } from "./commands/backup.ts";
import { runApplyMigrations } from "./commands/apply-migrations.ts";
import {
  runSources,
  runSourceOwnerOnly,
  runSourceFederate,
  runSourceProvenance,
  isSourceKind,
  isSyncPolicy,
  isIndexedPolicy,
} from "./commands/sources.ts";
import { runAuth } from "./commands/auth.ts";
import { runAdminSetupLink } from "./commands/admin.ts";
import { runRename } from "./commands/rename.ts";
import { runStatus } from "./commands/status.ts";
import { runEmbed } from "./commands/embed.ts";
import { runConfig, type ConfigSub } from "./commands/config.ts";
import { runTranscripts } from "./commands/transcripts.ts";
import { runQuarantine, type QuarantineSub } from "./commands/quarantine.ts";
import { runWriteGate } from "./commands/write-gate.ts";
import { assertNotWrapped } from "./core/startup-guard.ts";
import { runSecretsAudit, runSecretStore } from "./commands/secrets.ts";
import { exitCodeForError, resolveExitCode } from "./cli-exit.ts";
import { JSON_GUARDED_COMMANDS, parseArgs, validateFlags, type ParsedArgs } from "./cli-args.ts";
import { runJsonGuarded } from "./cli-json.ts";
import { aliasDeprecationLine } from "./cli-alias.ts";

function printUsage(): void {
  console.log("Usage: memrain <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  backup status [--rds-instance ID] [--efs-id ID] [--copy-report FILE]  inspect backup evidence");
  console.log("  export [--dir DIR] [--source ID]  export live pages as markdown");
  console.log("  import --dir DIR --source ID [--apply --plan-hash HASH]  preview create-only page import; indexing deferred");
  console.log("  purge-leftovers [--apply --plan-hash HASH64 --export FILE]  preview derived pre-Lite rows that purged sources left behind");
  console.log("  purge-leftovers restore --from FILE  undo an apply from its export");
  console.log("  unpurge <slug> [--source ID]  clear a purged page's tombstones so its text can be written again");
  console.log("  erase forgotten --source ID [--fact-ids CSV] [--deleted-pages CSV] [--apply --plan-hash HASH]");
  console.log("                               preview explicit database erasure of forgotten pre-Lite rows and deleted pages");
  console.log("  erase chat --owner KEY [--apply]  preview, then delete one owner's history a pre-Lite brain kept");
  console.log("  engine status [--probe] [--json]  inspect engine config; optionally test one connection");
  console.log("  init --pglite                initialize ~/.memrain/ + PGLite db");
  console.log("  serve --http --host H --port N");
  console.log("                               start HTTP server (loopback only)");
  console.log("  reindex [--all] [--vault P] [--reconcile-deletes] [--allow-mass-delete]");
  console.log("                               walk the vault, index changed (or all) files");
  console.log("                               (--reconcile-deletes soft-deletes vault docs whose file is gone)");
  console.log("                               (--allow-mass-delete lets it retire more than 50, or 25%, of them)");
  console.log("  doctor                       self-diagnostics — exits 0 on healthy");
  console.log("  status                       one-shot snapshot: counts + health");
  console.log("  status --quiescent           exit 3 unless no background work can write");
  console.log("                               (switches are read from this env: run it with");
  console.log("                               docker exec inside the serving container)");
  console.log("  embed [<slug>] [--slugs a,b] [--all] [--stale] [--source ID] [--limit N] [--dry-run]");
  console.log("                               backfill missing vectors; <slug>/--slugs/--all re-embed targets,");
  console.log("                               --stale also refreshes signature-stale rows");
  console.log("  apply-migrations [--dry-run] [--down <id> --yes]");
  console.log("                               manual migration runner (init runs them automatically)");
  console.log("  sources list [--kind K]      JSON list of registered sources");
  console.log("  sources show <id>            full row for one source");
  console.log("  sources register <id> --kind K --path-prefix P [--description D]");
  console.log("                               [--sync-policy synced|local-only|mirror]");
  console.log("                               [--indexed-policy verbatim|hashed-only|tombstoned]");
  console.log("                               [--rate-limit-per-minute N] [--respect-quiet-hours]");
  console.log("                               [--boost-weight N]");
  console.log("  sources update <id> [...same flags as register, all optional...]");
  console.log("                               [--no-respect-quiet-hours] to clear the flag");
  console.log("  sources delete <id>          refuses if any document still references it");
  console.log("  sources owner-only <id> [on|off]   a personal source only the owner reads");
  console.log("  sources federate <id>        unscoped reads (search, page_list, ...) reach the source");
  console.log("  sources unfederate <id>      only grants and source_ids reach it");
  console.log("  sources provenance [--apply]       record where older derived rows came from (dry run first)");
  console.log("  rename <from> <to> --expected-version N [--source ID]");
  console.log("                               move a page and its history; refuses importer-managed pages");
  console.log("  admin setup-link [--ttl <hours>] [--json]");
  console.log("                               one-time link for the panel owner to create a passkey (default 24h, max 72h)");
  console.log("  auth who-can-read <slug>     check issued credentials through page_get, without recording reads");
  console.log("  auth register-client <name> [--scopes S] [--source SRC] [--federated-read a,b]");
  console.log("                               [--tenant-mode client|enrollment]  (enrollment = each sign-in pinned by a one-time code)");
  console.log("                               [--token-endpoint-auth-method none|client_secret_post|client_secret_basic]");
  console.log("                               [--access-ttl 1h] [--refresh-ttl 30d]");
  console.log("                               register a client_credentials OAuth client (prints secret once;");
  console.log("                               'none' = public PKCE client, no secret)");
  console.log("  auth list-clients            JSON list of registered OAuth clients");
  console.log("  auth revoke-client <id> [--purge]");
  console.log("                               revoke a client and delete its tokens; the row, grant history");
  console.log("                               and spend stay (--purge hard-deletes the row)");
  console.log("  auth set-redirect-uris <id> <uri> [uri...] [--expected-revision N]");
  console.log("                               replace a client's redirect URIs; secret and tokens untouched");
  console.log("  auth rescope-client <id> --source SRC [--federated-read a,b]");
  console.log("                               [--bound-slug-prefixes p1,p2] [--tenant-mode client|enrollment]");
  console.log("                               [--access-ttl 1h|default] [--refresh-ttl 30d|default]");
  console.log("                               [--expected-revision N] [--dry-run]");
  console.log("                               change a client's tenancy in place — no secret rotation;");
  console.log("                               revision-checked, previewable, audited");
  console.log("  auth grant-history <id> [--limit N]");
  console.log("                               JSON audit of a client's grant changes, newest first");
  console.log("  auth enroll <source> [--label N] [--client ID] [--ttl 7d] [--replaces ENROLLMENT_ID]");
  console.log("                               one-time enrollment code: present it at /authorize");
  console.log("                               on an enrollment-mode client and lands in <source> (printed once);");
  console.log("                               --replaces keeps the old grant's spend key and revokes it on redemption");
  console.log("  auth enrollments [--client ID]");
  console.log("                               list issued enrollment codes (never the code itself)");
  console.log("  auth revoke-enrollment <id>  kill an unused enrollment code");
  console.log("  auth revoke-grant <id>       cut off a redeemed enrollment and delete its tokens");
  console.log("  auth invalidate-tokens <id> [--grant ENROLLMENT_ID]");
  console.log("                               delete a client's tokens and codes; the client stays");
  console.log("  auth set-budget <id> <usd|none>");
  console.log("                               daily USD ceiling across every paid op ('none' = uncapped)");
  console.log("  auth grant-token <id> <secret> [--scopes S]");
  console.log("                               mint an access token locally (= POST /token)");
  console.log("  auth create <name> [--member OWNER] [--source SRC] [--federated-read a,b]");
  console.log("                    [--scopes read,write]");
  console.log("                               mint a long-lived personal access token (prints once)");
  console.log("  auth list                    JSON list of personal access tokens (no hashes)");
  console.log("  auth revoke <name>           soft-revoke a personal access token");
  console.log("  auth test <url> --token <token>");
  console.log("                               live MCP smoke: initialize + tools/list + a real stats call");
  console.log("  auth doctor <base-url> [--client-file F | --token-file F] [--expect-source ID | --expect-operator]");
  console.log("              [--expect-version STAMP] [--json]");
  console.log("                               remote doctor: /health stamp, OAuth discovery, mint, MCP, scope probe");
  console.log("  config show|get|set|unset    DB-plane MEMRAIN_* knob overrides (no redeploy; env still wins)");
  console.log("  config unset --pattern <pfx> bulk-delete keys by prefix");
  console.log("  transcripts ingest <path> [--format auto|chatgpt|claude-ai|codex|claude-code] [--source ID] [--since ISO|7d|auto] [--no-embed] [--dry-run] [--json]");
  console.log("  transcripts status [--source ID] [--json]");
  console.log("                               import a ChatGPT / Claude.ai export or Codex / Claude Code session logs");
  console.log("                               (one file or a directory) as split, redacted conversation pages");
  console.log("  quarantine list [--include-flagged] [--json]");
  console.log("  quarantine clear <slug|path> [--force]");
  console.log("  quarantine scan [--limit N] [--apply]");
  console.log("  write-gate list [--all] [--json]");
  console.log("  write-gate approve|reject <id> [--json]");
  console.log("  write-gate rows [--all] [--json]");
  console.log("  write-gate release|drop <id> [--json]");
  console.log("  write-gate scan [--dry-run] [--json]");
  console.log("  write-gate scan --documents [--json]");
  console.log("  secrets audit [--source ID] [--kinds K,K] [--limit N] [--json] [--apply --yes]");
  console.log("                               rescan stored text with the current secret rules; dry run");
  console.log("                               by default, never prints a value");
  console.log("  secrets audit --transcripts [--slug-prefixes P/,P/] [--json] [--apply --yes]");
  console.log("                               agent transcripts only, with the cookie/.netrc/split-label rules;");
  console.log("                               counts and slugs only; apply keeps originals (needs the secret-store key)");
  console.log("  secrets originals [--slug S] [--source ID] [--json]   redacted originals the store keeps (no values)");
  console.log("  secrets reveal <slug> <fingerprint> [--json]          print the original behind a marker (audited)");
  console.log("  secrets restore <slug> <fingerprint> [--apply --plan-hash H]  put a false positive back (preview first)");
  console.log("  secrets backup [--dir D] | restore-backup <file>      encrypted export of the store / import it");
  console.log("  version | --version          print build version (git tag+sha, or 'dev')");
  console.log("  --help                       show this help");
}

async function main(argv: readonly string[]): Promise<number> {
  assertNotWrapped();
  const parsed = parseArgs(argv, { strict: false });
  const { cmd, flags } = parsed;

  // `memrain <cmd> --help` used to fall into the command case and die on a
  // missing required argument — asking for help is not a malformed invocation.
  // For the same reason it answers BEFORE validation: the moment you reach for
  // the manual is the moment the rest of the line is likely half-typed, and a
  // command's own help was unreachable while validation went first.
  const run = async (): Promise<number> => {
    if (cmd !== undefined && flags.has("--help")) {
      printUsage();
      return 0;
    }
    validateFlags(parsed);
    return dispatch(parsed, argv);
  };
  // Help and validation run inside the guard, so `--json --help` and a
  // refused flag still leave one JSON object on stdout.
  if (cmd !== undefined && JSON_GUARDED_COMMANDS.has(cmd) && flags.has("--json")) {
    return runJsonGuarded(run);
  }
  return run();
}

async function dispatch(parsed: ParsedArgs, argv: readonly string[]): Promise<number> {
  const { cmd, flags, values, positional } = parsed;
  switch (cmd) {
    case "init": {
      const pglite = flags.has("--pglite");
      const postgres = flags.has("--postgres");
      await runInit({ pglite, postgres });
      return 0;
    }
    case "serve": {
      const http = flags.has("--http");
      const host = values.get("--host") ?? process.env.MEMRAIN_HOST ?? "127.0.0.1";
      const portStr = values.get("--port") ?? process.env.BRAIN_PORT ?? "18790";
      const port = Number(portStr);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`memrain serve: invalid port ${portStr}`);
      }
      await runServe({ http, host, port });
      return 0;
    }
    case "reindex": {
      const opts: Parameters<typeof runReindex>[0] = { all: flags.has("--all") };
      const vault = values.get("--vault");
      if (vault) opts.vault = vault;
      if (flags.has("--reconcile-deletes")) opts.reconcileDeletes = true;
      if (flags.has("--allow-mass-delete")) opts.allowMassDelete = true;
      await runReindex(opts);
      return 0;
    }
    case "engine": {
      if (positional.length !== 1 || positional[0] !== "status") { console.error("Usage: memrain engine status [--probe] [--json]"); return 2; }
      return await runEngineStatus({ probe: flags.has("--probe"), json: flags.has("--json") });
    }
    case "doctor": {
      await runDoctor();
      return 0;
    }
    case "status": {
      return await runStatus({
        ...(flags.has("--per-source") ? { perSource: true } : {}),
        ...(flags.has("--quiescent") ? { quiescent: true } : {}),
      });
    }
    case "backup": {
      if (positional.length !== 1 || positional[0] !== "status") throw new Error("backup: use status");
      return runBackupStatus({ rdsInstance: values.get("--rds-instance"), efsId: values.get("--efs-id"), copyReport: values.get("--copy-report") });
    }
    case "import": {
      if (positional.length) throw new Error("import: use --dir and --source");
      if (flags.has("--apply") && flags.has("--dry-run")) throw new Error("import: choose --apply or --dry-run");
      return runImport({ dir: values.get("--dir") ?? "", source: values.get("--source") ?? "", apply: flags.has("--apply"), planHash: values.get("--plan-hash") });
    }
    case "purge-leftovers": {
      if (positional.length > 1 || (positional.length === 1 && positional[0] !== "restore")) {
        throw new Error("purge-leftovers: use purge-leftovers [--apply --plan-hash H --export FILE] or purge-leftovers restore --from FILE");
      }
      return runPurgeLeftovers({ ...(positional[0] === "restore" ? { sub: "restore" as const, from: values.get("--from") } : {}),
        apply: flags.has("--apply"), planHash: values.get("--plan-hash"), exportPath: values.get("--export") });
    }
    case "unpurge": {
      if (positional.length !== 1) throw new Error("unpurge: name one slug");
      return runUnpurge({ slug: positional[0]!, source: values.get("--source") });
    }
    case "erase": {
      if (positional.length === 1 && positional[0] === "chat") {
        return runErase({ sub: "chat", source: "", owner: values.get("--owner") ?? "", apply: flags.has("--apply") });
      }
      if (positional.length !== 1 || positional[0] !== "forgotten") throw new Error("erase: use erase forgotten with explicit targets, or erase chat --owner KEY");
      const rawIds = values.get("--fact-ids");
      const factIds = rawIds === undefined ? undefined : rawIds.split(",").map(value => {
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("erase: --fact-ids must be comma-separated positive safe integers");
        return Number(value);
      });
      return runErase({ sub: "forgotten", source: values.get("--source") ?? "", factIds,
        deletedPages: values.get("--deleted-pages")?.split(","), apply: flags.has("--apply"), planHash: values.get("--plan-hash") });
    }
    case "export": {
      const opts: Parameters<typeof runExport>[0] = {};
      const dir = values.get("--dir");
      if (dir) opts.dir = dir;
      const src = values.get("--source");
      const sourceIds = normalizeSourceFilterParam(src?.split(","));
      if (sourceIds !== undefined) opts.sourceIds = sourceIds;
      await runExport(opts);
      return 0;
    }
    case "apply-migrations": {
      const opts: Parameters<typeof runApplyMigrations>[0] = {};
      if (flags.has("--dry-run")) opts.dryRun = true;
      const down = values.get("--down");
      if (down !== undefined) {
        if (!/^\d+$/.test(down)) {
          console.error(`apply-migrations: --down needs a migration id, got '${down}'`);
          return 1;
        }
        opts.down = Number.parseInt(down, 10);
      }
      if (flags.has("--yes")) opts.yes = true;
      await runApplyMigrations(opts);
      return 0;
    }
    case "embed": {
      const limitStr = values.get("--limit");
      const opts: Parameters<typeof runEmbed>[0] = {};
      if (limitStr !== undefined) {
        const n = Number(limitStr);
        if (!Number.isInteger(n) || n <= 0) {
          console.error("memrain embed: --limit must be a positive integer");
          return 1;
        }
        opts.limit = n;
      }
      if (flags.has("--dry-run")) opts.dryRun = true;
      // Targeting (G51): positional slug(s) and/or --slugs CSV re-embed those
      // pages; --all re-embeds the whole embeddable corpus; --stale also
      // refreshes signature-stale rows; --source scopes any of the above.
      const slugSet = [
        ...positional,
        ...(values.get("--slugs")?.split(",") ?? []),
      ]
        .map((s) => s.trim())
        .filter(Boolean);
      if (slugSet.length > 0) opts.slugs = slugSet;
      if (flags.has("--all")) opts.all = true;
      if (flags.has("--stale")) opts.stale = true;
      const embedSource = values.get("--source");
      if (embedSource) opts.sourceId = embedSource;
      return await runEmbed(opts);
    }
    case "sources": {
      const sub = positional[0];
      if (sub === "owner-only") return await runSourceOwnerOnly(positional[1], positional[2]);
      if (sub === "federate" || sub === "unfederate") return await runSourceFederate(positional[1], sub === "federate");
      if (sub === "provenance") return await runSourceProvenance(flags.has("--apply"));
      if (
        sub !== "list" &&
        sub !== "show" &&
        sub !== "register" &&
        sub !== "update" &&
        sub !== "delete"
      ) {
        console.error(
          "memrain sources: subcommand required (list|show|register|update|delete|owner-only|federate|unfederate|provenance)",
        );
        return 1;
      }
      const opts: Parameters<typeof runSources>[0] = { sub };
      if (sub === "show" || sub === "register" || sub === "update" || sub === "delete") {
        opts.id = positional[1];
      }
      const kind = values.get("--kind");
      if (kind) {
        if (!isSourceKind(kind)) {
          throw new Error(`memrain sources: invalid --kind '${kind}'`);
        }
        opts.kind = kind;
      }
      const pp = values.get("--path-prefix");
      if (pp) opts.pathPrefix = pp;
      const sp = values.get("--sync-policy");
      if (sp) {
        if (!isSyncPolicy(sp)) {
          throw new Error(`memrain sources: invalid --sync-policy '${sp}'`);
        }
        opts.syncPolicy = sp;
      }
      const ip = values.get("--indexed-policy");
      if (ip) {
        if (!isIndexedPolicy(ip)) {
          throw new Error(`memrain sources: invalid --indexed-policy '${ip}'`);
        }
        opts.indexedPolicy = ip;
      }
      const rl = values.get("--rate-limit-per-minute");
      if (rl !== undefined) {
        const n = Number(rl);
        if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
          throw new Error(`memrain sources: invalid --rate-limit-per-minute ${rl}`);
        }
        opts.rateLimitPerMinute = n;
      }
      if (flags.has("--respect-quiet-hours")) opts.respectQuietHours = true;
      if (flags.has("--no-respect-quiet-hours")) opts.respectQuietHours = false;
      const bw = values.get("--boost-weight");
      if (bw !== undefined) {
        const n = Number(bw);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          throw new Error(`memrain sources: invalid --boost-weight ${bw}`);
        }
        opts.boostWeight = n;
      }
      const desc = values.get("--description");
      if (desc !== undefined) opts.description = desc;
      await runSources(opts);
      return 0;
    }
    case "rename": {
      const expectedVersion = Number(values.get("--expected-version"));
      if (positional.length !== 2 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        throw new Error("memrain rename: <from> <to> --expected-version <positive integer> is required");
      }
      return runRename({ from: positional[0]!, to: positional[1]!, expectedVersion, sourceId: values.get("--source") });
    }
    case "admin": {
      // `admin setup-link` — a one-time passkey setup link for the panel owner.
      if (positional[0] !== "setup-link" || positional.length !== 1) {
        console.error("Usage: memrain admin setup-link [--ttl <hours>] [--json]");
        return 1;
      }
      const ttl = values.get("--ttl");
      return runAdminSetupLink({ ...(ttl !== undefined ? { ttl } : {}), json: flags.has("--json") });
    }
    case "auth": {
      // Self-issued OAuth 2.1 provider management. Re-parses its own raw flags
      // (--grant-types/--scopes/--source/--federated-read), so pass the raw tail.
      await runAuth(argv.slice(1));
      return 0;
    }
    case "config": {
      const sub = positional[0];
      if (sub !== "show" && sub !== "get" && sub !== "set" && sub !== "unset") {
        console.error("memrain config: subcommand required (show|get|set|unset)");
        return 1;
      }
      const opts: Parameters<typeof runConfig>[0] = { sub: sub as ConfigSub };
      if (sub === "get" || sub === "unset") {
        if (positional[1]) opts.key = positional[1];
      }
      if (sub === "set") {
        opts.key = positional[1];
        opts.value = positional[2];
        if (flags.has("--force")) opts.force = true;
      }
      if (sub === "unset") {
        const pattern = values.get("--pattern");
        if (pattern !== undefined) opts.pattern = pattern;
      }
      return await runConfig(opts);
    }
    case "transcripts": {
      const opts: Parameters<typeof runTranscripts>[0] = { sub: positional[0] };
      const file = positional[1];
      if (file) opts.file = file;
      const format = values.get("--format");
      if (format) opts.format = format;
      const src = values.get("--source");
      if (src) opts.sourceId = src;
      const since = values.get("--since");
      if (since) opts.since = since;
      if (flags.has("--no-embed")) opts.noEmbed = true;
      if (flags.has("--dry-run")) opts.dryRun = true;
      if (flags.has("--json")) opts.json = true;
      return await runTranscripts(opts);
    }
    case "quarantine": {
      const sub = positional[0];
      if (sub !== "list" && sub !== "clear" && sub !== "scan") {
        console.error("memrain quarantine: subcommand required (list|clear|scan)");
        return 1;
      }
      const opts: Parameters<typeof runQuarantine>[0] = {
        sub: sub as QuarantineSub,
      };
      if (sub === "clear") {
        const target = positional[1];
        if (!target) {
          console.error("memrain quarantine clear: <slug|source_path> is required");
          return 1;
        }
        opts.target = target;
        if (flags.has("--force")) opts.force = true;
      }
      if (sub === "list" && flags.has("--include-flagged")) opts.includeFlagged = true;
      if (sub === "scan") {
        if (flags.has("--apply")) opts.apply = true;
        const limitStr = values.get("--limit");
        if (limitStr !== undefined) {
          const n = Number(limitStr);
          if (!Number.isInteger(n) || n < 1) {
            throw new Error(`memrain quarantine scan: invalid --limit ${limitStr}`);
          }
          opts.limit = n;
        }
      }
      if (flags.has("--json")) opts.json = true;
      return await runQuarantine(opts);
    }
    case "write-gate": {
      const sub = positional[0];
      const subs = ["list", "approve", "reject", "rows", "release", "drop", "scan"] as const;
      if (!subs.includes(sub as (typeof subs)[number])) {
        console.error(`memrain write-gate: subcommand required (${subs.join("|")})`);
        return 1;
      }
      const opts: Parameters<typeof runWriteGate>[0] = { sub: sub as (typeof subs)[number] };
      if ((sub === "list" || sub === "rows") && flags.has("--all")) opts.all = true;
      if (sub === "scan" && flags.has("--dry-run")) opts.dryRun = true;
      if (sub === "scan" && flags.has("--documents")) opts.documents = true;
      if (sub === "approve" || sub === "reject" || sub === "release" || sub === "drop") {
        const id = Number(positional[1]);
        if (!positional[1] || !Number.isInteger(id) || id < 1) {
          const list = sub === "release" || sub === "drop" ? "rows" : "list";
          console.error(`memrain write-gate ${sub}: <id> is required (see \`memrain write-gate ${list}\`)`);
          return 1;
        }
        opts.id = id;
      }
      if (flags.has("--json")) opts.json = true;
      return await runWriteGate(opts);
    }
    case "secrets": {
      const storeSub = positional[0];
      if (storeSub === "originals" || storeSub === "reveal" || storeSub === "restore" || storeSub === "backup" || storeSub === "restore-backup") {
        const slug = values.get("--slug");
        const src = values.get("--source");
        const expect = values.get("--plan-hash");
        const dir = values.get("--dir");
        return await runSecretStore({
          sub: storeSub, args: positional.slice(1), apply: flags.has("--apply"), json: flags.has("--json"),
          ...(slug ? { slug } : {}), ...(src ? { sourceId: src } : {}), ...(expect ? { expect } : {}), ...(dir ? { dir } : {}),
        });
      }
      if (positional[0] !== "audit") {
        console.error("memrain secrets: subcommand required (audit, originals, reveal, restore, backup, restore-backup)");
        return 1;
      }
      const opts: Parameters<typeof runSecretsAudit>[0] = {
        apply: flags.has("--apply"),
        yes: flags.has("--yes"),
        json: flags.has("--json"),
      };
      const src = values.get("--source");
      if (src) opts.sourceId = src;
      const kinds = values.get("--kinds");
      if (kinds) opts.kinds = kinds.split(",").map((k) => k.trim()).filter(Boolean);
      if (flags.has("--transcripts")) opts.transcripts = true;
      const slugPrefixes = values.get("--slug-prefixes");
      if (slugPrefixes) opts.slugPrefixes = slugPrefixes.split(",").map((k) => k.trim()).filter(Boolean);
      const limitStr = values.get("--limit");
      if (limitStr !== undefined) {
        const n = Number(limitStr);
        if (!Number.isInteger(n) || n < 1) throw new Error(`memrain secrets audit: invalid --limit ${limitStr}`);
        opts.limit = n;
      }
      return await runSecretsAudit(opts);
    }
    case "version":
    case "--version":
      console.log(flags.has("--json") ? JSON.stringify({ ok: true, version: VERSION }) : `memrain ${VERSION}`);
      return 0;
    case undefined:
    case "--help":
    case "-h":
    case "help":
      printUsage();
      return 0;
    default:
      console.error(`memrain: unknown command '${cmd}'`);
      printUsage();
      return 1;
  }
}

const aliasNote = aliasDeprecationLine(process.argv, process.env);
if (aliasNote) console.error(aliasNote);

main(process.argv.slice(2)).then(
  (code) => process.exit(resolveExitCode(code, process.exitCode ?? undefined)),
  (err) => {
    console.error(`[memrain] error:`, err instanceof Error ? err.message : err);
    process.exit(exitCodeForError(err));
  },
);
