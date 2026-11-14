/**
 * What each operation error code means and what to do about it — the source
 * of docs/ERRORS.md (rendered by renderErrorCatalog, written by
 * scripts/gen-catalogs.ts, pinned by tests/error_catalog.test.ts).
 *
 * A Record over the code union, so a code added to OPERATION_ERROR_CODES
 * without an entry here fails the typecheck. Class and retryability are not
 * repeated: they come from the registry's own traits when the page renders.
 */
import { exitCodeForError } from "../cli-exit.ts";
import {
  OPERATION_ERROR_CODES,
  OperationError,
  operationErrorTraits,
  type OperationErrorClass,
  type OperationErrorCode,
} from "./operation-error.ts";

export interface OperationErrorDoc {
  /** One line, sentence case, no trailing period. */
  title: string;
  /** What the server saw. */
  cause: string;
  /** What the caller should do next. */
  fix: string;
}

export const OPERATION_ERROR_DOCS: Record<OperationErrorCode, OperationErrorDoc> = {
  budget_exhausted: {
    title: "A spending cap would be exceeded",
    cause: "The call needs a paid model, and the daily or per-client spending cap has no room for it — or the model has no registered price, so its cost cannot be bounded and the call is refused before it is sent.",
    fix: "Check today's spend with `memrain spend`. Wait for the cap window to reset, raise the cap on purpose, or send a smaller request. For an unpriced model, register its price or use a priced one. Retrying the same request will fail again until one of these changes.",
  },
  conflict: {
    title: "The state changed under the request",
    cause: "The request collided with the current state: an import or sync was held because the page carries a person's edit (`authored_edit`) or its source is busy (`source_busy`), or a confirmed plan no longer matches the data its preview saw.",
    fix: "Read the message for which case it is. For a held import, wait for the source to settle or reconcile the authored edit, then run it again. For a plan, preview again and pass the new `plan_hash`.",
  },
  db_busy: {
    title: "The database is temporarily busy",
    cause: "A lock, a serialization conflict, a deadlock or a dropped connection stopped the request. Nothing was committed.",
    fix: "Retry the same request after a short wait. If the request carried a `request_id`, retry with the same one so a write is not applied twice.",
  },
  db_timeout: {
    title: "The database request timed out",
    cause: "The statement ran past the database statement timeout and was cancelled. Nothing was committed.",
    fix: "Retry later, or narrow the request (smaller `limit`, tighter filters). Repeated timeouts on a small request point at load on the database — check `memrain doctor`.",
  },
  embedding_failed: {
    title: "The embedding call failed",
    cause: "The embedding provider did not return a vector for the text, usually because of a transient provider or network error.",
    fix: "Retry the request. If it keeps failing, check the embedding provider's credentials and region with `memrain doctor`.",
  },
  edit_invalid: {
    title: "The page edit is malformed",
    cause: "The `page_edit` arguments do not describe a valid edit: `edits` must be an array of 1 to 50 objects of exactly `{old_text, new_text}`, with a non-empty `old_text`.",
    fix: "Correct the edit arguments as the message describes and send it again.",
  },
  edit_no_match: {
    title: "The text to replace is not on the page",
    cause: "`page_edit` could not find an edit's `old_text` in the page body. The page may have changed since it was read, or an earlier edit in the same call already changed that text.",
    fix: "Read the page again with `page_get`, copy the exact current text (whitespace included) into `old_text`, and retry.",
  },
  edit_ambiguous_match: {
    title: "The text to replace appears more than once",
    cause: "An edit's `old_text` matches several places on the page, so the edit cannot tell which one to change.",
    fix: "Include more surrounding text in `old_text` so it matches exactly once.",
  },
  edit_protected_span: {
    title: "The edit touches a protected part of the page",
    cause: "The edit would touch, create or change a facts or takes fence — the blocks the server keeps for structured facts and takes, which `page_edit` may not rewrite.",
    fix: "Quote only ordinary page text in `old_text`. Write facts with `add_fact` / `forget_fact` and takes with the takes tools.",
  },
  importer_managed: {
    title: "An importer owns this page",
    cause: "The page's slug belongs to a source an importer keeps in sync, so a local rename or change would be undone by the next import.",
    fix: "Make the change in the upstream source the importer reads; the next import brings it in.",
  },
  insufficient_scope: {
    title: "The credential lacks the required scope",
    cause: "The client is authenticated, but its grant does not include the scope this tool needs (for example `write`, `admin` or `agent`).",
    fix: "Ask the operator for a client granted the scope named in the message, or use a tool your grant covers.",
  },
  invalid_params: {
    title: "The request's arguments are invalid",
    cause: "An argument is missing, has the wrong type, is out of range, or is not an argument of this tool.",
    fix: "Read the `suggestion` and `message`, correct the arguments (docs/TOOLS.md lists each tool's parameters) and send the request again.",
  },
  link_interval_conflict: {
    title: "The link's dates overlap a recorded value",
    cause: "A dated, single-valued link already records a different target for an overlapping period, or a dated history needs a `valid_from` the request did not give.",
    fix: "List the recorded intervals with `get_links`, then pick dates that do not overlap them.",
  },
  mass_delete_refused: {
    title: "Too many deletions at once",
    cause: "Reconciling deletions found a large share of the documents under a root missing on disk, which more often means an unmounted or moved directory than a real deletion.",
    fix: "Check that the directory is mounted and complete. If the deletions are real, run again with `--allow-mass-delete`.",
  },
  not_found: {
    title: "Nothing by that name is visible to you",
    cause: "The page, job, source or other object does not exist, or exists outside the sources your credential can read.",
    fix: "Check the name; the error may carry close matches. Use `search` or `page_list` to find the right slug.",
  },
  page_shrink_refused: {
    title: "The write would shrink the page sharply",
    cause: "A full-body write would replace a much larger stored body with a much smaller one, which usually means a truncated draft rather than an intended rewrite.",
    fix: "Use `page_edit` or `page_append` for a partial change. To replace the body on purpose, pass `allow_shrink: true`.",
  },
  page_too_large: {
    title: "The page body is over the size limit",
    cause: "The body is larger than the configured page size cap (`MEMRAIN_PAGE_MAX_BYTES`).",
    fix: "Split the content across several pages (for example `<slug>/part-001`, `part-002`) with a short contents page linking them.",
  },
  permission_denied: {
    title: "This credential may not do that",
    cause: "The request reaches a source or page outside the caller's grant, or the caller has no source it may write to.",
    fix: "Use a source your grant covers, or ask the operator to widen the grant.",
  },
  precondition_required: {
    title: "The overwrite must name the version it read",
    cause: "The brain requires conditional writes, and this write would overwrite an existing page without `expected_version`. The error carries `current_version`.",
    fix: "Read the page with `page_get`, then pass its version as `expected_version`, or pass `force: true` to overwrite on purpose.",
  },
  rate_limited: {
    title: "Too many requests",
    cause: "The caller or the upstream provider is over its request rate.",
    fix: "Wait and retry with backoff.",
  },
  request_in_progress: {
    title: "A call with this request_id is still running",
    cause: "An earlier call with the same `request_id` has claimed the write and has not finished yet.",
    fix: "Retry shortly with the same `request_id` and arguments; you receive the first call's result instead of a second write.",
  },
  result_too_large: {
    title: "The result is over the response size limit",
    cause: "The serialized result is larger than `MEMRAIN_MCP_MAX_RESULT_BYTES`.",
    fix: "Lower `limit` or narrow the query. For `page_list` and `page_versions` pass `include_body: false`, then read single pages with `page_get`.",
  },
  root_missing: {
    title: "The directory does not exist",
    cause: "The root a command was pointed at is not an existing directory, so it refuses to compare documents against it.",
    fix: "Check the path and that the volume is mounted, then run again.",
  },
  storage_error: {
    title: "The storage layer failed",
    cause: "A storage operation failed for a reason that may pass, such as an unavailable volume or connection.",
    fix: "Retry later. If it persists, check `memrain doctor` and the server logs.",
  },
  unsupported: {
    title: "This is not supported here",
    cause: "The mode, option or tool is not available in this configuration — for example a model call while `MEMRAIN_KEYWORD_ONLY` is on, or an option this tool does not offer.",
    fix: "Use a supported option (the message names it), or change the configuration that disables the feature.",
  },
  version_conflict: {
    title: "The page changed since you read it",
    cause: "A conditional write named an `expected_version`, but the page is now at a newer version. Nothing was written. The error carries `current_version`.",
    fix: "Re-read the page with `page_get` (or `page_versions`), reconcile the changes, and retry with the current version — or pass `force: true` to overwrite on purpose.",
  },
  version_not_found: {
    title: "That page version does not exist",
    cause: "The requested version number is not in the page's history.",
    fix: "List the versions with `page_versions` and pick one that exists.",
  },
};

