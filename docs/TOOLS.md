# MCP tools

This list is the complete tool surface of this build: 29 tools.

The tools are declared in `deploy/memrain/src/mcp/operations.ts`; the schema a
client receives from `tools/list` is generated from those declarations, so the
parameter tables below match it. A client only sees the tools its credential
may call, so a token may list fewer. Errors come back as JSON with an `error`
code and usually a `suggestion`; the codes are described in
[ERRORS.md](ERRORS.md).

## Who may call what

| Scope | Who may call |
|---|---|
| read | Any credential that can see the brain. Results are limited to the sources the credential may read. |
| write | A credential with a write source. Changes land only in that source. `write` includes `read`. |
| admin | A credential granted the `admin` scope. `admin` includes `write` and `read`. |

Four more gates apply before a tool runs, and `tools/list` leaves out any tool
one of them would refuse (`mcp/visibility.ts`), so a listed tool is never
refused for scope or permission:

- **Operator only.** `stats` and `run_doctor` report brain-wide state and are
  refused to every OAuth client and personal access token. The operator (the
  local CLI and the internal token) keeps them.
- **Static public bearer.** On the public ingress with the static bearer, the
  destructive writes and the reads that return raw text, slugs or tags are
  never available: `get_chunks`, `get_links`, `get_tags`, `page_delete`,
  `page_rename`, `page_restore`, `page_revert`, `purge_deleted_pages`,
  `remove_tag`, `resolve_slugs`, `run_doctor`, `search_exact`, `sources_list`,
  `sources_status`, `stats` and `unlink`. The constructive writes (`index`,
  `page_put`, `page_append`, `page_edit`, `add_tag`, `link`) are open to it
  only with `MEMRAIN_PUBLIC_WRITE=1`. OAuth clients and personal access tokens
  are judged on their scopes instead.
- **Slug-bound clients.** A client with `bound_slug_prefixes` may change only
  slugs under those prefixes. A write tool that names no slug (`index`,
  `purge_deleted_pages`) is refused to it outright.
