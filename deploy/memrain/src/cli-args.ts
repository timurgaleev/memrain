/**
 * CLI argument parsing.
 *
 * The old inline parser got two things wrong, and both turned a typo into a
 * silent, wrong — sometimes expensive — run:
 *
 *   1. A boolean flag consumed the next token whenever that token was not
 *      `--`-prefixed. `memrain embed --dry-run <slug>` therefore lost BOTH the
 *      slug and the dry-run and started a real, paid whole-corpus backfill.
 *      `VALUELESS_FLAGS` settles it by name, not by position: a boolean is a
 *      boolean wherever it sits on the line.
 *   2. `--key=value` arrives as ONE token and was never split, so
 *      `memrain search --k=5 hello` searched with the default k and
 *      `memrain apply-migrations --dry-run=true` really applied.
 *
 * Adding a new boolean flag to a command means adding it to VALUELESS_FLAGS
 * too — otherwise it eats the next positional. The test asserts that.
 *
 * Validation is then keyed PER COMMAND (`COMMAND_FLAGS`), not against one
 * global vocabulary. A global set is wrong in both directions: it rejected
 * `memrain doctor --remediate` — a flag doctor really reads, which made the whole
 * self-heal surface unreachable — while accepting `memrain reindex --stale`,
 * which reindex never reads and therefore silently dropped. "Does THIS command
 * read THIS flag" is the only question whose answer is useful to the caller.
 */
import { nearest } from "./core/did-you-mean.ts";

/**
 * Flags that never take a value — one entry per boolean the command cases in
 * cli.ts read out of `flags`. Matching is exact, so the value-taking
 * near-twins (`--stale-days`, `--pglite-path`, `--postgres-url`) are
 * untouched. `--limit` is deliberately absent: it TAKES a value, so a bare
 * `--limit` is a missing value, which `validateFlags` refuses.
 */
export const VALUELESS_FLAGS: ReadonlySet<string> = new Set([
  "--all",
  "--allow-mass-delete",
  "--apply",
  "--documents",
  "--dry-run",
  "--expect-operator",
  "--force",
  "--help",
  "--http",
  "--include-flagged",
  "--json",
  "--no-embed",
  "--no-respect-quiet-hours",
  "--per-source",
  "--pglite",
  "--postgres",
  "--probe",
  "--purge",
  "--quiescent",
  "--reconcile-deletes",
  "--respect-quiet-hours",
  "--stale",
  "--transcripts",
  "--yes",
]);

/**
 * `--flag=<literal>` forms a boolean accepts.
 *
 * A bare `--flag=` is an ERROR, not ON. Shells expand an unset variable to
 * nothing, so `memrain reindex --force=$MODE` arrives as `--force=` — and the
 * destructive booleans (`--apply`, `--force`, `--fix`) are exactly the ones
 * where guessing ON turns a typo into data loss. Refusing is the only reading
 * that cannot silently destroy something.
 */
const TRUE_LITERALS: ReadonlySet<string> = new Set(["true", "1", "yes"]);
const FALSE_LITERALS: ReadonlySet<string> = new Set(["false", "0", "no"]);

/**
 * Every flag that takes a value, across all commands. Derived from the
 * `values.get("--x")` reads in src/ — a flag missing here is rejected as a
 * typo, so adding a new value-taking flag means adding it here too.
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--fact-ids",
  "--deleted-pages",
  "--export",
  "--access-ttl",
  "--boost-weight",
  "--bound-slug-prefixes",
  "--client",
  "--client-file",
  "--rds-instance",
  "--efs-id",
  "--copy-report",
  "--description",
  "--dir",
  "--down",
  "--expect-source",
  "--expect-version",
  "--expected-revision",
  "--expected-version",
  "--federated-read",
  "--format",
  "--from",
  "--grant",
  "--grant-types",
  "--host",
  "--indexed-policy",
  "--kind",
  "--kinds",
  "--label",
  "--limit",
  "--member",
  "--owner",
  "--path-prefix",
  "--pattern",
  "--plan-hash",
  "--port",
  "--rate-limit-per-minute",
  "--redirect-uris",
  "--refresh-ttl",
  "--replaces",
  "--scopes",
  "--since",
  "--slug",
  "--slugs",
  "--slug-prefixes",
  "--source",
  "--sync-policy",
  "--tenant-mode",
  "--token",
  "--token-endpoint-auth-method",
  "--token-file",
  "--ttl",
  "--vault",
]);

/** Union of every flag the CLI understands. Anything else is a typo. */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  ...VALUELESS_FLAGS,
  ...VALUE_FLAGS,
]);

/**
 * Commands whose `--json` output is guarded (cli-json.ts): stdout is exactly
 * one JSON object whatever the command prints, errors included. They accept
 * `--json` even when their case never reads it, because main() reads it for
 * them. Streaming commands (`watch`, `serve`) must never join: the guard holds
 * stdout until the command returns.
 */
