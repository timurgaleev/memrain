/**
 * Put back an exit code saved before a CLI command ran under test. The saved
 * value is usually `undefined`, and Bun ignores `process.exitCode = undefined`,
 * so a 1 set by the command would leak out and fail the whole test run.
 */
export function restoreExitCode(prev: typeof process.exitCode): void {
  process.exitCode = prev ?? 0;
}
