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
  "--allow-dropped-columns",
  "--apply",
  "--by-kind",
  "--catch-up",
  "--contextual",
  "--cosine-rescore",
  "--dry-run",
  "--execute",
  "--expand",
  "--expect-operator",
  "--explain",
  "--facts",
  "--fix",
  "--force",
  "--full",
  "--graph-signals",
  "--help",
  "--hook-stdin",
  "--http",
  "--include-flagged",
  "--json",
  "--live",
  "--max-pool",
  "--no-embed",
  "--no-expand",
  "--no-redact",
  "--no-respect-quiet-hours",
  "--per-source",
  "--pglite",
  "--postgres",
  "--promote",
  "--purge",
  "--quiescent",
  "--rechunk-stale",
  "--reconcile-deletes",
  "--relational-arm",
  "--remediate",
  "--remediation-plan",
  "--rerank",
  "--respect-quiet-hours",
  "--save",
  "--stale",
  "--stdin",
  "--strict",
  "--verify-only",
  "--wait",
  "--with-calibration",
  "--write-baseline",
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
  "--access-ttl", "--anchor", "--args", "--baseline", "--batch-size", "--boost-weight", "--candidate",
  "--bound-slug-prefixes", "--budget", "--client", "--client-file", "--config-a",
  "--config-b", "--corpus",
  "--date-context", "--days", "--dedup-type-ratio", "--depth", "--description", "--epsilon",
  "--dir", "--down", "--example-limit", "--expect-source", "--expect-version",
  "--expected-doc", "--expected-revision", "--family",
  "--federated-read", "--file", "--format",
  "--filter", "--from", "--grant", "--grant-types", "--host", "--id", "--indexed-policy",
  "--input", "--k", "--keep-days", "--kind", "--label", "--limit", "--max-drop",
  "--max-cost-usd", "--max-jobs", "--max-pages", "--max-retries", "--max-usd",
  "--min-confidence", "--min-recall", "--model", "--modes", "--notes",
  "--older-than-days", "--out", "--path-prefix", "--paths", "--pattern",
  "--payload", "--pglite-path", "--phases", "--port", "--postgres-url",
  "--priority", "--qrels", "--query", "--question", "--rate-limit-per-minute",
  "--reason", "--redirect-uris", "--refresh-ttl", "--repeats", "--replaces", "--rounds", "--rrf-k", "--scopes",
  "--search-mode", "--severity", "--since", "--skill", "--slug", "--slugs", "--split",
  "--source", "--source-id", "--source-path", "--source-slug", "--stale-days",
  "--status", "--sync-policy", "--tag", "--take", "--takes-holders",
  "--tables", "--target", "--tenant-mode", "--threshold", "--title", "--to",
  "--to-pglite-path", "--token",
  "--token-endpoint-auth-method", "--token-file", "--tool-name", "--top-skills", "--ttl",
  "--type",
  "--until", "--url", "--vault", "--what", "--where", "--who", "--window-turns",
  "--written-by",
]);

/** Union of every flag the CLI understands. Anything else is a typo. */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  ...VALUELESS_FLAGS,
  ...VALUE_FLAGS,
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
 * Two commands do their own parsing and so have no reads in the switch:
 * `doctor` reads its remediation flags straight off `process.argv` inside
 * runDoctor, and `auth` re-parses the raw tail with its own `parseFlags`. Their
 * rows come from those modules, and the test reads them from there.
 */