- **Tool surface.** See [Tool surfaces](#tool-surfaces).

Every tool carries MCP `annotations` derived from its scope: `readOnlyHint` on
reads, and `destructiveHint` / `idempotentHint` on writes, so a client can ask
before it changes anything. No tool reaches outside this brain
(`openWorldHint: false`).

Arguments are checked against the declared types, enums and bounds. An unknown
argument is refused with a did-you-mean hint (`invalid_params`) instead of
being dropped; `MEMRAIN_MCP_LENIENT_ARGS=1` accepts and ignores unknown
arguments for a client that cannot be fixed.

## Tool surfaces

A credential can be narrowed to a smaller set of tools. A surface only ever
narrows what the scopes allow, and a tool off the surface is refused for
`tools/call` as well as hidden from `tools/list`.

| Surface | Tools |
|---|---|
| `full` | Every tool the scopes allow (the default). |
| `starter` | `whoami`, `search`, `search_exact`, `page_get`, `page_list`, `page_put`, `page_edit`, `page_append`, `get_links`, `backlinks`, `resolve_slugs` |
| `verbs` | None. No tool in this build is a memory verb, so a credential on this surface is shown nothing. |

`MEMRAIN_MCP_FORCE_SURFACE=starter` (or `verbs`) clamps every `/mcp`
connection, the operator's included, on top of each credential's own surface.
It never widens one. Unset or `full` is off. The local CLI is not narrowed.

## All tools

| Tool | Scope | Effect | Static public bearer | Operator only |
|---|---|---|---|---|
| [`add_tag`](#add_tag) | write | writes, idempotent | with `MEMRAIN_PUBLIC_WRITE=1` | no |
| [`backlinks`](#backlinks) | read | read-only | yes | no |
| [`get_brain_identity`](#get_brain_identity) | read | read-only | yes | no |
| [`get_chunks`](#get_chunks) | read | read-only | no | no |
| [`get_links`](#get_links) | read | read-only | no | no |
| [`get_tags`](#get_tags) | read | read-only | no | no |
| [`index`](#index) | write | writes, destructive | with `MEMRAIN_PUBLIC_WRITE=1` | no |
| [`link`](#link) | write | writes, idempotent | with `MEMRAIN_PUBLIC_WRITE=1` | no |
| [`page_append`](#page_append) | write | writes | with `MEMRAIN_PUBLIC_WRITE=1` | no |
| [`page_delete`](#page_delete) | write | writes, destructive, idempotent | no | no |
| [`page_edit`](#page_edit) | write | writes, destructive | with `MEMRAIN_PUBLIC_WRITE=1` | no |
| [`page_get`](#page_get) | read | read-only | yes | no |
| [`page_list`](#page_list) | read | read-only | yes | no |
| [`page_put`](#page_put) | write | writes, destructive, idempotent | with `MEMRAIN_PUBLIC_WRITE=1` | no |
| [`page_rename`](#page_rename) | write | writes, destructive | no | no |
| [`page_restore`](#page_restore) | write | writes, idempotent | no | no |
| [`page_revert`](#page_revert) | write | writes, destructive | no | no |
| [`page_versions`](#page_versions) | read | read-only | yes | no |
| [`purge_deleted_pages`](#purge_deleted_pages) | admin | writes, destructive | no | no |
| [`remove_tag`](#remove_tag) | write | writes, destructive, idempotent | no | no |
| [`resolve_slugs`](#resolve_slugs) | read | read-only | no | no |
| [`run_doctor`](#run_doctor) | read | read-only | no | yes |
| [`search`](#search) | read | read-only | yes | no |
| [`search_exact`](#search_exact) | read | read-only | no | no |
| [`sources_list`](#sources_list) | read | read-only | no | no |
| [`sources_status`](#sources_status) | read | read-only | no | no |
| [`stats`](#stats) | read | read-only | no | yes |
| [`unlink`](#unlink) | write | writes, destructive, idempotent | no | no |
| [`whoami`](#whoami) | read | read-only | yes | no |

On the static public bearer, unless `MEMRAIN_PUBLIC_READ_BODIES=1`, page
bodies are left out of read results and `search` drops page hits entirely.

## Writes: what they share

- **Conditional writes.** `page_put`, `page_delete` and `page_revert` take an
  optional `expected_version` (the `version` from `page_get`); `page_edit` and
  `page_rename` require it. The write lands only if the page is still at that
  version; otherwise nothing is written and `version_conflict` carries
  `current_version`. `expected_version: 0` means "the page must not exist yet".
  `force: true` is a deliberate unconditional write and cannot be combined
  with `expected_version`. With `MEMRAIN_REQUIRE_WRITE_PRECONDITION` set, a
  write with neither is warned about or refused (`precondition_required`).
- **Retries.** `page_put`, `page_append` and `page_edit` take an optional
  `request_id` (1 to 128 characters, kept 7 days). A retry with the same id and
  arguments returns the first result with `replayed: true` and writes nothing;
  the same id with other arguments is refused; a retry while the first call
  still runs gets `request_in_progress`.
- **Reasons.** `page_put`, `page_edit`, `page_delete` and `page_revert` take an
  optional one-line `reason` of at most 500 code points. It is trimmed and
  secret-scanned, stored only when a new version is written, and shown as
  `change_reason` in version history.
- **Search mirror.** A page write updates the page's search mirror before it
  returns and reports `search_indexed`. If that step fails, the page is still
  saved and the hourly housekeeping indexes it. `wait_for_index` is accepted
  and has no effect.
- **Safety on the way in.** Every page write is scanned for credentials (a
  found value is replaced by a `[REDACTED:<kind>:<fingerprint>]` marker, and
  the original is sealed when the connector key is set; see
  [HOW-IT-WORKS.md](HOW-IT-WORKS.md#5-safety)). Its search mirror passes the
  content-sanity gate and the write gate. A body over the page size limit is
  refused (`page_too_large`).

## Search and read

### search

Scope: read. Effect: read-only.

Ranked chunks from a keyword arm and a vector arm, fused by reciprocal rank.
Date, type and slug-prefix filters apply before limits. At most two chunks per
page come back. Hits are not exhaustive. `meta` reports `vectorEnabled` and
`degraded` (for example `embed_timeout` when the search ran on words only). An
empty result carries a recovery `hint`. Outside text and text the write gate
flagged come back inside a trust frame. No model is called except the query
embedding.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `q` | string | yes | Natural-language query. |
| `k` | integer (1–100) | no | Number of hits. Default 20. |
| `source_ids` | string[] | no | Up to 100 source ids within your grant (omitted: whole grant). `[]` reads nothing; a forbidden id refuses the call. |
| `types` | string[] | no | Up to 20 lower-case page types; matches live pages and their mirrors. Empty: no filter. An unknown type returns `unknown_page_types`. |
| `slug_prefix` | string | no | Literal slug prefix (e.g. `projects/x/`), no wildcards. |
| `token_budget` | integer (1–200000) | no | Cap on returned title + content (about chars/4 tokens), trust frames included. Whole hits in rank order; stops before the first that overflows. |
| `since` | string | no | Keep hits whose content date (effective, else updated) is on or after this: ISO date/datetime or a duration back from now (`7d`, `2w`, `6m`, `1y`). |
| `until` | string | no | Upper bound on the content date, same forms. `YYYY-MM-DD` includes the whole day. |
| `offset` | integer (0–1000) | no | Skip the first N ranked hits (pagination). |

Each hit carries `source_id`, `date` and `date_source` (`effective` or
`updated`). The operator's `meta` also counts retrieved and returned hits.
When the brain's or the caller's daily cap is spent, the call fails with
`budget_exhausted` instead of returning keyword-only results.

### search_exact

Scope: read. Effect: read-only. Not on the static public bearer.

Finds a literal substring in live page bodies and compiled truth, with no
ranking and no embeddings. Returns slug, title, `source_id` and one snippet per
matching page. `complete: true` means every match was returned; `false` means
the limit or the two-second scan deadline cut it short. `scanned` counts the
eligible pages examined (`null` after a timeout). Deleted and quarantined
pages are skipped.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `phrase` | string | yes | Literal phrase, 1 to 500 characters. `%`, `_` and backslash have no special meaning. |
| `case_sensitive` | boolean | no | Match case exactly. Default false. |
| `slug_prefix` | string | no | Only pages under this slug prefix. |
| `type` | string | no | Only pages of this type. |
| `limit` | integer (1–200) | no | Maximum matching pages. Default 100. |

### page_get

Scope: read. Effect: read-only.

Reads one page, or fails with `not_found`. Pass the returned `version` as
`expected_version` on a later write. A body over 256 KiB, or a call with
`offset`/`max_bytes`, returns `body_window` instead of `markdown_body`: follow
`next_offset` until it is null. Quarantined pages return their metadata and a
`page_quarantined` notice without the body.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The page slug. |
| `source_id` | string | no | Owning source, from a search hit. Narrows your read grant, never widens it. |
| `version` | integer (≥1) | no | Read that stored version's body, truth and hash with `written_at`. Title and identity stay current. A missing snapshot is `version_not_found`. |
| `offset` | integer (≥0) | no | UTF-8 byte offset of a body window. |
| `max_bytes` | integer (4–262144) | no | Body window size in bytes. Default 256 KiB. Windows never split a character. |
| `fuzzy` | boolean | no | Resolve a unique fuzzy match on a miss; several candidates return `ambiguous_slug` with `candidates`. Default false. |
| `include_deleted` | boolean | no | Return a soft-deleted page with `deleted_at`, for restoring. Default false. |
| `include_quarantined` | boolean | no | Admin scope only: return a quarantined page's body. |

### page_list

Scope: read. Effect: read-only.

Lists pages, newest update first by default. Follow `next_cursor` with the same
filters, sort and source access until `complete: true`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_ids` | string[] | no | Up to 100 source ids within your grant. `[]` reads nothing. |
| `type` | string | no | Only pages of this type. |
| `since` | string | no | ISO timestamp; only pages updated since. |
| `tag` | string | no | Only pages carrying this tag (normalized). |
| `sort` | string (`updated_desc`, `updated_asc`, `created_desc`, `slug`) | no | Order. Default `updated_desc`. |
| `include_deleted` | boolean | no | Add soft-deleted pages with `deleted_at`. Default false. |
| `include_body` | boolean | no | Include `markdown_body` and `compiled_truth`. Default true; false lists metadata only. |
| `slug_prefix` | string | no | Literal slug prefix, e.g. `projects/x/`. No wildcards or relative paths. |
| `cursor` | string | no | Opaque `next_cursor` from the previous call. |
| `limit` | integer (1–100) | no | Page size. Default 50. |

### page_versions

Scope: read. Effect: read-only.

Version history, newest first. Metadata by default; operator and admin callers
also see `written_by_principal`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The page slug. |
| `limit` | integer (1–200) | no | Versions to return. Default 20. |
| `include_body` | boolean | no | Add `body_snapshot` and `compiled_truth_snapshot`. Default false. Quarantine and public redaction still apply. |

### get_chunks

Scope: read. Effect: read-only. Not on the static public bearer.

A page's or document's indexed chunks in order. Pass `slug` (resolved through
the page's `page://<slug>` search mirror) or `source_path` (a raw document); at
least one is required. `truncated: true` means more remain: call again with
`from_index` increased by the number returned.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | no | Page slug. |
| `source_path` | string | no | Document source path. |
| `from_index` | integer (≥0) | no | Zero-based position to start from. Default 0. |
| `limit` | integer (1–200) | no | Chunks to return. Default 200. |

### resolve_slugs

Scope: read. Effect: read-only. Not on the static public bearer.

Turns a name into live slugs: exact slug first, then fuzzy title/slug matches.
Each hit has `slug`, `title`, `score` and `referenced_by_count` (distinct
visible pages in your scope that link to it). Ambiguity is reported even with
`limit: 1`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | The name or slug to resolve. |
| `exact` | boolean | no | Match only slug, title, basename, declared alias or a structured email field. Default false (fuzzy). |
| `limit` | integer (1–100) | no | Hits to return. Default 5. |

### backlinks

Scope: read. Effect: read-only.

What links to a target. With the default type `wikilink`, `name` (a page name
or slug, any script) is resolved to its canonical slug, redirects and declared
aliases included, and the pages linking to it are returned. With `tag` or
`date`, the documents whose chunks mention that tag or date.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Target page name or slug, tag, or date. |
| `type` | string (`wikilink`, `tag`, `date`) | no | What to look for. Default `wikilink`. |
| `limit` | integer (1–1000) | no | Results to return. Default 50. |

### get_links

Scope: read. Effect: read-only. Not on the static public bearer.

The edges touching a page, grouped by link type and direction (outbound:
the page is the source; inbound: the target). Groups sort by type, outbound
first; edges newest first.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The page slug. |
| `status` | string (`all`, `active`, `expired`, `future`) | no | Filter manual links by their validity window. Default `all`; the end date is exclusive. |
| `as_of` | string | no | `YYYY-MM-DD` for a status other than `all`. Default today (UTC). |
| `limit` | integer (1–1000) | no | Cap per direction. Default 1000. |

### get_tags

Scope: read. Effect: read-only. Not on the static public bearer.

A page's tags in lexical order. An unknown or untagged page returns an empty
list.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The page slug. |

## Write pages

### page_put

Scope: write. Effect: writes, destructive, idempotent.

Creates or replaces a page. Identical content is a no-op; a change appends a
version. Prefer `page_edit` for a partial change. An omitted `markdown_body`
keeps the current body; an empty one over a page that has a body is refused
unless `allow_empty_body` is set.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | Kebab-case with optional `/` namespaces (e.g. `people/alice`, `journal/2026/05/2026-05-18`). New slugs cannot have repeated or trailing hyphens in a segment; existing slugs stay writable. |
| `markdown_body` | string | no | The page body. |
| `title` | string | no | Page title. |
| `type` | string | no | `concept`, `person`, `company`, `meeting`, `idea`, `journal`, `note`, `email`, `event`, `decision`, `task` or `source`. Inferred from the slug prefix (`people/` gives `person`), else `note`. Other types need `allowAdHocType`. |
| `compiled_truth` | object | no | Editable JSON header (tags, related slugs, tier, …). |
| `allowAdHocType` | boolean | no | Accept a `type` outside the list above. |
| `allow_empty_body` | boolean | no | Clear the body on purpose. |
| `allow_shrink` | boolean | no | Allow a replacement smaller than half of a body over 32 KiB while the write-precondition policy is on (`page_shrink_refused` otherwise). |
| `written_by` | string | no | Caller id for the audit trail. |
| `reason` | string | no | One-line reason (see above). |
| `expected_version` | integer (≥0) | no | Conditional write (see above). |
| `force` | boolean | no | Deliberate unconditional overwrite. |
| `request_id` | string | no | Retry id (see above). |
| `wait_for_index` | boolean | no | No effect. |

Successful page writes return `admin_url` to the operator and admin-scoped
callers when the issuer is configured.

### page_edit

Scope: write. Effect: writes, destructive.

Atomically applies 1 to 50 ordered exact-text replacements to the body,
keeping title and frontmatter. Copy each `old_text` from `page_get`. Returns
the new `version` and a diff capped at 8 KB (`diff_truncated`).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The page to edit; it must exist. |
| `expected_version` | integer (≥1) | yes | The page's current `version`. |
| `edits` | array of `{old_text, new_text}` | yes | Applied in order, all or nothing. `old_text` must occur exactly once; an empty `new_text` deletes it. |
| `reason` | string | no | One-line reason. |
| `written_by` | string | no | Caller id for the audit trail. |
| `request_id` | string | no | Retry id. |
| `wait_for_index` | boolean | no | No effect. |

Errors: `edit_no_match`, `edit_ambiguous_match`, `edit_invalid`,
`version_conflict`, and `edit_protected_span` for an edit that would touch the
facts or takes fence blocks an older install wrote into page bodies.

### page_append

Scope: write. Effect: writes.

Appends to an existing page's body as a new version. Use `page_put` to create
a page.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The page slug; it must exist. |
| `content` | string | yes | Markdown to append. |
| `written_by` | string | no | Caller id for the audit trail. |
| `request_id` | string | no | Retry id. |
| `wait_for_index` | boolean | no | No effect. |

### page_rename

Scope: write. Effect: writes, destructive. Not on the static public bearer.

Moves a page to a new slug with its history, links and tags, and redirects the
old slug. Pages written by an importer are refused (`importer_managed`): rename
them upstream. The old search mirror is removed at once and the new slug is
indexed by the next housekeeping pass. Both slugs must be inside your write
grant. CLI: `memrain rename <from> <to> --expected-version N`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from` | string | yes | Current slug. |
| `to` | string | yes | New slug. |
| `expected_version` | integer (≥1) | yes | The page's current `version`. |

### page_delete

Scope: write. Effect: writes, destructive, idempotent. Not on the static public bearer.

Soft-deletes a page: sets `deleted_at` and keeps the page and its history. It
leaves search at once and can be restored with `page_restore` until it is
purged (30 days by default).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The page slug. |
| `reason` | string | no | One-line reason. |
| `written_by` | string | no | Caller id for the audit trail. |
| `expected_version` | integer (≥0) | no | Conditional delete. |
| `force` | boolean | no | Deliberate unconditional delete. |

### page_restore

Scope: write. Effect: writes, idempotent. Not on the static public bearer.

Undeletes a soft-deleted page (clears `deleted_at`). A no-op when the page is
missing or already live.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The page slug. |
| `written_by` | string | no | Caller id for the audit trail. |

### page_revert

Scope: write. Effect: writes, destructive. Not on the static public bearer.

Restores an earlier body snapshot as a new version; history is kept.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The page slug. |
| `version` | integer (≥1) | yes | The `version_n` to restore, from `page_versions`. |
| `reason` | string | no | One-line reason. |
| `written_by` | string | no | Caller id for the audit trail. |
| `expected_version` | integer (≥0) | no | Conditional revert. |
| `force` | boolean | no | Deliberate unconditional revert. |

### index

Scope: write. Effect: writes, destructive.

Indexes a markdown document that is not a page. Pass `sourcePath` + `text` to
index content inline. The `path` form reads a file from the server's disk and
is for the operator only; the path must sit under `MEMRAIN_VAULT_PATHS` or
`MEMRAIN_CODE_PATHS`, and dotfiles, `.env`, `.git` and similar are refused even
inside those roots. A non-operator `sourcePath` must be a normalized path and
cannot take over a label another source already uses.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | no | Absolute path to a `.md` file (operator only). |
| `sourcePath` | string | no | Label the inline document is stored under. |
| `text` | string | no | Inline markdown to index with `sourcePath`. |

## Links and tags

### link

Scope: write. Effect: writes, idempotent.

Asserts a typed link from one page to another. Repeating the same source,
target and type updates its confidence and chunk. `works_at` and `located_at`
hold one value at a time: a new dated value closes the open one, and an
overlap, or a missing `valid_from` once the link is dated, is refused
(`link_interval_conflict`).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_slug` | string | yes | The source page; it must exist. |
| `target_slug` | string | yes | The target slug; the page need not exist yet. Loose names like `Alice Smith` become `alice-smith`. |
| `type` | string | yes | `wikilink`, `mentions`, `works_at`, `attended`, `founded`, `advises`, `invested_in`, `knows`, `met`, `located_at`, `related_to`, `supersedes` or `contradicts`. Others need `allowAdHocType`. |
| `confidence` | number (0–1) | no | Default 1.0. |
| `valid_from` | string | no | Inclusive start `YYYY-MM-DD`. Omitted keeps a stored bound; a stored bound cannot change. |
| `valid_until` | string | no | Exclusive end `YYYY-MM-DD`, after `valid_from`. A stored bound cannot change. |
| `source_chunk_id` | string | no | The chunk the link was read from. |
| `allowAdHocType` | boolean | no | Accept a type outside the list. |

### unlink

Scope: write. Effect: writes, destructive, idempotent. Not on the static public bearer.

Removes a manually created link. Returns `removed`, and `derived_from_text`
when the same edge is still supplied by the source page's markdown,
frontmatter or mentions; remove those by editing the page.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_slug` | string | yes | The source page. |
| `target_slug` | string | yes | The target slug. |
| `type` | string | yes | The link type. |

### add_tag

Scope: write. Effect: writes, idempotent.

Adds a tag to an existing page. Tags are trimmed and lower-cased.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The page slug. |
| `tag` | string | yes | The tag. |

### remove_tag

Scope: write. Effect: writes, destructive, idempotent. Not on the static public bearer.

Removes a tag from a page. Removing an absent tag is a no-op.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The page slug. |
| `tag` | string | yes | The tag. |

## Identity and diagnostics

### whoami

Scope: read. Effect: read-only.

The calling identity and its grant: `client_id`, `scopes`, `write_source`,
`read_sources` (null when unscoped), `is_public`, `owner`, `requester_scope`,
`operator`, `bound_slug_prefixes`, `budget_usd_per_day`, `spent_today_usd`,
`spend_id` and `callable_tools` (the same list `tools/list` returns). Reads no
corpus and makes no model call.

No parameters.

### get_brain_identity

Scope: read. Effect: read-only.

For a client banner: the running version, the storage engine kind, corpus
counts (documents, chunks, embeddings, pages, sources) and the brain's
earliest `created_at`. Counts only, no slugs, titles or bodies.

No parameters.

### stats

Scope: read. Effect: read-only. Operator only.

Counts of indexed documents, chunks and embeddings. No model call.

No parameters.

### sources_list

Scope: read. Effect: read-only. Not on the static public bearer.

Registered sources with id, kind, path prefix, policies and boost weight. A
scoped caller sees only the sources its grant covers.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | string | no | Only sources of this kind. |

### sources_status

Scope: read. Effect: read-only. Not on the static public bearer.

One source's row plus its live health: document and chunk counts, embedding
coverage and staleness. A scoped caller may only ask about a source inside
its grant.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Source id. |

### run_doctor

Scope: read. Effect: read-only. Operator only.

Runs the brain health checks and returns a structured report: schema version,
counts, embedding coverage, stale locks, housekeeping freshness, indexes,
quarantine, secrets and OAuth client hygiene. The same checks back
`memrain doctor`. Never writes; no model call.

No parameters.

## Admin

### purge_deleted_pages

Scope: admin. Effect: writes, destructive. Not on the static public bearer.

Hard-deletes pages that were soft-deleted more than `older_than_hours` ago,
with their versions, aliases, links, tags, redirects, any rows stored against
them, and secret originals only they held. Returns the slugs, a count, the
TTL and per-table counts. Run `dry_run: true` first and pass its `plan_hash`
back, so exactly the reviewed pages go. Housekeeping runs the same purge every
hour with the default cutoff.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `older_than_hours` | number (≥0) | no | Age cutoff in hours. Default 720 (30 days). |
| `slugs` | string[] | no | Only these slugs, and only if soft-deleted past the cutoff. Their text is tombstoned so no later write brings it back (`memrain unpurge` clears that). Omitted: every expired page. |
| `dry_run` | boolean | no | Purge nothing; return `planned` and its `plan_hash`. |
| `expected_plan_hash` | string | no | The `plan_hash` of an earlier dry run. Refused unless the plan still hashes the same. |