const CLASS_MEANING: Record<OperationErrorClass, string> = {
  invalid_request: "Fix the request; sending it again unchanged fails the same way.",
  permission: "Get access: a different credential or a wider grant.",
  not_found: "Check the name or your sources; the object is missing or not visible to you.",
  conflict: "Re-read the current state, then retry against it.",
  refused: "A safety check stopped the change; confirm the intent explicitly or take the suggested path.",
  limit: "A cap or rate was reached; wait, or reduce what you ask for.",
  transient: "A passing failure; retry later.",
};

function cliExit(code: OperationErrorCode): number {
  return exitCodeForError(new OperationError(code, code));
}

/** docs/ERRORS.md, byte for byte. */
export function renderErrorCatalog(): string {
  const codes = [...OPERATION_ERROR_CODES].sort();
  const out: string[] = [
    "# Error codes",
    "",
    "<!-- Generated from deploy/memrain/src/core/operation-error.ts and operation-error-docs.ts.",
    "     Do not edit by hand: run `bun scripts/gen-catalogs.ts` in deploy/memrain. -->",
    "",
    "Every structured error Memrain returns carries one of these codes. An MCP tool",
    "error has it in `error`, next to `error_class`, `retryable` and often a",
    "`suggestion`. A CLI command run with `--json` reports it as `error.code`, with a",
    "`docs` link to the entry below.",
    "",
    "- **Class** says what kind of failure it is, so a caller can act without",
    "  knowing every code.",
    "- **Retryable** is `yes` when sending the same request again later can succeed.",
    "- **CLI exit** is the exit code of a `memrain` command that fails with this",
    "  code: 2 for an invalid request, 75 for a retryable failure, 1 otherwise.",
    "",
    "## Classes",
    "",
    "| Class | What to do |",
    "|---|---|",
    ...(Object.keys(CLASS_MEANING) as OperationErrorClass[]).map((c) => `| ${c} | ${CLASS_MEANING[c]} |`),
    "",
    "## All codes",
    "",
    "| Code | Class | Retryable | CLI exit | Meaning |",
    "|---|---|---|---|---|",
    ...codes.map((code) => {
      const { errorClass, retryable } = operationErrorTraits(code);
      return `| [\`${code}\`](#${code}) | ${errorClass} | ${retryable ? "yes" : "no"} | ${cliExit(code)} | ${OPERATION_ERROR_DOCS[code].title} |`;
    }),
    "",
    "## Codes",
  ];
  for (const code of codes) {
    const { errorClass, retryable } = operationErrorTraits(code);
    const doc = OPERATION_ERROR_DOCS[code];
    out.push(
      "",
      `### ${code}`,
      "",
      `**${doc.title}.** Class: ${errorClass}. Retryable: ${retryable ? "yes" : "no"}. CLI exit: ${cliExit(code)}.`,
      "",
      `**What happened.** ${doc.cause}`,
      "",
      `**What to do.** ${doc.fix}`,
    );
  }
  return `${out.join("\n")}\n`;
}