export const COMMAND_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["init", new Set(["--pglite", "--postgres"])],
  ["serve", new Set(["--host", "--http", "--port"])],
  ["index", new Set<string>()],
  [
    "reindex",
    new Set([
      "--all", "--contextual", "--dry-run", "--force", "--limit", "--paths",
      "--rechunk-stale", "--reconcile-deletes", "--source", "--vault",
    ]),
  ],
  ["code-def", new Set(["--json"])],
  ["code-refs", new Set(["--json"])],
  ["code-callers", new Set(["--json"])],
  ["code-callees", new Set(["--json"])],
  [
    "doctor",
    new Set([
      "--execute", "--max-jobs", "--max-usd", "--remediate",
      "--remediation-plan", "--yes",
    ]),
  ],
  ["hnsw", new Set(["--force"])],
  ["status", new Set(["--per-source", "--quiescent"])],
  ["integrity", new Set(["--vault"])],
  [
    "eval",
    new Set([
      "--baseline", "--config-a", "--config-b", "--cosine-rescore",
      "--dedup-type-ratio", "--expand", "--graph-signals", "--input", "--json",
      "--k", "--max-drop", "--max-pool", "--min-recall", "--modes",
      "--no-expand", "--out", "--qrels", "--relational-arm", "--rerank",
      "--rrf-k", "--write-baseline",
    ]),
  ],
  ["eval-probe", new Set(["--limit", "--max-usd"])],
  ["bench", new Set(["--corpus", "--family", "--json", "--live"])],
  ["backlinks", new Set(["--limit", "--type"])],
  ["merge", new Set(["--source", "--written-by"])],
  ["salience", new Set(["--days", "--limit", "--type"])],
  [
    "watch",
    new Set(["--json", "--max-pages", "--min-confidence", "--window-turns"]),
  ],
  ["cycle", new Set(["--phases", "--stale-days"])],
  [
    "extract",
    new Set([
      "--all", "--catch-up", "--dry-run", "--json", "--source-id", "--stale",
      "--vault",
    ]),
  ],
  [
    "extract-conversation-facts",
    new Set(["--budget", "--date-context", "--file", "--json", "--source-slug"]),
  ],
  [
    "think",
    new Set([
      "--anchor", "--budget", "--json", "--k", "--model", "--question",
      "--rounds", "--save", "--since", "--take", "--until",
      "--with-calibration",
    ]),
  ],
  ["reconcile-links", new Set(["--limit"])],
  [
    "friction",
    new Set([
      "--example-limit", "--kind", "--limit", "--no-redact", "--query",
      "--reason", "--severity", "--since", "--skill", "--source-path",
      "--top-skills",
    ]),
  ],
  ["eval-export", new Set(["--limit", "--out", "--since", "--source"])],
  ["export", new Set(["--dir", "--source"])],
  ["eval-prune", new Set(["--apply", "--keep-days", "--tool-name"])],
  ["apply-migrations", new Set(["--down", "--dry-run", "--yes"])],
  ["cache", new Set<string>()],
  [
    "embed",
    new Set(["--all", "--dry-run", "--limit", "--slugs", "--source", "--stale"]),
  ],
  ["call", new Set(["--args"])],
  [
    "sources",
    new Set([
      "--boost-weight", "--description", "--indexed-policy", "--kind",
      "--no-respect-quiet-hours", "--path-prefix", "--rate-limit-per-minute",
      "--respect-quiet-hours", "--sync-policy",
    ]),
  ],
  [
    "eval-replay",
    new Set([
      "--expected-doc", "--k", "--limit", "--notes", "--promote", "--query",
      "--search-mode", "--source", "--tag",
    ]),
  ],
  [
    "jobs",
    new Set([
      "--by-kind", "--dry-run", "--id", "--kind", "--limit", "--max-retries",
      "--older-than-days", "--payload", "--priority", "--status",
    ]),
  ],
  ["skillify", new Set(["--dry-run", "--out", "--slug", "--strict"])],
  ["check-resolvable", new Set(["--limit", "--strict", "--threshold"])],
  ["orphans", new Set<string>()],
  [
    "page-retype",
    new Set([
      "--apply", "--from", "--json", "--path-prefix", "--slugs", "--source-id",
      "--to",
    ]),
  ],
  ["pages", new Set(["--filter", "--limit"])],
  ["lint", new Set(["--dry-run", "--fix"])],
  ["reports", new Set(["--since"])],
  ["spend", new Set(["--days"])],
  ["agent", new Set(["--max-usd", "--wait"])],
  [
    "skillopt",
    new Set(["--candidate", "--epsilon", "--max-usd", "--repeats", "--skill", "--split"]),
  ],
  ["skillpack", new Set(["--dir", "--json", "--out"])],
  [
    "migrate-engine",
    new Set([
      "--allow-dropped-columns", "--batch-size", "--dry-run", "--from", "--pglite-path", "--postgres-url",
      "--tables", "--to", "--to-pglite-path", "--verify-only",
    ]),
  ],
  [
    "auth",
    new Set([
      "--access-ttl", "--bound-slug-prefixes", "--client", "--client-file", "--dry-run",
      "--expect-operator", "--expect-source", "--expect-version",
      "--expected-revision", "--federated-read", "--grant", "--grant-types", "--json",
      "--label", "--limit", "--purge", "--redirect-uris", "--refresh-ttl", "--replaces", "--scopes", "--source",
      "--takes-holders", "--tenant-mode", "--token",
      "--token-endpoint-auth-method", "--token-file", "--ttl",
    ]),
  ],
  [
    "search",
    new Set(["--apply", "--days", "--explain", "--json", "--k", "--source", "--target"]),
  ],
  ["config", new Set(["--force", "--pattern"])],
  [
    "capture",
    new Set([
      "--depth", "--file", "--json", "--kind", "--slug", "--source", "--stdin",
      "--title", "--type", "--what", "--where", "--who",
    ]),
  ],
  [
    "quarantine",
    new Set(["--apply", "--force", "--include-flagged", "--json", "--limit"]),
  ],
  [
    "transcripts",
    new Set([
      "--dry-run", "--facts", "--format", "--hook-stdin", "--json", "--max-cost-usd", "--no-embed", "--since",
      "--source", "--token-file", "--url",
    ]),
  ],
  ["connectors", new Set(["--dry-run", "--full", "--json", "--source", "--token-file"])],
  ["version", new Set<string>()],
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
  [
    "--dry-run",
    new Set([
      "apply-migrations", "auth", "embed", "extract", "jobs", "lint",
      "connectors", "migrate-engine", "reindex", "skillify", "transcripts",
    ]),
  ],
  ["--apply", new Set(["eval-prune", "page-retype", "quarantine", "search"])],
  ["--fix", new Set(["lint"])],
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
  for (const flag of seen) {
    if (UNIVERSAL_FLAGS.has(flag)) continue;
    if (accepted === undefined ? KNOWN_FLAGS.has(flag) : accepted.has(flag)) continue;
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
