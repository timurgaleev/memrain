import { OperationError } from "./operation-error.ts";
import { isDeadlockError, isRetryableConnError, isStatementTimeoutError } from "./retry.ts";

class DatabaseOperationError extends OperationError {
  constructor(code: "db_busy" | "db_timeout", private readonly sqlstate?: string) {
    super(code, code === "db_timeout" ? "The database request timed out." : "The database is temporarily unavailable.",
      "Retry with the same request_id if one was supplied.");
  }

  override toEnvelope(isPublic: boolean) {
    return { ...super.toEnvelope(isPublic), retryable: true,
      ...(this.sqlstate ? { sqlstate: this.sqlstate } : {}) };
  }
}

/** Classify transient failures without carrying database text across the MCP boundary. */
export function databaseOperationError(error: unknown): OperationError | null {
  const raw = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const sqlstate = /^[0-9A-Z]{5}$/.test(raw) ? raw : undefined;
  if (isStatementTimeoutError(error)) return new DatabaseOperationError("db_timeout", sqlstate);
  if (raw === "55P03" || raw === "40001" || isDeadlockError(error) || isRetryableConnError(error)) {
    return new DatabaseOperationError("db_busy", sqlstate);
  }
  return null;
}