export const JSON_GUARDED_COMMANDS: ReadonlySet<string> = new Set([
  "doctor", "engine", "export", "secrets", "sources", "status", "version",
]);

/** Answered by every command, so no command lists it. */
const UNIVERSAL_FLAGS: ReadonlySet<string> = new Set(["--help"]);

/**
 * What each command actually reads — one entry per `case` label in cli.ts, and
 * the flag set is exactly the flags that case's body pulls out of `flags` /
 * `values`. The test derives the same thing from cli.ts and demands equality,
 * so a flag added to a command without an entry here fails the suite instead of
 * failing the operator.
 *
 * `auth` does its own parsing and so has no reads in the switch: it re-parses
 * the raw tail with its own `parseFlags`. Its row comes from that module, and
 * the test reads it from there.
 */
export const COMMAND_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["engine", new Set(["--probe", "--json"])],
  ["backup", new Set(["--rds-instance", "--efs-id", "--copy-report"])],
  ["import", new Set(["--dir", "--source", "--apply", "--dry-run", "--plan-hash"])],
  ["purge-leftovers", new Set(["--apply", "--plan-hash", "--export", "--from"])],
  ["unpurge", new Set(["--source"])],
  ["erase", new Set(["--source", "--fact-ids", "--deleted-pages", "--apply", "--plan-hash", "--owner"])],
  ["init", new Set(["--pglite", "--postgres"])],
  ["serve", new Set(["--host", "--http", "--port"])],
  ["reindex", new Set(["--all", "--allow-mass-delete", "--reconcile-deletes", "--vault"])],
  ["doctor", new Set<string>()],
  ["status", new Set(["--per-source", "--quiescent"])],
  ["export", new Set(["--dir", "--source"])],
  ["apply-migrations", new Set(["--down", "--dry-run", "--yes"])],
  ["embed", new Set(["--all", "--dry-run", "--limit", "--slugs", "--source", "--stale"])],
  [
    "sources",
    new Set([
      "--boost-weight", "--description", "--indexed-policy", "--kind",
      "--no-respect-quiet-hours", "--path-prefix", "--rate-limit-per-minute",
      "--respect-quiet-hours", "--sync-policy", "--apply",
    ]),
  ],
  ["rename", new Set(["--expected-version", "--source"])],
  ["admin", new Set(["--json", "--ttl"])],
  [
    "auth",
    new Set([
      "--access-ttl", "--bound-slug-prefixes", "--client", "--client-file", "--dry-run",
      "--expect-operator", "--expect-source", "--expect-version",
      "--expected-revision", "--federated-read", "--grant", "--grant-types", "--json",
      "--label", "--limit", "--member", "--purge", "--redirect-uris", "--refresh-ttl", "--replaces", "--scopes", "--source",
      "--tenant-mode", "--token", "--token-endpoint-auth-method", "--token-file", "--ttl",
    ]),
  ],
  ["config", new Set(["--force", "--pattern"])],
  [
    "quarantine",
    new Set(["--apply", "--force", "--include-flagged", "--json", "--limit"]),
  ],
  ["write-gate", new Set(["--all", "--json", "--dry-run", "--documents"])],
  ["secrets", new Set(["--apply", "--dir", "--json", "--kinds", "--limit", "--plan-hash", "--slug", "--slug-prefixes", "--source", "--transcripts", "--yes"])],
  ["transcripts", new Set(["--dry-run", "--format", "--json", "--no-embed", "--since", "--source"])],
  ["version", new Set(["--json"])],
  ["help", new Set<string>()],
]);

/**
 * Flags that carry intent about whether real work happens, mapped to the
 * commands that actually honour them.
 *
 * A misspelled flag is caught by KNOWN_FLAGS, but a correctly spelled one on a
 * command that ignores it is the worse bug: `--dry-run` on a command with no
 * dry-run support reads as "preview" and mutates. The fallback for every one of
 * these is the mutating or paid path, so silence is the expensive answer.
 */
export const SAFETY_FLAG_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["--dry-run", new Set(["apply-migrations", "auth", "embed", "import", "transcripts", "write-gate"])],
  ["--apply", new Set(["import", "erase", "purge-leftovers", "quarantine", "secrets", "sources"])],
]);

