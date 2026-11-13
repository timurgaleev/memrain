/**
 * CLI exit-code resolution — an explicit non-zero return wins; otherwise the
 * out-of-band `process.exitCode` is honoured (so doctor/lint/integrity, which
 * set it while returning 0 from their case, actually exit non-zero).
 */
import { describe, expect, it } from "bun:test";
import { exitCodeForError, resolveExitCode } from "../src/cli-exit.ts";
import { OperationError } from "../src/core/operation-error.ts";

describe("resolveExitCode", () => {
  it("returns the explicit code when the command returned non-zero", () => {
    expect(resolveExitCode(1, undefined)).toBe(1);
    expect(resolveExitCode(2, undefined)).toBe(2);
    // An explicit non-zero return wins even over a set process.exitCode.
    expect(resolveExitCode(2, 1)).toBe(2);
  });

  it("honours process.exitCode when the command returned 0", () => {
    // THE bug: doctor returns 0 from its case but sets process.exitCode=1.
    expect(resolveExitCode(0, 1)).toBe(1);
  });

  it("is 0 when neither signals failure", () => {
    expect(resolveExitCode(0, undefined)).toBe(0);
    expect(resolveExitCode(0, 0)).toBe(0);
  });

  it("coerces a string process.exitCode and ignores junk", () => {
    expect(resolveExitCode(0, "1")).toBe(1);
    expect(resolveExitCode(0, "")).toBe(0);
    expect(resolveExitCode(0, "nope")).toBe(0);
  });
});

describe("exitCodeForError — structured errors at the CLI boundary", () => {
  it("an invalid request is a usage error (2)", () => {
    expect(exitCodeForError(new OperationError("invalid_params", "bad flag"))).toBe(2);
    expect(exitCodeForError(new OperationError("unsupported", "no such mode"))).toBe(2);
  });

  it("a retryable failure is EX_TEMPFAIL (75)", () => {
    expect(exitCodeForError(new OperationError("storage_error", "reset"))).toBe(75);
    expect(exitCodeForError(new OperationError("rate_limited", "slow down"))).toBe(75);
  });

  it("a transient database failure is EX_TEMPFAIL even before it is wrapped", () => {
    expect(exitCodeForError(Object.assign(new Error("deadlock detected"), { code: "40P01" }))).toBe(75);
    expect(exitCodeForError(Object.assign(new Error("canceling statement"), { code: "57014" }))).toBe(75);
  });

  it("any other failure is 1", () => {
    expect(exitCodeForError(new OperationError("permission_denied", "no"))).toBe(1);
    expect(exitCodeForError(new OperationError("version_conflict", "stale"))).toBe(1);
    expect(exitCodeForError(new Error("boom"))).toBe(1);
    expect(exitCodeForError("string")).toBe(1);
  });

  it("leaves command-specific returned codes alone (eval stale qrels 2, status --quiescent 3)", () => {
    expect(resolveExitCode(2, undefined)).toBe(2);
    expect(resolveExitCode(3, undefined)).toBe(3);
  });
});
