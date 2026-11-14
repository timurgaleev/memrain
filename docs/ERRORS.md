# Error codes

<!-- Generated from deploy/memrain/src/core/operation-error.ts and operation-error-docs.ts.
     Do not edit by hand: run `bun scripts/gen-catalogs.ts` in deploy/memrain. -->

Every structured error Memrain returns carries one of these codes. An MCP tool
error has it in `error`, next to `error_class`, `retryable` and often a
`suggestion`. A CLI command run with `--json` reports it as `error.code`, with a
`docs` link to the entry below.

- **Class** says what kind of failure it is, so a caller can act without
  knowing every code.
- **Retryable** is `yes` when sending the same request again later can succeed.
- **CLI exit** is the exit code of a `memrain` command that fails with this
  code: 2 for an invalid request, 75 for a retryable failure, 1 otherwise.

## Classes

| Class | What to do |
|---|---|
| invalid_request | Fix the request; sending it again unchanged fails the same way. |
| permission | Get access: a different credential or a wider grant. |
| not_found | Check the name or your sources; the object is missing or not visible to you. |
| conflict | Re-read the current state, then retry against it. |
| refused | A safety check stopped the change; confirm the intent explicitly or take the suggested path. |
| limit | A cap or rate was reached; wait, or reduce what you ask for. |
| transient | A passing failure; retry later. |

## All codes