export interface ParsedArgs {
  cmd: string | undefined;
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

export interface ParseArgsOptions {
  /**
   * Reject flags the CLI does not define, and safety flags on commands that
   * ignore them. Default ON: a dropped `--dry-run` costs money, and a dropped
   * `--limit` costs a whole-corpus pass.
   */
  strict?: boolean;
}

/**
 * Thrown for a flag the command cannot use — unknown to it, misplaced, or
 * given no value. The CLI prints the message and exits non-zero.
 */
export class UnknownFlagError extends Error {}

/**
 * Flags of a command that only one of its subcommands reads; the others would
 * ignore them. validateFlags refuses them there, and the skill lint follows suit.
 */
export const SUBCOMMAND_FLAGS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map();

/**
 * Whether `cmd` accepts `flag`, by the same rules `validateFlags` applies;
 * undefined when the command has no row of its own. The skill pack lint asks
 * this of every flag a skill writes, so a skill passes exactly when the
 * dispatcher would accept the flag. `sub` is the first positional; a flag
 * that only one subcommand reads (SUBCOMMAND_FLAGS) is refused on the others.
 */
export function commandAcceptsFlag(cmd: string, flag: string, sub: string | null = null): boolean | undefined {
  const accepted = COMMAND_FLAGS.get(cmd);
  if (accepted === undefined) return undefined;
  if (UNIVERSAL_FLAGS.has(flag)) return true;
  if (flag === "--json" && JSON_GUARDED_COMMANDS.has(cmd)) return true;
  const only = SUBCOMMAND_FLAGS.get(cmd)?.get(flag);
  if (only !== undefined && only !== sub) return false;
  return accepted.has(flag);
}

/** Validate the parsed flags against the vocabulary of the command being run. */
export function validateFlags(parsed: ParsedArgs): void {
  const { cmd } = parsed;
  // An unrecognised command has no vocabulary of its own — fall back to the
  // global one so a typo'd flag still gets a hint, and let cli.ts report the
  // command itself.
  const accepted = cmd === undefined ? undefined : COMMAND_FLAGS.get(cmd);

  // The safety flags keep their own louder refusal: a correctly spelled
  // `--dry-run` on a command that ignores it reads as "preview" and mutates,
  // which deserves more than "unknown flag".
  if (cmd !== undefined) {
    for (const [flag, commands] of SAFETY_FLAG_COMMANDS) {
      if ((parsed.flags.has(flag) || parsed.values.has(flag)) && !commands.has(cmd)) {
        throw new UnknownFlagError(
          `memrain: ${flag} is not supported by '${cmd}' — refusing to run, ` +
            `because ignoring it would do the opposite of what it asks for`,
        );
      }
    }
  }

  const seen = [...parsed.flags, ...parsed.values.keys()];
  const sub = parsed.positional[0] ?? null;
  for (const flag of seen) {
    const ok = (cmd === undefined ? undefined : commandAcceptsFlag(cmd, flag, sub)) ?? KNOWN_FLAGS.has(flag);
    if (ok) continue;
    const only = cmd === undefined ? undefined : SUBCOMMAND_FLAGS.get(cmd)?.get(flag);
    if (only !== undefined) {
      throw new UnknownFlagError(`memrain ${cmd}: ${flag} is only read by '${cmd} ${only}'`);
    }
    // Suggest only flags the CURRENT command accepts: suggesting a flag that
    // would itself be refused is worse than suggesting nothing.
    const hint = nearest(flag, accepted ?? KNOWN_FLAGS);
    const guess = hint ? ` — did you mean ${hint}?` : "";
    const takes =
      accepted === undefined
        ? ""
        : accepted.size === 0
          ? ` ('${cmd}' takes no flags)`
          : ` ('${cmd}' accepts: ${[...accepted].sort().join(", ")})`;
    throw new UnknownFlagError(`memrain: unknown flag '${flag}'${guess}${takes}`);
  }

  // A value-taking flag given nothing to take lands in `flags` (the parser
  // refuses to eat the next positional). Reading that as a bare boolean is how
  // `memrain reindex --vault --all` silently reindexed the default vault, so it
  // is an error here rather than a default three layers down.
  for (const flag of parsed.flags) {
    if (VALUE_FLAGS.has(flag)) {
      throw new UnknownFlagError(
        `memrain${cmd !== undefined ? ` ${cmd}` : ""}: ${flag} requires a value`,
      );
    }
  }
}

export function parseArgs(raw: readonly string[], opts: ParseArgsOptions = {}): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  const cmd = raw[0];
  for (let i = 1; i < raw.length; i++) {
    const token = raw[i];
    if (!token) continue;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    // `--key=value` is a single token. Split on the FIRST '=' only, so a value
    // may contain more of them (JSON payloads and URLs do).
    const eq = token.indexOf("=");
    if (eq > 2) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (VALUELESS_FLAGS.has(key)) {
        const literal = value.toLowerCase();
        if (TRUE_LITERALS.has(literal)) {
          flags.add(key);
        } else if (!FALSE_LITERALS.has(literal)) {
          throw new Error(
            `memrain: ${key} is a boolean flag — got '${token}' (use ${key}, ${key}=true or ${key}=false)`,
          );
        }
      } else {
        values.set(key, value);
      }
      continue;
    }
    // A boolean never consumes the next token, whatever follows it.
    if (VALUELESS_FLAGS.has(token)) {
      flags.add(token);
      continue;
    }
    const next = raw[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(token, next);
      i++;
    } else {
      // A value-taking flag with nothing to take lands in `flags`, where
      // validateFlags rejects it by name instead of guessing a default.
      flags.add(token);
    }
  }
  const parsed = { cmd, flags, values, positional };
  if (opts.strict !== false) validateFlags(parsed);
  return parsed;
}
