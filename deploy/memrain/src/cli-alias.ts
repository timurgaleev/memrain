/**
 * The command name the CLI was started under.
 *
 * `package.json` installs the entrypoint as `memrain` and, through 0.1.x, also
 * as the pre-rename `memex`. Starting it as `memex` still works; it only prints
 * one deprecation line on stderr. The alias goes away in 0.2.0.
 */
import { basename } from "node:path";
import { LEGACY_CLI_WORD } from "./core/brand.ts";

export type CliName = "memrain" | typeof LEGACY_CLI_WORD;

type Env = Record<string, string | undefined>;

function commandName(path: string | undefined): string | undefined {
  return path === undefined ? undefined : basename(path).replace(/\.[^.]*$/, "");
}

/**
 * `argv[1]` names the script, but Bun resolves a bin symlink there to the
 * target (`…/src/cli.ts`), so the name the shell ran is taken from `$_`, which
 * the shell sets to the path of the command it starts.
 */
export function invokedAs(argv: readonly string[], env: Env = {}): CliName {
  const names = [commandName(argv[1]), commandName(env._)];
  return names.includes(LEGACY_CLI_WORD) ? LEGACY_CLI_WORD : "memrain";
}

/** The stderr line for a start under the legacy name, else null. Never fatal. */
export function aliasDeprecationLine(argv: readonly string[], env: Env = {}): string | null {
  if (invokedAs(argv, env) !== LEGACY_CLI_WORD) return null;
  return `[memrain] the '${LEGACY_CLI_WORD}' command is deprecated; use 'memrain' (the alias is removed in 0.2.0)`;
}
