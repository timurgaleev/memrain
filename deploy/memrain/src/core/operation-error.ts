/**
 * Structured, agent-consumable error envelope for MCP operations.
 *
 * Raw `Error().message` strings lose signal: the agent (the MCP client) can't
 * tell a retryable storage hiccup from a fatal bad-param, and gets no recovery
 * hint. `OperationError` carries a stable machine code, a human message, and
 * optional `suggestion` / `docs` so the caller can act.
 *
 * The PUBLIC-INGRESS redaction contract (`toEnvelope`): on the public boundary the
 * free-text `message` is withheld — it is the only field that could carry
 * runtime-interpolated detail — while the constrained `error` code and the
 * author-authored static `suggestion` / `docs` pass through. So a public
 * caller still learns the error CATEGORY and how to recover, but never a
 * free-text string that might embed internal detail. Internal ingress gets the
 * full envelope including `message`.
 *
 * INVARIANT (enforced by review): an `OperationError` is for KNOWN, validated
 * conditions (bad params, not-found, unsupported mode). Never wrap a raw caught
 * exception's `.message` into one — that would route un-redacted exception text
 * (Postgres detail, DSN host, stack internals) through the structured path. Raw
 * exceptions must stay on the `publicSafeErrorMessage` path, which fully
 * redacts them on public ingress.
 */

/** Stable codes for structured operation errors; additions are an explicit contract change. */
export const OPERATION_ERROR_CODES = [
  "budget_exhausted",
  "conflict",
  "db_busy",
  "db_timeout",
  "embedding_failed",
  "edit_invalid",
  "edit_no_match",
  "edit_ambiguous_match",
  "edit_protected_span",
  "importer_managed",
  "insufficient_scope",
  "invalid_params",
  "link_interval_conflict",
  "mass_delete_refused",
  "not_found",
  "page_shrink_refused",
  "permission_denied",
  "precondition_required",
  "rate_limited",
  "request_in_progress",
  "result_too_large",
  "root_missing",
  "storage_error",
  "unsupported",
  "version_conflict",
  "version_not_found",
] as const;

export type OperationErrorCode = typeof OPERATION_ERROR_CODES[number];

/**
 * What kind of failure a code is, so a caller can decide without knowing every
 * code: fix the request, get access, re-read state, wait, or report a bug.
 */
export type OperationErrorClass =
  | "invalid_request"
  | "permission"
  | "not_found"
  | "conflict"
  | "refused"
  | "limit"
  | "transient";

export interface OperationErrorTraits {
  errorClass: OperationErrorClass;
  /** True when sending the SAME request again later can succeed. */
  retryable: boolean;
}

// A Record over the code union, so adding a code without classifying it fails
// the typecheck. `version_conflict` and `budget_exhausted` are not retryable:
// the same request fails again until the caller re-reads or the cap resets.
const OPERATION_ERROR_TRAITS: Record<OperationErrorCode, OperationErrorTraits> = {
  budget_exhausted: { errorClass: "limit", retryable: false },
  conflict: { errorClass: "conflict", retryable: false },
  db_busy: { errorClass: "transient", retryable: true },
  db_timeout: { errorClass: "transient", retryable: true },
  embedding_failed: { errorClass: "transient", retryable: true },
  edit_invalid: { errorClass: "invalid_request", retryable: false },
  edit_no_match: { errorClass: "invalid_request", retryable: false },
  edit_ambiguous_match: { errorClass: "invalid_request", retryable: false },
  edit_protected_span: { errorClass: "invalid_request", retryable: false },
  importer_managed: { errorClass: "refused", retryable: false },
  insufficient_scope: { errorClass: "permission", retryable: false },
  invalid_params: { errorClass: "invalid_request", retryable: false },
  mass_delete_refused: { errorClass: "refused", retryable: false },
  not_found: { errorClass: "not_found", retryable: false },
  page_shrink_refused: { errorClass: "refused", retryable: false },
  permission_denied: { errorClass: "permission", retryable: false },
  precondition_required: { errorClass: "invalid_request", retryable: false },
  rate_limited: { errorClass: "limit", retryable: true },
  request_in_progress: { errorClass: "conflict", retryable: true },
  result_too_large: { errorClass: "invalid_request", retryable: false },
  root_missing: { errorClass: "not_found", retryable: false },
  storage_error: { errorClass: "transient", retryable: true },
  unsupported: { errorClass: "invalid_request", retryable: false },
  version_conflict: { errorClass: "conflict", retryable: false },
  version_not_found: { errorClass: "not_found", retryable: false },
};

export function operationErrorTraits(code: OperationErrorCode): OperationErrorTraits {
  return OPERATION_ERROR_TRAITS[code];
}

/** Public envelope: no free-text `message` (withheld on the public boundary). */
export interface PublicErrorEnvelope {
  error: OperationErrorCode;
  error_class: OperationErrorClass;
  retryable: boolean;
  suggestion?: string;
  docs?: string;
}

/** Internal envelope: the full detail, including the human `message`. */
export interface InternalErrorEnvelope extends PublicErrorEnvelope {
  message: string;
}

export class OperationError extends Error {
  constructor(
    public readonly code: OperationErrorCode,
    message: string,
    public readonly suggestion?: string,
    public readonly docs?: string,
  ) {
    super(message);
    this.name = "OperationError";
  }

  /**
   * Render the envelope for the given trust boundary. Public ingress withholds
   * the free-text `message`; internal ingress includes it. Undefined optional
   * fields are omitted so the JSON stays tight.
   */
  toEnvelope(isPublic: boolean): PublicErrorEnvelope | InternalErrorEnvelope {
    const { errorClass, retryable } = operationErrorTraits(this.code);
    const base: PublicErrorEnvelope = { error: this.code, error_class: errorClass, retryable };
    if (this.suggestion !== undefined) base.suggestion = this.suggestion;
    if (this.docs !== undefined) base.docs = this.docs;
    if (isPublic) return base;
    return { ...base, message: this.message };
  }
}

/**
 * A slug lookup that found no page the caller may see. The message names only
 * the slug; the MCP dispatcher adds slug suggestions scoped to the caller
 * before rendering (see core/slug-suggest.ts). `suggestion` here stays static.
 */
export class PageNotFoundError extends OperationError {
  constructor(
    public readonly slug: string,
    suggestion?: string,
  ) {
    super("not_found", `page not found: ${slug}`, suggestion);
    this.name = "PageNotFoundError";
  }
}

export function isOperationError(e: unknown): e is OperationError {
  return e instanceof OperationError;
}
