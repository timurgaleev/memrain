/**
 * The CLI's command surface as data, for the skill pack lint.
 *
 * Skills are followed word for word, so a `memrain <cmd> <sub>` a skill names
 * must exist. cli.ts stays the dispatcher; this table is what the lint reads,
 * and tests/skillpack_cli_commands.test.ts fails when the two drift apart.
 */

export interface CliCommandSpec {
  /** Named subcommands the dispatcher routes on (`jobs list`, `eval gate`). */
  subcommands: readonly string[];
  /**
   * True when the first positional may be free text (a query, a path, a slug),
   * so an unrecognised word after the command is not a dead subcommand.
   */
  freePositional: boolean;
}

const bare: CliCommandSpec = { subcommands: [], freePositional: false };
const free: CliCommandSpec = { subcommands: [], freePositional: true };
const subs = (...names: string[]): CliCommandSpec => ({
  subcommands: names,
  freePositional: false,
});

export const CLI_COMMANDS: Readonly<Record<string, CliCommandSpec>> = {
  "init": bare,
  "serve": bare,
  "index": free,
  "reindex": bare,
  "code-def": free,
  "code-refs": free,
  "code-callers": free,
  "code-callees": free,
  "doctor": bare,
  "hnsw": subs("status", "sweep", "rebuild"),
  "status": bare,
  "integrity": bare,
  "eval": subs("chronicle", "run-all", "compare", "gate"),
  "eval-probe": bare,
  "bench": bare,
  "backlinks": free,
  "merge": free,
  "salience": bare,
  "watch": bare,
  "cycle": bare,
  "extract": bare,
  "extract-conversation-facts": free,
  "think": free,
  "reconcile-links": bare,
  "friction": subs("analyze", "propose-fix", "list", "render", "log"),
  "eval-export": bare,
  "export": bare,
  "eval-prune": bare,
  "apply-migrations": bare,
  "cache": subs("stats", "prune", "clear"),
  "embed": free,
  "call": free,
  "sources": subs("list", "show", "register", "update", "delete"),
  "eval-replay": subs("capture", "list", "delete", "run"),
  "jobs": subs(
    "list",
    "stats",
    "retry",
    "cancel",
    "show",
    "submit",
    "progress",
    "remove",
    "prune",
    "smoke",
  ),
  // `skillify <prompt>` takes free text, so only `check`/`scaffold` are named.
  "skillify": { subcommands: ["check", "scaffold"], freePositional: true },
  "check-resolvable": bare,
  "orphans": bare,
  "page-retype": bare,
  "pages": bare,
  "lint": free,
  "reports": bare,
  "spend": bare,
  "agent": subs("run", "logs"),
  "skillopt": subs("eval"),
  "skillpack": subs("lint"),
  "transcripts": subs("ingest", "status", "push"),
  "connectors": subs("github"),
  "migrate-engine": bare,
  "auth": subs(
    "register-client",
    "list-clients",
    "revoke-client",
    "set-redirect-uris",
    "rescope-client",
    "grant-history",
    "set-budget",
    "enroll",
    "enrollments",
    "revoke-enrollment",
    "revoke-grant",
    "invalidate-tokens",
    "grant-token",
    "create",
    "list",
    "revoke",
    "permissions",
    "test",
    "doctor",
  ),
  // `search <query>` takes free text alongside its named views.
  "search": { subcommands: ["modes", "stats", "tune", "diagnose"], freePositional: true },
  "config": subs("show", "get", "set", "unset"),
  "capture": free,
  "quarantine": subs("list", "clear", "scan"),
  "version": bare,
  "help": bare,
};
