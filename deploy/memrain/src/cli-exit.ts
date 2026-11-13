/**
 * CLI exit-code resolution.
 *
 * A command can signal failure two ways: by RETURNING a non-zero code from its
 * cli case (usage errors), or by setting `process.exitCode = 1` while still
 * returning 0 (the `doctor` / `lint` / `integrity` / `eval` style — they print
 * a report and flag failure out-of-band). The entrypoint must honour BOTH.
 *
 * The bug this fixes: calling `process.exit(0)` with an explicit `0` argument
 * OVERRIDES any `process.exitCode` a command set, so `memrain doctor` exited 0
 * even when a check failed — silently breaking its documented "exits 1 on any
 * failure" cron/CI contract (and the same for every other exitCode-setting
 * command). Resolving the final code here, with an explicit non-zero return
 * winning and `process.exitCode` honoured otherwise, repairs all of them at
 * once.
 *
 * A command that THROWS ends in `exitCodeForError` instead: a structured error
 * maps to the documented contract (2 invalid request, 75 retryable, 1 other),
 * while codes a command returns itself (eval's stale-qrels 2, `status
 * --quiescent` 3) keep their own meaning through `resolveExitCode`.
 */
import { databaseOperationError } from "./core/database-error.ts";
import { isOperationError, operationErrorTraits } from "./core/operation-error.ts";

/** sysexits.h EX_TEMPFAIL: the same command may succeed if run again later. */
export const EXIT_TEMPFAIL = 75;
export const EXIT_USAGE = 2;

/**
 * Resolve the process exit code: an explicit non-zero return wins; otherwise
 * fall through to `process.exitCode` (a command-signalled failure), defaulting
 * to 0.
 */
export function resolveExitCode(
  returnedCode: number,
  processExitCode: number | string | undefined,
): number {
  if (returnedCode !== 0) return returnedCode;
  const pe =
    typeof processExitCode === "number"
      ? processExitCode
      : Number(processExitCode);
  return Number.isInteger(pe) && pe !== 0 ? pe : 0;
}

/** Exit code for an error that escaped a command. */
export function exitCodeForError(err: unknown): number {
  const structured = isOperationError(err) ? err : databaseOperationError(err);
  if (!structured) return 1;
  const { errorClass, retryable } = operationErrorTraits(structured.code);
  if (errorClass === "invalid_request") return EXIT_USAGE;
  return retryable ? EXIT_TEMPFAIL : 1;
}