| Code | Class | Retryable | CLI exit | Meaning |
|---|---|---|---|---|
| [`budget_exhausted`](#budget_exhausted) | limit | no | 1 | A spending cap would be exceeded |
| [`conflict`](#conflict) | conflict | no | 1 | The state changed under the request |
| [`db_busy`](#db_busy) | transient | yes | 75 | The database is temporarily busy |
| [`db_timeout`](#db_timeout) | transient | yes | 75 | The database request timed out |
| [`edit_ambiguous_match`](#edit_ambiguous_match) | invalid_request | no | 2 | The text to replace appears more than once |
| [`edit_invalid`](#edit_invalid) | invalid_request | no | 2 | The page edit is malformed |
| [`edit_no_match`](#edit_no_match) | invalid_request | no | 2 | The text to replace is not on the page |
| [`edit_protected_span`](#edit_protected_span) | invalid_request | no | 2 | The edit touches a protected part of the page |
| [`embedding_failed`](#embedding_failed) | transient | yes | 75 | The embedding call failed |
| [`importer_managed`](#importer_managed) | refused | no | 1 | An importer owns this page |
| [`insufficient_scope`](#insufficient_scope) | permission | no | 1 | The credential lacks the required scope |
| [`invalid_params`](#invalid_params) | invalid_request | no | 2 | The request's arguments are invalid |
| [`link_interval_conflict`](#link_interval_conflict) | conflict | no | 1 | The link's dates overlap a recorded value |
| [`mass_delete_refused`](#mass_delete_refused) | refused | no | 1 | Too many deletions at once |
| [`not_found`](#not_found) | not_found | no | 1 | Nothing by that name is visible to you |
| [`page_shrink_refused`](#page_shrink_refused) | refused | no | 1 | The write would shrink the page sharply |
| [`page_too_large`](#page_too_large) | invalid_request | no | 2 | The page body is over the size limit |
| [`permission_denied`](#permission_denied) | permission | no | 1 | This credential may not do that |
| [`precondition_required`](#precondition_required) | invalid_request | no | 2 | The overwrite must name the version it read |
| [`rate_limited`](#rate_limited) | limit | yes | 75 | Too many requests |
| [`request_in_progress`](#request_in_progress) | conflict | yes | 75 | A call with this request_id is still running |
| [`result_too_large`](#result_too_large) | invalid_request | no | 2 | The result is over the response size limit |
| [`root_missing`](#root_missing) | not_found | no | 1 | The directory does not exist |
| [`storage_error`](#storage_error) | transient | yes | 75 | The storage layer failed |
| [`unsupported`](#unsupported) | invalid_request | no | 2 | This is not supported here |
| [`version_conflict`](#version_conflict) | conflict | no | 1 | The page changed since you read it |
| [`version_not_found`](#version_not_found) | not_found | no | 1 | That page version does not exist |

## Codes

### budget_exhausted

**A spending cap would be exceeded.** Class: limit. Retryable: no. CLI exit: 1.

**What happened.** The call needs a paid model, and the daily or per-client spending cap has no room for it — or the model has no registered price, so its cost cannot be bounded and the call is refused before it is sent.

**What to do.** Check today's spend with `memrain spend`. Wait for the cap window to reset, raise the cap on purpose, or send a smaller request. For an unpriced model, register its price or use a priced one. Retrying the same request will fail again until one of these changes.

### conflict

**The state changed under the request.** Class: conflict. Retryable: no. CLI exit: 1.

**What happened.** The request collided with the current state: an import or sync was held because the page carries a person's edit (`authored_edit`) or its source is busy (`source_busy`), or a confirmed plan no longer matches the data its preview saw.

**What to do.** Read the message for which case it is. For a held import, wait for the source to settle or reconcile the authored edit, then run it again. For a plan, preview again and pass the new `plan_hash`.

### db_busy

**The database is temporarily busy.** Class: transient. Retryable: yes. CLI exit: 75.

**What happened.** A lock, a serialization conflict, a deadlock or a dropped connection stopped the request. Nothing was committed.

**What to do.** Retry the same request after a short wait. If the request carried a `request_id`, retry with the same one so a write is not applied twice.

### db_timeout

**The database request timed out.** Class: transient. Retryable: yes. CLI exit: 75.

**What happened.** The statement ran past the database statement timeout and was cancelled. Nothing was committed.

**What to do.** Retry later, or narrow the request (smaller `limit`, tighter filters). Repeated timeouts on a small request point at load on the database — check `memrain doctor`.

### edit_ambiguous_match

**The text to replace appears more than once.** Class: invalid_request. Retryable: no. CLI exit: 2.

**What happened.** An edit's `old_text` matches several places on the page, so the edit cannot tell which one to change.

**What to do.** Include more surrounding text in `old_text` so it matches exactly once.

### edit_invalid

**The page edit is malformed.** Class: invalid_request. Retryable: no. CLI exit: 2.

**What happened.** The `page_edit` arguments do not describe a valid edit: `edits` must be an array of 1 to 50 objects of exactly `{old_text, new_text}`, with a non-empty `old_text`.

**What to do.** Correct the edit arguments as the message describes and send it again.

### edit_no_match

**The text to replace is not on the page.** Class: invalid_request. Retryable: no. CLI exit: 2.

**What happened.** `page_edit` could not find an edit's `old_text` in the page body. The page may have changed since it was read, or an earlier edit in the same call already changed that text.

**What to do.** Read the page again with `page_get`, copy the exact current text (whitespace included) into `old_text`, and retry.

### edit_protected_span

**The edit touches a protected part of the page.** Class: invalid_request. Retryable: no. CLI exit: 2.

**What happened.** The edit would touch, create or change a facts or takes fence — the blocks the server keeps for structured facts and takes, which `page_edit` may not rewrite.

**What to do.** Quote only ordinary page text in `old_text`. Write facts with `add_fact` / `forget_fact` and takes with the takes tools.

### embedding_failed

**The embedding call failed.** Class: transient. Retryable: yes. CLI exit: 75.

**What happened.** The embedding provider did not return a vector for the text, usually because of a transient provider or network error.

**What to do.** Retry the request. If it keeps failing, check the embedding provider's credentials and region with `memrain doctor`.

### importer_managed

**An importer owns this page.** Class: refused. Retryable: no. CLI exit: 1.

**What happened.** The page's slug belongs to a source an importer keeps in sync, so a local rename or change would be undone by the next import.

**What to do.** Make the change in the upstream source the importer reads; the next import brings it in.

### insufficient_scope

**The credential lacks the required scope.** Class: permission. Retryable: no. CLI exit: 1.

**What happened.** The client is authenticated, but its grant does not include the scope this tool needs (for example `write`, `admin` or `agent`).

**What to do.** Ask the operator for a client granted the scope named in the message, or use a tool your grant covers.

### invalid_params

**The request's arguments are invalid.** Class: invalid_request. Retryable: no. CLI exit: 2.

**What happened.** An argument is missing, has the wrong type, is out of range, or is not an argument of this tool.

**What to do.** Read the `suggestion` and `message`, correct the arguments (docs/TOOLS.md lists each tool's parameters) and send the request again.

### link_interval_conflict

**The link's dates overlap a recorded value.** Class: conflict. Retryable: no. CLI exit: 1.

**What happened.** A dated, single-valued link already records a different target for an overlapping period, or a dated history needs a `valid_from` the request did not give.

**What to do.** List the recorded intervals with `get_links`, then pick dates that do not overlap them.

### mass_delete_refused

**Too many deletions at once.** Class: refused. Retryable: no. CLI exit: 1.

**What happened.** Reconciling deletions found a large share of the documents under a root missing on disk, which more often means an unmounted or moved directory than a real deletion.

**What to do.** Check that the directory is mounted and complete. If the deletions are real, run again with `--allow-mass-delete`.

### not_found

**Nothing by that name is visible to you.** Class: not_found. Retryable: no. CLI exit: 1.

**What happened.** The page, job, source or other object does not exist, or exists outside the sources your credential can read.

**What to do.** Check the name; the error may carry close matches. Use `search` or `page_list` to find the right slug.

### page_shrink_refused

**The write would shrink the page sharply.** Class: refused. Retryable: no. CLI exit: 1.

**What happened.** A full-body write would replace a much larger stored body with a much smaller one, which usually means a truncated draft rather than an intended rewrite.

**What to do.** Use `page_edit` or `page_append` for a partial change. To replace the body on purpose, pass `allow_shrink: true`.

### page_too_large

**The page body is over the size limit.** Class: invalid_request. Retryable: no. CLI exit: 2.

**What happened.** The body is larger than the configured page size cap (`MEMRAIN_PAGE_MAX_BYTES`).

**What to do.** Split the content across several pages (for example `<slug>/part-001`, `part-002`) with a short contents page linking them.

### permission_denied

**This credential may not do that.** Class: permission. Retryable: no. CLI exit: 1.

**What happened.** The request reaches a source or page outside the caller's grant, or the caller has no source it may write to.

**What to do.** Use a source your grant covers, or ask the operator to widen the grant.

### precondition_required

**The overwrite must name the version it read.** Class: invalid_request. Retryable: no. CLI exit: 2.

**What happened.** The brain requires conditional writes, and this write would overwrite an existing page without `expected_version`. The error carries `current_version`.

**What to do.** Read the page with `page_get`, then pass its version as `expected_version`, or pass `force: true` to overwrite on purpose.

### rate_limited

**Too many requests.** Class: limit. Retryable: yes. CLI exit: 75.

**What happened.** The caller or the upstream provider is over its request rate.

**What to do.** Wait and retry with backoff.

### request_in_progress

**A call with this request_id is still running.** Class: conflict. Retryable: yes. CLI exit: 75.

**What happened.** An earlier call with the same `request_id` has claimed the write and has not finished yet.

**What to do.** Retry shortly with the same `request_id` and arguments; you receive the first call's result instead of a second write.

### result_too_large

**The result is over the response size limit.** Class: invalid_request. Retryable: no. CLI exit: 2.

**What happened.** The serialized result is larger than `MEMRAIN_MCP_MAX_RESULT_BYTES`.

**What to do.** Lower `limit` or narrow the query. For `page_list` and `page_versions` pass `include_body: false`, then read single pages with `page_get`.

### root_missing

**The directory does not exist.** Class: not_found. Retryable: no. CLI exit: 1.

**What happened.** The root a command was pointed at is not an existing directory, so it refuses to compare documents against it.

**What to do.** Check the path and that the volume is mounted, then run again.

### storage_error

**The storage layer failed.** Class: transient. Retryable: yes. CLI exit: 75.

**What happened.** A storage operation failed for a reason that may pass, such as an unavailable volume or connection.

**What to do.** Retry later. If it persists, check `memrain doctor` and the server logs.

### unsupported

**This is not supported here.** Class: invalid_request. Retryable: no. CLI exit: 2.

**What happened.** The mode, option or tool is not available in this configuration — for example a model call while `MEMRAIN_KEYWORD_ONLY` is on, or an option this tool does not offer.

**What to do.** Use a supported option (the message names it), or change the configuration that disables the feature.

### version_conflict

**The page changed since you read it.** Class: conflict. Retryable: no. CLI exit: 1.

**What happened.** A conditional write named an `expected_version`, but the page is now at a newer version. Nothing was written. The error carries `current_version`.

**What to do.** Re-read the page with `page_get` (or `page_versions`), reconcile the changes, and retry with the current version — or pass `force: true` to overwrite on purpose.

### version_not_found

**That page version does not exist.** Class: not_found. Retryable: no. CLI exit: 1.

**What happened.** The requested version number is not in the page's history.

**What to do.** List the versions with `page_versions` and pick one that exists.
