# MCP tools

<!-- Generated from deploy/memrain/src/mcp/operations.ts.
     Do not edit by hand: run `bun scripts/gen-catalogs.ts` in deploy/memrain. -->

Memrain serves 105 tools over MCP. This page lists each one with the
parameters it accepts — the same definitions clients receive from `tools/list`.
A client only sees the tools its credential may call, so a token may list
fewer. From a shell, `memrain call <tool> --args '<json>'` runs any of them
locally. Errors are described in [ERRORS.md](ERRORS.md).

- **Scope** is what the credential needs.
- **Effect** is `read-only`, `writes`, or `writes, destructive` when the tool
  can overwrite or delete; `idempotent` means repeating the same call changes
  nothing more.
- **Operator only** tools expose brain-wide state and are refused to tenant
  credentials.

| Scope | Who may call |
|---|---|
| read | Any caller that can see the brain; results are limited to the sources the credential may read. |
| write | A credential with a write source; changes land only in sources it may write. |
| admin | A credential granted the `admin` scope. |
| agent | A credential granted the `agent` scope; these queue background work that may spend. |

## All tools

| Tool | Scope | Effect | Operator only |
|---|---|---|---|
| [`search_exact`](#search_exact) | read | read-only | no |
| [`search`](#search) | read | read-only | no |
| [`index`](#index) | write | writes, destructive | no |
| [`backlinks`](#backlinks) | read | read-only | no |
| [`stats`](#stats) | read | read-only | yes |
| [`source_health`](#source_health) | read | read-only | no |
| [`log_friction`](#log_friction) | write | writes | no |
| [`page_put`](#page_put) | write | writes, destructive, idempotent | no |
| [`page_append`](#page_append) | write | writes | no |
| [`page_edit`](#page_edit) | write | writes, destructive | no |
| [`page_rename`](#page_rename) | write | writes, destructive | no |
| [`page_delete`](#page_delete) | write | writes, destructive, idempotent | no |
| [`page_restore`](#page_restore) | write | writes, idempotent | no |
| [`page_revert`](#page_revert) | write | writes, destructive | no |
| [`page_get`](#page_get) | read | read-only | no |
| [`page_list`](#page_list) | read | read-only | no |
| [`page_versions`](#page_versions) | read | read-only | no |
| [`link`](#link) | write | writes, idempotent | no |
| [`unlink`](#unlink) | write | writes, destructive, idempotent | no |
| [`graph_neighbors`](#graph_neighbors) | read | read-only | no |
| [`graph_query`](#graph_query) | read | read-only | no |
| [`traverse_graph`](#traverse_graph) | read | read-only | no |
| [`add_fact`](#add_fact) | write | writes | no |
| [`add_timeline_event`](#add_timeline_event) | write | writes | no |
| [`entity_facts`](#entity_facts) | read | read-only | no |
| [`fact_supersessions`](#fact_supersessions) | read | read-only | no |
| [`entity_timeline`](#entity_timeline) | read | read-only | no |
| [`entity_recall`](#entity_recall) | read | read-only | no |
| [`jobs_submit`](#jobs_submit) | read | writes | yes |
| [`jobs_cancel`](#jobs_cancel) | read | writes, destructive | yes |
| [`jobs_list`](#jobs_list) | read | read-only | yes |
| [`jobs_get`](#jobs_get) | read | read-only | yes |
| [`jobs_logs`](#jobs_logs) | read | read-only | yes |
| [`daemons_status`](#daemons_status) | read | read-only | yes |
| [`submit_agent`](#submit_agent) | agent | writes | no |
| [`get_agent_job`](#get_agent_job) | agent | read-only | no |
| [`get_chunks`](#get_chunks) | read | read-only | no |
| [`resolve_slugs`](#resolve_slugs) | read | read-only | no |
| [`add_tag`](#add_tag) | write | writes, idempotent | no |
| [`remove_tag`](#remove_tag) | write | writes, destructive, idempotent | no |
| [`get_tags`](#get_tags) | read | read-only | no |
| [`relational_recall`](#relational_recall) | read | read-only | no |
| [`get_links`](#get_links) | read | read-only | no |
| [`list_link_sources`](#list_link_sources) | read | read-only | no |
| [`find_orphans`](#find_orphans) | read | read-only | no |
| [`wanted_pages`](#wanted_pages) | read | read-only | no |
| [`find_experts`](#find_experts) | read | read-only | no |
| [`find_contradictions`](#find_contradictions) | read | read-only | no |
| [`find_trajectory`](#find_trajectory) | read | read-only | no |
| [`get_recent_salience`](#get_recent_salience) | read | read-only | no |
| [`find_anomalies`](#find_anomalies) | read | read-only | no |
| [`recall`](#recall) | read | read-only | no |
| [`forget_fact`](#forget_fact) | write | writes, destructive, idempotent | no |
| [`get_brain_identity`](#get_brain_identity) | read | read-only | no |
| [`whoami`](#whoami) | read | read-only | no |
| [`purge_deleted_pages`](#purge_deleted_pages) | admin | writes, destructive | no |
| [`query`](#query) | read | read-only | no |
| [`code_callers`](#code_callers) | read | read-only | no |
| [`code_callees`](#code_callees) | read | read-only | no |
| [`code_def`](#code_def) | read | read-only | no |
| [`code_refs`](#code_refs) | read | read-only | no |
| [`code_blast`](#code_blast) | read | read-only | no |
| [`code_flow`](#code_flow) | read | read-only | no |
| [`volunteer_context`](#volunteer_context) | read | read-only | no |
| [`context_delta`](#context_delta) | read | read-only | no |
| [`quarantine_list`](#quarantine_list) | admin | writes | yes |
| [`extraction_review`](#extraction_review) | admin | writes | yes |
| [`context_pack`](#context_pack) | read | read-only | no |
| [`advisor`](#advisor) | read | read-only | yes |
| [`list_brain_skillpack`](#list_brain_skillpack) | read | read-only | no |
| [`list_concepts`](#list_concepts) | read | read-only | yes |
| [`list_takes`](#list_takes) | read | read-only | no |
| [`set_take_status`](#set_take_status) | write | writes, idempotent | no |
| [`takes_add`](#takes_add) | write | writes | no |
| [`takes_update`](#takes_update) | write | writes, destructive | no |
| [`takes_resolve`](#takes_resolve) | write | writes, destructive | no |
| [`takes_search`](#takes_search) | read | read-only | no |
| [`get_calibration_profile`](#get_calibration_profile) | read | read-only | no |
| [`takes_scorecard`](#takes_scorecard) | read | read-only | no |
| [`takes_calibration`](#takes_calibration) | read | read-only | no |
| [`extract_facts`](#extract_facts) | write | writes | no |
| [`list_skills`](#list_skills) | read | read-only | no |
| [`get_skill`](#get_skill) | read | read-only | no |
| [`get_recent_transcripts`](#get_recent_transcripts) | read | read-only | no |
| [`think`](#think) | write | writes | no |
| [`put_raw_data`](#put_raw_data) | write | writes, destructive, idempotent | no |
| [`get_raw_data`](#get_raw_data) | read | read-only | no |
| [`log_ingest`](#log_ingest) | write | writes | no |
| [`get_ingest_log`](#get_ingest_log) | read | read-only | no |
| [`retry_job`](#retry_job) | write | writes | yes |
| [`get_job_progress`](#get_job_progress) | read | read-only | yes |
| [`sources_list`](#sources_list) | read | read-only | no |
| [`sources_status`](#sources_status) | read | read-only | no |
| [`get_status_snapshot`](#get_status_snapshot) | read | read-only | yes |
| [`run_doctor`](#run_doctor) | read | read-only | yes |
| [`chronicle_day`](#chronicle_day) | read | read-only | no |
| [`chronicle_since`](#chronicle_since) | read | read-only | no |
| [`chronicle_on_this_day`](#chronicle_on_this_day) | read | read-only | no |
| [`chronicle_last_seen`](#chronicle_last_seen) | read | read-only | no |
| [`ontology_get`](#ontology_get) | read | read-only | no |
| [`ontology_propose`](#ontology_propose) | write | writes | no |
| [`ontology_dimensions`](#ontology_dimensions) | read | read-only | no |
| [`ontology_conflicts`](#ontology_conflicts) | read | read-only | no |
| [`volunteer_chronicle`](#volunteer_chronicle) | read | read-only | no |
| [`chronicle_backfill`](#chronicle_backfill) | write | writes | yes |

## Read tools

### search_exact

Scope: read. Effect: read-only.

Find literal substrings in live page bodies and compiled truth, without ranking or embeddings. Returns slug, title, source_id and one snippet per matching page. complete:true means every match was returned; false means limit or a 2-second timeout. scanned counts eligible pages examined (null on timeout). Scoped to your sources; excludes hidden pages. Internal-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `phrase` | string | yes | Literal phrase, 1 to 500 characters. %, _ and backslash have no special meaning. |
| `case_sensitive` | boolean | no |  |
| `slug_prefix` | string | no |  |
| `type` | string | no |  |
| `limit` | integer (1–200) | no | Maximum matching pages; default 100. |

### search

Scope: read. Effect: read-only.

Ranked vector+keyword chunks, paths and titles. Language/symbol/date/type/slug-prefix filters precede limits and bypass cache. Broad concept/set questions can use query expand:true (paid, default-off); search has no expand. Hits are not exhaustive. meta exposes vectorEnabled/degraded; intent/mode/cache/counts are operator-only. Empty results include a recovery hint.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_ids` | string[] | no | Narrow to ≤100 exact source IDs in your grant. Omitted uses grant; [] reads nothing; any forbidden ID refuses the call. |
| `types` | string[] | no | Up to 20 lower-case page type names. Matches canonical live pages and their indexed mirrors/file twins; non-page documents are excluded. Empty means no type filter. |
| `slug_prefix` | string | no | Literal canonical page slug prefix, e.g. projects/x/. No wildcards. Applied before retrieval limits. |
| `q` | string | yes | Natural-language query. |
| `k` | integer (1–100) | no | Number of hits to return. Default 20. |
| `token_budget` | integer (1–200000) | no | Cap returned title + content (~chars/4 tokens), including trust frames. Keep whole hits in rank order; stop before the first that overflows. Omitted: mode default. |
| `lang` | string | no | Filter to chunks of a source language (chunks.language, e.g. 'typescript', 'python'). Code chunks only. |
| `symbol_kind` | string | no | Filter to chunks of a symbol kind (chunks.symbol_type, e.g. 'function', 'class', 'method'). |
| `since` | string | no | Keep only hits whose content date COALESCE(effective_date, updated_at) is >= this bound: an ISO-8601 date/datetime, or a relative duration like '7d' / '2w' / '6m' / '1y' (back from now). |
| `until` | string | no | Upper bound on COALESCE(effective_date,updated_at): ISO date/time (YYYY-MM-DD includes the whole day), or duration back from now: 7d/2w/6m/1y. |
| `near_symbol` | string | no | Anchor retrieval at this qualified symbol name (e.g. 'BrainEngine::searchKeyword'). Its chunk(s) join the candidate set and seed a structural walk of the code call graph. Code corpora only. |
| `walk_depth` | integer (0–2) | no | Structural walk depth 0-2 (default 0 = off). Expands the anchors through code_edges_symbol with 1/(1+hop) score decay. Code corpora only; bypasses the query cache. |
| `explain` | boolean | no | Stamp each hit with a per-signal ranking attribution (`explain`: base score + the factor every boost stage contributed + reranker delta). Bypasses the query cache. |
| `offset` | integer (0–1000) | no | Skip the first N ranked hits (pagination). Applied after ranking; the widened fetch bypasses nothing else. |
| `mode` | string (one of `conservative`, `balanced`, `tokenmax`) | no | Per-call search mode bundle. Honored ONLY for the operator (local/static-bearer) caller; a tenant token's mode is silently ignored (it cannot escalate to the paid tokenmax bundle). |

### backlinks

Scope: read. Effect: read-only.

Find what links to a target. Default type `wikilink`: `name` (a page name or slug, any script) is resolved to its canonical page slug, redirects and declared aliases included, and the pages linking to it are returned (`sourcePath` is the page's `page://` path, `surfaceForm` the target slug). Type `tag` / `date`: documents whose chunks mention that tag or date.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes |  |
| `type` | string (one of `wikilink`, `tag`, `date`) | no |  |
| `limit` | integer (1–1000) | no |  |

### stats

Scope: read. Effect: read-only. Operator only.

Counts of indexed documents / chunks / embeddings. Cheap; no Bedrock calls.

No parameters.

### source_health

Scope: read. Effect: read-only.

Source-scoped document/chunk counts, embeddable coverage (excluding code), and staleness lag. Only local/unscoped callers see the NULL-source (unclassified) bucket and whole-brain health roll-up. Read-only, cheap, no Bedrock.

No parameters.

### page_get

Scope: read. Effect: read-only.

Read a page or error on absence. fuzzy:true resolves a unique fuzzy miss; multiple candidates return ambiguous_slug + candidates. include_deleted:true exposes soft-deleted pages with deleted_at for restoration. Pass returned version as expected_version on later writes to guard races.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes |  |
| `source_id` | string | no | Owning source from a search result; narrows the caller's read grant, never expands it. |
| `version` | integer (1–2147483647) | no | Read stored body/truth/hash plus written_at; version differs from current_version. Identity/title stay current. Missing snapshot: version_not_found. |
| `offset` | integer (0–9007199254740991) | no | UTF-8 byte offset for a body window; use the returned next_offset to continue. |
| `max_bytes` | integer (4–262144) | no | Body window size in UTF-8 bytes (default 256 KiB). Windows return body_window instead of markdown_body; use page_edit or page_append to change a page. |
| `fuzzy` | boolean | no | Fuzzy slug resolution on a miss (default false). |
| `include_deleted` | boolean | no | Surface soft-deleted pages (default false). |
| `include_quarantined` | boolean | no | Admin-only quarantined body access. Others receive metadata, quarantined and notice:page_quarantined, without body. |

### page_list

Scope: read. Effect: read-only.

List pages, newest-first by default. Optional filters: `type`, `tag` (normalized), `since` (ISO timestamp), `limit` (1..100, default 50). `sort` picks the order (updated_desc default \| updated_asc \| created_desc \| slug); `include_deleted:true` adds soft-deleted pages with deleted_at populated.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_ids` | string[] | no | Narrow to ≤100 exact source IDs in your grant. Omitted uses grant; [] reads nothing; any forbidden ID refuses the call. |
| `type` | string | no |  |
| `since` | string | no |  |
| `tag` | string | no | Filter to pages carrying this tag. |
| `sort` | string (one of `updated_desc`, `updated_asc`, `created_desc`, `slug`) | no |  |
| `include_deleted` | boolean | no | Include soft-deleted pages (default false). |
| `include_body` | boolean | no | Include markdown_body and compiled_truth (default true). Set false for metadata-only listing. |
| `slug_prefix` | string | no | Literal slug prefix, e.g. projects/x/ for a subtree. No wildcards or relative paths. |
| `cursor` | string | no | Opaque next_cursor from a previous page with the same filters, sort and source access. Limit and include_body may change. complete:true means no more rows at read time. |
| `limit` | integer (1–100) | no |  |

### page_versions

Scope: read. Effect: read-only.

Version history, newest first. Metadata by default; include_body:true adds authorized body/truth snapshots. Operator/admin callers also receive written_by_principal (null for legacy/internal versions).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes |  |
| `limit` | integer (1–200) | no |  |
| `include_body` | boolean | no | Include body_snapshot and compiled_truth_snapshot (default false). Quarantine and public redaction still apply. |

### graph_neighbors

Scope: read. Effect: read-only.

Links touching slug, newest first, with direction per row. Select outbound, inbound or both and optional type.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string (one of `all`, `active`, `expired`, `future`) | no | Filter manual link validity; default all. Half-open end date. |
| `as_of` | string | no | Calendar date YYYY-MM-DD for an explicit status other than all; defaults to today UTC. |
| `slug` | string | yes |  |
| `type` | string | no | Filter to a single link type. |
| `direction` | string (one of `outbound`, `inbound`, `both`) | no | Default `both`. |
| `limit` | integer (1–1000) | no |  |

### graph_query

Scope: read. Effect: read-only.

Typed links matching type and at least one of source_slug/target_slug; e.g. works_at + a person source finds their companies, or a company target finds its people.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string (one of `all`, `active`, `expired`, `future`) | no | Filter manual link validity; default all. Half-open end date. |
| `as_of` | string | no | Calendar date YYYY-MM-DD for an explicit status other than all; defaults to today UTC. |
| `type` | string | yes |  |
| `source_slug` | string | no |  |
| `target_slug` | string | no |  |
| `limit` | integer (1–1000) | no |  |

### traverse_graph

Scope: read. Effect: read-only.

Breadth-first graph walk; each node appears once at shortest depth. truncated means eligible nodes within max_depth exceeded limit: narrow type/depth. Direction defaults outbound (also inbound/both); depth default 3, range 1..10; limit default 100, range 1..1000.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string (one of `all`, `active`, `expired`, `future`) | no | Filter manual link validity; default all. Half-open end date. |
| `as_of` | string | no | Calendar date YYYY-MM-DD for an explicit status other than all; defaults to today UTC. |
| `start_slug` | string | yes |  |
| `direction` | string (one of `outbound`, `inbound`, `both`) | no |  |
| `type` | string | no |  |
| `max_depth` | integer (1–10) | no |  |
| `limit` | integer (1–1000) | no |  |

### entity_facts

Scope: read. Effect: read-only.

Entity facts ordered by confidence (default) or recency; omit entity_slug for cross-entity recall. Filter by written_at since, originating source_slug, capture session, case-insensitive grep or private/world visibility. include_forgotten adds audit tombstones for internal callers; public forces it off.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entity_slug` | string | no | Entity to scope to. Omit for a cross-entity recall. |
| `query` | string | no | Semantic focus: one Titan embedding of first 512 characters, cosine ≥0.35; also facts_groups without entity_slug. Public ignores it; unavailable embedding returns normal order + hint. |
| `since` | string | no |  |
| `source_slug` | string | no |  |
| `order` | string (one of `confidence`, `recency`) | no |  |
| `session` | string | no | Filter to facts captured under this session id. |
| `grep` | string | no | Case-insensitive substring filter on the fact text. |
| `visibility` | string (one of `private`, `world`) | no | Filter by fact visibility. |
| `include_forgotten` | boolean | no | Include tombstoned (forgotten) rows. Internal-only; default false. |
| `limit` | integer (1–1000) | no |  |

### fact_supersessions

Scope: read. Effect: read-only.

Supersession audit log: facts retired WITH a replacement pointer (forgotten_at + superseded_by both set), newest retirement first. Each row is the RETIRED fact; superseded_by points at its replacement. Optional `entity_slug` / `since` (ISO, on the retirement time) / `limit` (1..1000, default 50). Tenant-scoped. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entity_slug` | string | no | Confine to one entity's ledger. |
| `since` | string | no | ISO lower bound on forgotten_at. |
| `limit` | integer (1–1000) | no |  |

### entity_timeline

Scope: read. Effect: read-only.

Chronological event log for a page. Newest-first. Optional `since` / `until` date bounds.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes |  |
| `since` | string | no |  |
| `until` | string | no |  |
| `limit` | integer (1–1000) | no |  |

### entity_recall

Scope: read. Effect: read-only.

One-shot 'what do I know about X?' aggregator. Returns the entity's page (compiled_truth + body) plus top-confidence facts plus most-recent timeline events in a single call. The page may be null when the entity exists only as a soft-stub (facts + timeline allowed, page not yet promoted). A fact that conflicts with another visible typed claim lists the peer ids in contested_with.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes |  |
| `query` | string | no | Optional semantic fact focus (e.g. funding history), replacing confidence order; falls back to confidence when embedding is unavailable. |
| `fact_limit` | integer (1–200) | no |  |
| `timeline_limit` | integer (1–200) | no |  |
| `redact_body` | boolean | no | When true, strips markdown_body from the page row. The HTTP public-bearer path forces this on by default; internal MCP callers default false. |
| `token_budget` | integer (≥ 1) | no | Approximate whole-response token cap, measured on serialized visible rows after redaction. Server reallocates unused page/facts/timeline shares and truncates the body. budget reports facts_dropped, timeline_dropped, page_truncated and page_dropped; page:null with page_dropped means it did not fit, not that it is absent. |
| `include_pending` | boolean | no | Piggy-back `pending_consolidation_count` (live facts not yet folded into a consolidated take) on the response. One round trip; field omitted when false. |

### jobs_submit

Scope: read. Effect: writes. Operator only.

Submit a durable job; `kind` must be a registered handler kind. Idempotent when `idempotency_key` is provided (re-submit returns the existing row). Optional `parent_job_id` records a fan-out edge so the parent can detect fan-in via the child-done inbox. WRITE — refused on public ingress.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | string | yes |  |
| `payload` | object | no |  |
| `priority` | integer (1–10) | no |  |
| `max_retries` | integer (0–10) | no |  |
| `parent_job_id` | string | no |  |
| `idempotency_key` | string | no |  |
| `not_before` | string | no |  |
| `timeout_ms` | integer (1–2147483647) | no |  |

### jobs_cancel

Scope: read. Effect: writes, destructive. Operator only.

Cancel a pending job. By default cascades to all pending descendants. WRITE — refused on public ingress.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `cascade` | boolean | no |  |
| `reason` | string | no |  |

### jobs_list

Scope: read. Effect: read-only. Operator only.

List jobs newest-first. Optional filters: status, kind, parent_job_id, since (ISO timestamp), limit (1..1000, default 100).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string | no |  |
| `kind` | string | no |  |
| `parent_job_id` | string | no |  |
| `since` | string | no |  |
| `limit` | integer (1–1000) | no |  |

### jobs_get

Scope: read. Effect: read-only. Operator only.

Get the full detail of a job including payload, result, children, and unread child-done inbox count.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### jobs_logs

Scope: read. Effect: read-only. Operator only.

Compact log view of a job: status, retries, last_error, children count + status breakdown, unread inbox count. Designed to fit in a single chat reply.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### daemons_status

Scope: read. Effect: read-only. Operator only.

Daemons: schedule, pauses, last run, failure streak, next window, scheduler leader. Operator only.

No parameters.

### get_chunks

Scope: read. Effect: read-only.

Return a page's (or document's) content chunks in order. Pass `slug` (resolved through the page's page://<slug> search mirror) or `source_path` (a raw document). At least one is required. Returns at most limit chunks (default 200), ordered by chunk_index with an id tie-break; truncated:true means more remain. Continue with from_index increased by the number returned.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | no |  |
| `source_path` | string | no |  |
| `from_index` | integer (0–9007199254740991) | no | Zero-based position in the ordered, source-filtered result (default 0). |
| `limit` | integer (1–200) | no |  |

### resolve_slugs

Scope: read. Effect: read-only.

Resolve names to live slugs: exact slug, then fuzzy title/slug. exact:true matches only slug/title/basename/declared alias/email (compiled_truth.email or identity.email; email needs body access). Reports ambiguity even at limit:1. Hits: slug,title,score,referenced_by_count (distinct visible referring pages in scope).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes |  |
| `exact` | boolean | no |  |
| `limit` | integer (1–100) | no |  |

### get_tags

Scope: read. Effect: read-only.

List a page's tags in lexical order. Empty list for an unknown or untagged page.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes |  |

### relational_recall

Scope: read. Effect: read-only.

Deterministic relational query — resolves a seed entity from a natural-language relationship question ('who does alice report to?', 'who works at acme', 'how is alice connected to bob') and fans out typed edges. Returns [{slug, relation, depth}]. No LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes |  |
| `limit` | integer (1–200) | no |  |
| `depth` | integer (1–6) | no |  |

### get_links

Scope: read. Effect: read-only.

Edges touching slug, grouped by type and outbound/inbound direction (source/target respectively). Groups sort by type, outbound first; edges newest first. limit caps each direction: default/max 1000, minimum 1.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string (one of `all`, `active`, `expired`, `future`) | no | Filter manual link validity; default all. Half-open end date. |
| `as_of` | string | no | Calendar date YYYY-MM-DD for an explicit status other than all; defaults to today UTC. |
| `slug` | string | yes |  |
| `limit` | integer (1–1000) | no |  |

### list_link_sources

Scope: read. Effect: read-only.

The link-type catalogue with live per-type edge counts. Every KNOWN_LINK_TYPES entry is returned (count 0 when unused), plus any ad-hoc type present in the graph (known:false). Ordered by count DESC then type ASC, so the most-used relationship types surface first while the full vocabulary stays discoverable. Returns [{type, count, known}].

No parameters.

### find_orphans

Scope: read. Effect: read-only.

Pages with zero inbound links — nothing in the graph references them. The natural enrichment targets (a page nobody links to is new or forgotten). Newest-first. Optional `type` page-type filter; `limit` (1..1000, default 50). Deterministic, no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `type` | string | no | Restrict to a single page type (e.g. person). |
| `limit` | integer (1–1000) | no |  |

### wanted_pages

Scope: read. Effect: read-only.

Unresolved targets linked by live visible pages in your sources, most-referenced first. Returns target_slug,referenced_by,sample_from (≤3 slugs),surface,first_seen. Hidden pages never count. Limit default 50, range 1..200. Deterministic, no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer (1–200) | no |  |

### find_experts

Scope: read. Effect: read-only.

With topic: person/company expertise from hybrid search × relationship recency (6-month half-life) × salience. Without topic: graph hubs by distinct live in/out neighbours, excluding unresolved stubs. type overrides topic candidates or filters hubs. Limit default 5, range 1..200; deterministic, no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `topic` | string | no | Optional topic query. When set, ranks person/company pages by expertise + recency + salience. When omitted, returns graph link-degree hubs. |
| `type` | string | no | Restrict to a single page type (overrides the person/company default in topic mode). |
| `explain` | boolean | no | Topic mode only: include the per-result factor breakdown (expertise, recency, salience) behind `score`. |
| `limit` | integer (1–200) | no |  |

### find_contradictions

Scope: read. Effect: read-only.

Read conflicts without an LLM call. Default returns explicit contradicts page edges and cached opt-in probe findings (severity/axis/confidence/resolution_command; empty before probing). slug filters either edge endpoint; limit default 20, max 200. mode:typed finds overlapping numeric disagreements; use entity_slug, not slug/severity.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | string (one of `typed`) | no | typed: deterministic overlapping numeric conflicts in the same unit/period/month/source. Omit for asserted/probed findings. |
| `entity_slug` | string | no | Exact entity filter for typed mode only. |
| `slug` | string | no | Substring filter; matches either side of the pair (case-insensitive). |
| `severity` | string (one of `low`, `medium`, `high`) | no | Filter the probed findings by severity (edges have no severity axis). |
| `limit` | integer (1–200) | no |  |

### find_trajectory

Scope: read. Effect: read-only.

Chronological 'how did this entity change?' log for one slug — the merged, oldest-first view of its entity_facts ledger and its timeline_events. Each fact anchors at its valid_from (else written_at); each event at occurred_at. Optional `since`/`until` ISO bounds on that anchor; `limit` (1..500, default 100). Deterministic, no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entity_slug` | string | yes | The entity to chart (e.g. companies/acme, people/alice). |
| `metric` | string | no | Filter to a single canonical metric label (mig070 claim_metric, e.g. 'mrr'); timeline events are excluded for a metric query. |
| `kind` | string (one of `metric`, `event`, `all`) | no | Row-shape filter (mig070): 'metric' = typed-claim fact rows only, 'event' = event-shaped rows (event_type facts + timeline events), 'all' (default) = merged chronology. |
| `since` | string | no | Lower bound (ISO timestamp) on the point's anchor date. |
| `until` | string | no | Upper bound (ISO timestamp). |
| `limit` | integer (1–500) | no |  |

### get_recent_salience

Scope: read. Effect: read-only.

Live pages ranked by the deterministic `salience` score (migration 036: high-emotion tags + graph link-degree, recomputed by the recompute-salience cycle phase) — the 'what matters' read. Optional `type` filter and `days` recency window. No LLM, no Bedrock. Surfaces page slugs/titles — hidden from public ingress.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `type` | string | no | Filter to a single page type (exact match), e.g. person. |
| `days` | integer (≥ 1) | no | Only pages updated within the last N days. Omit for all-time. |
| `slug_prefix` | string | no | Optional slug-prefix filter, e.g. 'people' or 'projects/x'. |
| `recency_bias` | string (one of `flat`, `on`) | no | 'flat' (default) = pure salience order (historical behavior). 'on' = rank by salience x 1/(1+days_old) — 'what's been salient lately'. |
| `limit` | integer (1–200) | no | Max rows (default 20). |

### find_anomalies

Scope: read. Effect: read-only.

Live-graph outliers: degree_outlier (degree ≥ mean + sigma·stddev) and stale_salient (high salience, updated_at older than staleDays). Uses structural signals, not retrieval/access counters. No LLM; public forbidden (page slugs/titles).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sigma` | number (≥ 0) | no | Std-devs above the mean degree to flag a hub (default 2). |
| `staleDays` | integer (≥ 1) | no | Days an updated_at must lag to count a salient page stale (default 90). |
| `salienceFloor` | number (0–1) | no | Salience floor for the stale_salient class (default 0.5). |
| `limit` | integer (1–200) | no | Max rows per anomaly kind (default 20). |

### recall

Scope: read. Effect: read-only.

Read ONE known numeric fact id: claim, confidence, source and metadata. Unknown/forgotten ids error. For discovery use entity_facts (entity facts), entity_recall (entity context) or search (corpus); this is neither search nor listing.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | integer (≥ 1) | yes | Fact id (entity_facts.id). |

### get_brain_identity

Scope: read. Effect: read-only.

Brain identity + counters for a thin-client banner. Returns the running version, the storage engine kind, and corpus counts (documents / chunks / embeddings / pages / sources) plus the brain's earliest created_at. Counts only — no slugs, titles, or bodies. Cheap; no Bedrock.

No parameters.

### whoami

Scope: read. Effect: read-only.

Show the calling identity and grant: client_id, scopes, write_source, read_sources, is_public, operator, bound_slug_prefixes, takes_holders, budget_usd_per_day, spent_today_usd, spend_id and callable_tools. Unscoped read_sources is null; absent grant fields are null. callable_tools matches tools/list. Reveals only the caller's auth context, no corpus or Bedrock call.

No parameters.

### query

Scope: read. Effect: read-only.

Hybrid retrieval with detail, salience/recency, date/code filters, offset and adaptive_return. expand is paid (mode default); mode overrides are operator-only. refine+weights uses deterministic two-query RRF. Otherwise returns search meta; counts are operator-only. token_budget without k considers 100 hits; explicit k wins. Adds ≤3 lexical ledger facts within budget, respecting source/visibility/diary fences; chunk filters affect hits. Empty results include a recovery hint.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_ids` | string[] | no | Narrow to ≤100 exact source IDs in your grant. Omitted uses grant; [] reads nothing; any forbidden ID refuses the call. |
| `types` | string[] | no | Up to 20 lower-case page type names. Matches canonical live pages and their indexed mirrors/file twins; non-page documents are excluded. Empty means no type filter. |
| `slug_prefix` | string | no | Literal canonical page slug prefix, e.g. projects/x/. No wildcards. Applied before retrieval limits. |
| `q` | string | yes | Natural-language query. |
| `k` | integer (1–100) | no | Number of hits to return. Default 20; without refine, token_budget and no k uses up to 100 candidates. |
| `offset` | integer (0–1000) | no | Skip the first N ranked hits (pagination). |
| `expand` | boolean | no | Force LLM query expansion on/off for this call (paid Haiku). Omit = mode-bundle default (OFF in conservative/balanced). |
| `detail` | string (one of `low`, `medium`, `high`) | no | Result detail: low = compiled-truth-grade brevity (1 chunk per page), medium (default) = per-page dedup, high = all chunks + temporal source-boost bypass. |
| `mode` | string (one of `conservative`, `balanced`, `tokenmax`) | no | Search mode bundle for this call. Operator-only; a tenant token's mode is silently ignored. |
| `salience` | string (one of `off`, `on`, `strong`) | no | Mattering bias (pages.salience: emotional weight + link degree + takes). Omit = auto-detect from the query phrasing. |
| `recency` | string (one of `off`, `on`, `strong`) | no | Recency boost (per-prefix hyperbolic freshness lift). 'strong' for 'today / right now'. Omit = auto-detect. |
| `since` | string | no | Keep only hits whose content date is >= this ISO-8601 date. |
| `until` | string | no | Keep only hits whose content date is <= this ISO-8601 date. |
| `lang` | string | no | Filter to chunks of a source language (code corpora). |
| `symbol_kind` | string | no | Filter to chunks of a symbol kind (code corpora). |
| `near_symbol` | string | no | Anchor retrieval at this qualified symbol name (code corpora). |
| `walk_depth` | integer (0–2) | no | Structural walk depth 0-2 (code corpora). |
| `token_budget` | integer (1–200000) | no | Cap total returned content size (~chars/4 tokens). |
| `adaptive_return` | boolean | no | Return a TIGHT intent-sized result set instead of the full top-K (never empty when there are matches; first page only). |
| `explain` | boolean | no | Stamp per-hit ranking attribution. Bypasses the query cache. |
| `refine` | string | no | LEGACY refinement: second term for the deterministic weighted-RRF blend. When set, only k/weights apply. |
| `primary_weight` | number (≥ 0) | no | RRF weight for the primary query (refine mode). Default 1. |
| `refine_weight` | number (≥ 0) | no | RRF weight for the refine term (refine mode). Default 1. |

### code_callers

Scope: read. Effect: read-only.

Call sites for symbol name (surface,chunk,path), with language/kind/line bounds and authorized opening snippets. Empty reads carry scoped readiness {state,code_documents,symbols}: not_built/indexing/no_symbols/ready; only ready proves absence. Limit default 200, range 1..1000; optional lang. Deterministic, no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Bare symbol name to find callers of (e.g. `hybridSearch`). |
| `limit` | integer (1–1000) | no |  |
| `lang` | string | no | Only mentions from chunks of this source language (e.g. `typescript`, `python`, `go`). |

### code_callees

Scope: read. Effect: read-only.

Callees of target path:line (innermost definition) or symbol; qualified names restrict sites. resolved_symbol is definition or null. Returns language/kind/line bounds and authorized opening snippets. Empty reads carry scoped readiness; only ready proves absence. Limit default 200/max 1000; optional lang. Deterministic, no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `target` | string | yes | `<path>:<line>` of a symbol body (e.g. `src/x.ts:42`), or a symbol name, bare or qualified (e.g. `save` or `Repo::save`). |
| `limit` | integer (1–1000) | no |  |
| `lang` | string | no | Only mentions from chunks of this source language (e.g. `typescript`, `python`, `go`). |

### code_def

Scope: read. Effect: read-only.

Find code-def mentions for symbol name across indexed code: surface form, chunk, source path, language, kind, line bounds and an authorized opening snippet. Empty reads carry scoped readiness: not_built, indexing, no_symbols or ready. Only ready proves absence. Deterministic, no LLM; limit defaults 200 (max 1000), optional lang.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Bare symbol name to locate definitions of (e.g. `hybridSearch`, `Storage`). |
| `limit` | integer (1–1000) | no |  |
| `lang` | string | no | Only mentions from chunks of this source language (e.g. `typescript`, `python`, `go`). |

### code_refs

Scope: read. Effect: read-only.

Non-call code-ref mentions for symbol name (imports/type uses/other references); complements code_callers. Includes language/kind/line bounds and authorized opening snippets. Empty reads carry scoped readiness {state,code_documents,symbols}: not_built/indexing/no_symbols/ready; only ready proves absence. Limit default 200, range 1..1000; optional lang. Deterministic, no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Bare symbol name to find references to (e.g. `hybridSearch`). |
| `limit` | integer (1–1000) | no |  |
| `lang` | string | no | Only mentions from chunks of this source language (e.g. `typescript`, `python`, `go`). |

### code_blast

Scope: read. Effect: read-only.

Transitive callers by BFS depth for change-impact checks. depth default 5/max 8; max_nodes default 200. Returns result (ok/not_found/ambiguous), depth_groups, cycles_detected, truncation and optional candidates/did_you_mean. Nodes: symbol,chunk_id,def_chunk_id,resolved (definition-backed vs by-name). Empty reads carry scoped readiness; only ready proves absence. No LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `symbol` | string | yes | Bare or qualified symbol name (e.g. `performSync` or `Foo::performSync`). |
| `depth` | integer (1–8) | no | Hop cap. Default 5, max 8. |
| `max_nodes` | integer (1–200) | no | Result-set cap. Default 200. |
| `exact` | boolean | no | Skip bare-name disambiguation; treat `symbol` as an exact qualified name. |
| `lang` | string | no | Walk only chunks of this source language. Omitted: the start symbol's language when all its definitions share one. |

### code_flow

Scope: read. Effect: read-only.

Transitive callees by BFS depth; code_blast envelope plus terminal_nodes [{symbol,sink_kind:db_call/http_call/file_io/process_exec}]. depth default 8/max 12; max_nodes default 200. Language-specific names detect sinks; generic get/put/read/write do not. Empty reads carry readiness; only ready proves absence. No LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `symbol` | string | yes | Entry-point symbol name (bare or qualified). |
| `depth` | integer (1–12) | no | Hop cap. Default 8, max 12. |
| `max_nodes` | integer (1–200) | no | Result-set cap. Default 200. |
| `exact` | boolean | no | Skip bare-name disambiguation; treat `symbol` as an exact qualified name. |
| `lang` | string | no | Walk only chunks of this source language. Omitted: the start symbol's language when all its definitions share one. |

### volunteer_context

Scope: read. Effect: read-only.

Resolve rolling-window entity mentions to page pointers: alias .9/title .8/slug-suffix .6, +.05 for newest-turn or ≥2-turn mentions; confidence gate and cap N. Returns [{slug,title,display,confidence,arm,rationale,synopsis}]. Deterministic, no Bedrock. Public forbidden (slugs/titles/synopses). stats:true gives approximate per-arm used/volunteered precision from last_retrieved_at.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `window` | string | no | Conversation window text. 'user:'/'assistant:' line prefixes set the role; unprefixed input is one user turn. Required unless stats:true. |
| `prior_context` | string | no | Already-surfaced context (pointer blocks / opened page bodies). Pages whose slug appears here are not re-volunteered. |
| `max_pages` | integer (1–5) | no | Max pages volunteered (default 3, cap 5). |
| `min_confidence` | number (0–1) | no | Confidence gate 0..1 (default 0.7). At the default, slug-suffix matches never volunteer. |
| `session_id` | string | no | Opaque session id stamped on each logged volunteer event. |
| `turn` | integer (≥ 0) | no | Turn number stamped on each logged volunteer event. |
| `stats` | boolean | no | Return per-arm used/volunteered precision stats instead of volunteering. |
| `days` | integer (1–3650) | no | Stats window in days (default 30; stats mode only). |

### context_delta

Scope: read. Effect: read-only.

Bounded recent pages (metadata), facts and events since a date/UTC timestamp; each section has truncated and time_basis. Not a complete change log/snapshot. Read-only, no retrieval touch/inference; internal-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `since` | string | yes | YYYY-MM-DD or UTC ISO timestamp. |
| `limit` | integer (1–100) | no | Maximum items per section; default 20. |
| `source_ids` | string[] | no | Narrow within your source grant; [] reads nothing. |

### context_pack

Scope: read. Effect: read-only.

Budgeted entity cards (title,type,facts,events; no body), up to 8: explicit slugs first, then window entities at the volunteer default gate. Adds top decayed facts across the grant, excluding card duplicates. token_budget prioritizes cards; budget reports drops. Hidden/missing slugs both yield no card. Conflicting facts carry contested_with. Operator-pinned pages (MEMRAIN_CONTEXT_CORE_SLUGS) come first as core, charged before cards. Stateless read, no LLM; internal-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slugs` | array | no | Entity page slugs to build cards for, in priority order (array of strings). |
| `window` | string | no | Conversation window text; entities it names fill the card slots left after `slugs`. 'user:'/'assistant:' line prefixes set the role. |
| `max_entities` | integer (1–8) | no | Max entity cards (default 5, cap 8). |
| `facts_limit` | integer (1–25) | no | Max brain facts after the cards (default 10, cap 25). |
| `token_budget` | integer (200–8000) | no | Token budget for cards + facts (default 1500, clamped 200..8000). |

### advisor

Scope: read. Effect: read-only. Operator only.

Ranked, read-only "what to do next" for this brain: pending migrations, version drift, stalled/failed jobs, low embedding coverage, and setup smells. Each finding has a severity (high/medium/low/info), a why-it-matters, and the exact fix command. Never mutates, never calls an LLM. Tell the user; ask before running any fix. Internal-only.

No parameters.

### list_brain_skillpack

Scope: read. Effect: read-only.

Read the served deploy/skills catalog (also list_skills): slug, description, triggers, mutating flag, usable_tools/unavailable_tools for your grant. Retrieve with get_skill; listing does not install skills. Host CLI: memrain skillpack builds a tarball + SHA-256 manifest; skillpack lint checks actual tools/commands.

No parameters.

### list_concepts

Scope: read. Effect: read-only. Operator only.

List synthesized concept pages (LLM-derived from the corpus by the synthesize-concepts cycle phase): concept_slug, title, tier (T1/T2/T3), atom_count, narrative. Ordered by atom_count DESC. Read-only; internal-only (derived over private notes).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer (1–200) | no | Max rows (default 50). |

### list_takes

Scope: read. Effect: read-only.

List synthesized 'takes' (opinionated claims the propose-takes phase derived, optionally graded): take_key, claim_text, kind, weight, domain, status (queued/accepted/rejected). Optional filters: `kind`, `domain`; `sort` (generated_at default \| weight), `offset` for pagination. Advisory only — never mutates notes. Read-only; internal-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string (one of `queued`, `accepted`, `rejected`, `graded`) | no | Filter by review status. |
| `kind` | string | no | Filter to one take kind (e.g. bet, judgment). |
| `domain` | string | no | Filter to one domain tag. |
| `holder` | string | no | Filter to one holder (world \| brain \| people/<slug> \| companies/<slug>). |
| `sort` | string (one of `generated_at`, `weight`) | no | Sort key. Default generated_at (newest first). |
| `offset` | integer (0–10000) | no | Skip the first N rows. |
| `limit` | integer (1–200) | no | Max rows (default 50). |

### takes_search

Scope: read. Effect: read-only.

Fuzzy-search synthesized 'takes' by claim text (pg_trgm similarity + substring fallback), ranked best-match first: take_key, claim_text, kind, weight, domain, status. Read-only; internal-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `q` | string | yes | Claim text to match. |
| `limit` | integer (1–200) | no | Max rows (default 50). |

### get_calibration_profile

Scope: read. Effect: read-only.

The latest narrative calibration/bias profile (from the calibration-profile phase): grade tallies, accuracy, pattern statements, bias tags. Read-only; internal-only. Null when no profile has been generated yet.

No parameters.

### takes_scorecard

Scope: read. Effect: read-only.

Read latest grades of synthesized takes: total/graded/resolved, verdict counts, accuracy=correct/(correct+incorrect), partial_rate, Brier score over correct/incorrect bets versus stated weight. Zero before opt-in grading. Filter domain/holder and generated since/until; source and holder grants apply. Internal-only, no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `domain` | string | no | Filter to takes tagged with this domain. |
| `holder` | string | no | Filter to this holder (world\|brain\|<slug>). Still gated by the token's takes-holder allow-list. |
| `since` | string | no | Only takes generated on/after this ISO date (YYYY-MM-DD). |
| `until` | string | no | Only takes generated on/before this ISO date (YYYY-MM-DD). |

### takes_calibration

Scope: read. Effect: read-only.

Reliability buckets for latest correct/incorrect take grades: observed hit-rate vs mean stated weight. bucket_size in (0,1], default .1. Empty before grading. Filter domain/holder within source/holder grants. Internal-only, read-only, no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `bucket_size` | number (0–1) | no | Bucket width in (0,1]. Default 0.1. |
| `domain` | string | no | Filter to takes tagged with this domain. |
| `holder` | string | no | Filter to this holder (world\|brain\|<slug>). Still gated by the token's takes-holder allow-list. |

### list_skills

Scope: read. Effect: read-only.

Find skills in this brain's local pack by task. With query, rank by slug, description and triggers (exact slug first), returning up to 5 by default. Without arguments, return the full byte-ordered catalog. Each entry includes triggers, tools split into usable_tools/unavailable_tools for your grant, mutating, requires and writes_to. Fetch a match with get_skill. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | no | Task or skill name, at most 200 characters. |
| `limit` | integer (1–50) | no | Maximum skills; default 5 with query, otherwise all. |

### get_skill

Scope: read. Effect: read-only.

Fetch one brain-resident skill's full markdown body by slug (as returned by list_skills). Returns {slug, description, body, frontmatter, usable_tools, unavailable_tools}, or an error when the slug is unknown. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Skill slug exactly as returned by list_skills. |

### get_recent_transcripts

Scope: read. Effect: read-only.

Recently-ingested conversation transcript pages (types: meeting, email, journal, note), newest-first, within a day window. Returns each page's slug/type/title/updated_at plus a summary (first ~300 chars) or — with summary=false — the body capped at 100 KB. Tenant-scoped; limit-capped (default 50, max 200). Surfaces page bodies — hidden from public ingress. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `days` | integer (≥ 0) | no | Only pages updated within the last N days. Default 30. |
| `summary` | boolean | no | true (default) returns a ~300-char summary; false returns the body capped at 100 KB. |
| `limit` | integer (1–200) | no | Max rows (default 50). |

### get_raw_data

Scope: read. Effect: read-only.

Read a page's raw_data sidecar rows, newest first. Optional `source` filter to one data-source label; `limit` (1..200, default 50). Tenant-scoped via the owning page. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes |  |
| `source` | string | no | Filter to one data-source label. |
| `limit` | integer (1–200) | no |  |

### get_ingest_log

Scope: read. Effect: read-only.

Recent ingestion-log entries, newest first, scoped to the caller's read set. Optional `source_type` filter; `limit` (1..50, default 20). Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_type` | string | no | Filter to one event family. |
| `limit` | integer (1–50) | no |  |

### get_job_progress

Scope: read. Effect: read-only. Operator only.

Read a job's live progress envelope: status + the handler-reported `progress` JSON (mig083). Cheap poll target while a long job runs. Operator-only; read-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Job id (see jobs_list). |

### sources_list

Scope: read. Effect: read-only.

List registered sources (id, kind, path_prefix, policies, boost weight). A scoped caller sees ONLY the sources its grant covers; the operator sees all. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | string | no | Filter by source kind. |

### sources_status

Scope: read. Effect: read-only.

Per-source diagnostic: the source row plus its live health (document/chunk counts, embed coverage, staleness lag, failed jobs). A scoped caller may only query a source inside its grant. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Source id. |

### get_status_snapshot

Scope: read. Effect: read-only. Operator only.

One-shot operational snapshot for thin-client status: version, corpus stats, brain health (embed coverage, staleness, job queue), query-cache state, and the active job worker lock. Operator-only (exposes whole-brain operational state); read-only; no Bedrock.

No parameters.

### run_doctor

Scope: read. Effect: read-only. Operator only.

Run the thin-client brain health checks and return a structured report: config-free engine checks only (stats, embed coverage/staleness, tenancy/federation health, OAuth client hygiene, source routing, job worker liveness). Operator-only; read-only; never mutates; no LLM.

No parameters.

### chronicle_day

Scope: read. Effect: read-only.

Life-chronicle timeline for one UTC calendar day (or the ISO week containing it, with `week:true`). Returns the projected events — each a summary/detail joined to its depth page and, for an event projection, the event kind. `narrative:true` also returns a day-by-day prose rendering. Tenant-scoped. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `date` | string | yes | UTC calendar day, YYYY-MM-DD. |
| `week` | boolean | no | Expand to the ISO week (Mon–Sun) containing `date`. |
| `kind` | string | no | Filter event projections by event.kind (e.g. 'meeting'). |
| `narrative` | boolean | no | Also return a readable day-by-day prose summary. |
| `limit` | integer (1–1000) | no | Max events (default 200). |

### chronicle_since

Scope: read. Effect: read-only.

Life-chronicle events on or after a date, oldest-first. Returns the projected timeline rows. Tenant-scoped. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `since` | string | yes | Lower-bound UTC date, YYYY-MM-DD (inclusive). |
| `kind` | string | no | Filter event projections by event.kind. |
| `limit` | integer (1–1000) | no | Max events (default 20). |

### chronicle_on_this_day

Scope: read. Effect: read-only.

Life-chronicle 'on this day': events from the same month+day in prior years, most-recent-first. `date` defaults to today (UTC). Tenant-scoped. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `date` | string | no | Target day, YYYY-MM-DD. Defaults to today (UTC). |
| `limit` | integer (1–1000) | no | Max events (default 50). |

### chronicle_last_seen

Scope: read. Effect: read-only.

When an entity last appeared in the life chronicle — the most recent timeline day its own page or an event's `who` array references it, plus days_ago. Tenant-scoped. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entity` | string | yes | Entity slug (e.g. people/alice) or name to match. |

### ontology_get

Scope: read. Effect: read-only.

The live per-dimension ontology for an entity: the current value on each axis (role, employer, location, …), confidence, provenance, and bi-temporal validity. `asof` time-travels to a past date; `min_confidence` floors the rows; `include_quarantined` surfaces novel/unconfirmed dimensions. Non-operator callers see world-visible rows only and never diary-sourced values. Tenant-scoped. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entity` | string | yes | Entity slug (e.g. people/alice). |
| `asof` | string | no | Resolve the ontology as of this YYYY-MM-DD (valid-time travel). |
| `min_confidence` | number (0–1) | no | Drop rows below this confidence. |
| `include_quarantined` | boolean | no | Include quarantined (novel/unconfirmed) dimensions. |

### ontology_dimensions

Scope: read. Effect: read-only.

Which dimension axes exist across the (scoped) corpus and how heavily each is used — [{dimension, entities, observations}], busiest first. Tenant-scoped. Read-only; no LLM.

No parameters.

### ontology_conflicts

Scope: read. Effect: read-only.

Entities whose currently-open observations on one dimension disagree — at least two distinct values from at least two distinct sources. For non-operator callers, diary-sourced values are stripped and a conflict that no longer disagrees after that stripping is dropped. Tenant-scoped. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `min_confidence` | number (0–1) | no | Floor the observations considered. |

### volunteer_chronicle

Scope: read. Effect: read-only.

Push-based chronicle context: the recent timeline plus the validity-resolved ontology for the named entities, composed with zero LLM. Non-operator callers get a redacted view (diary-sourced + private-visibility ontology stripped). Tenant-scoped. Read-only; no LLM.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `days` | integer (1–50) | no | Lookback window for the recent timeline (default 7, cap 50). |
| `entities` | array | no | Entity slugs to resolve current ontology for (array or comma-separated string). |

## Write tools

### index

Scope: write. Effect: writes, destructive.

Index a markdown document. Either pass `path` (an absolute path the daemon can read) or `sourcePath` + `text` (in-memory).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | no | Absolute path to a .md file. |
| `sourcePath` | string | no |  |
| `text` | string | no |  |

### log_friction

Scope: write. Effect: writes.

Record a friction event — used by the agent to flag when retrieval missed, an answer felt wrong, a tool errored out, OR when a recall produced an unexpectedly good hit (`delight`). When invoked from a skill, include extra.skill = '<skill-slug>' so `memrain friction propose-fix` can group the event with the skill that fired it. Set `severity` to confused/error/blocker/nit on negative kinds for triage.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | string (one of `search-miss`, `wrong-answer`, `tool-error`, `low-confidence`, `other`, `delight`, `phase-marker`, `interrupted`) | yes |  |
| `query` | string | no |  |
| `reason` | string | no |  |
| `sourcePath` | string | no |  |
| `severity` | string (one of `confused`, `error`, `blocker`, `nit`) | no |  |
| `extra` | object | no |  |

### page_put

Scope: write. Effect: writes, destructive, idempotent.

Create/replace a DB-canonical page; identical content is a no-op, changes append history. Prefer page_edit for partial changes. Mirrors normally return search_indexed; queued ones return search_pending + search_job_id; wait_for_index waits. MEMRAIN_REQUIRE_WRITE_PRECONDITION makes missing expected_version/force warn or refuse with precondition_required + current_version. Public writes need MEMRAIN_PUBLIC_WRITE=1.

Call shape: `{slug, markdown_body, expected_version?}`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `reason` | string | no | Optional trimmed one-line reason, ≤500 Unicode code points; secret-scanned, stored only with a new version. |
| `slug` | string | yes | kebab-case identifier with optional `/` namespaces (e.g. people/alice, journal/2026/05/2026-05-18). New slugs cannot have repeated or trailing hyphens in any segment; existing slugs remain writable. |
| `type` | string | no | Optional: concept/person/company/meeting/idea/journal/note/email/event/decision/task/source. Inferred from slug prefix (people/→person), else note. Other types require allowAdHocType:true. |
| `title` | string | no |  |
| `compiled_truth` | object | no | Editable jsonb header (tags, related slugs, tier, enriched_at, …). |
| `markdown_body` | string | no |  |
| `written_by` | string | no | Optional caller identifier for the audit trail (skill slug, recipe name, …). |
| `allowAdHocType` | boolean | no |  |
| `allow_empty_body` | boolean | no | Clear the page's body on purpose. Without it an empty markdown_body over a page that has one is refused; an OMITTED markdown_body keeps the current body. |
| `allow_shrink` | boolean | no | Allow an intentional replacement smaller than half of a body over 32 KiB when the write-precondition policy is enabled. Prefer page_edit for partial changes. |
| `wait_for_index` | boolean | no | Write the search mirror before returning even when mirrors are queued, so the page is searchable the moment this call returns. Slower. |
| `expected_version` | integer (≥ 0) | no | Require this page_get version/page_versions version_n; 0 requires absence. Deleted pages retain versions: use current_version from a failed 0 attempt. Mismatch writes nothing and returns current_version. Omit for an unconditional write, subject to precondition policy. |
| `force` | boolean | no | Overwrite unconditionally, on purpose. Cannot be combined with expected_version. |
| `request_id` | string | no | Optional retry id (1-128 chars), retained 7 days. Same id+arguments replays the first result (replayed:true), without writing; changed arguments are refused. |

### page_append

Scope: write. Effect: writes.

Append to an existing page body and add a version; use page_put to create. Search readiness returns search_indexed, or search_pending + search_job_id for queued mirrors (normally seconds). wait_for_index:true waits for search readiness. Public writes require MEMRAIN_PUBLIC_WRITE=1.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes |  |
| `content` | string | yes |  |
| `written_by` | string | no |  |
| `wait_for_index` | boolean | no | Write the search mirror before returning even when mirrors are queued, so the page is searchable the moment this call returns. Slower. |
| `request_id` | string | no | Optional retry id (1-128 chars), retained 7 days. Same id+arguments replays the first result (replayed:true), without writing; changed arguments are refused. |

### page_edit

Scope: write. Effect: writes, destructive.

Atomically apply 1..50 ordered exact-text body replacements, preserving title/frontmatter. Copy unique old_text from page_get; misses/duplicates give edit_no_match/edit_ambiguous_match. Facts/takes fences and markers are protected (edit_protected_span); use their writers. Requires expected_version; conflict returns current_version. Returns version and diff capped at 8 KB (diff_truncated). Indexing follows page_put; wait_for_index waits. Public writes need MEMRAIN_PUBLIC_WRITE=1.

Call shape: `{slug, expected_version, edits:[{old_text, new_text}]}`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `reason` | string | no | Optional trimmed one-line reason, ≤500 Unicode code points; secret-scanned, stored only with a new version. |
| `slug` | string | yes | The page to edit; it must exist. |
| `expected_version` | integer (≥ 1) | yes | The page's current version (`version` from page_get). On a mismatch nothing is written and the error names the current version. |
| `edits` | object[] | yes | 1 to 50 replacements, applied in order, all or nothing. |
| `written_by` | string | no | Optional caller identifier for the audit trail (skill slug, recipe name, …). |
| `wait_for_index` | boolean | no | Write the search mirror before returning even when mirrors are queued, so the change is searchable the moment this call returns. Slower. |
| `request_id` | string | no | Optional retry id (1-128 chars), retained 7 days. Same id+arguments replays the first result (replayed:true), without writing; changed arguments are refused. |

### page_rename

Scope: write. Effect: writes, destructive.

Rename a page, carrying its history, facts, links and timeline and redirecting the old slug. Requires expected_version from page_get. Refuses imported pages; rename them upstream. Old search mirrors are removed immediately; the next cycle indexes the new slug. Both slugs must be within your write grant. Static public bearer: forbidden.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from` | string | yes |  |
| `to` | string | yes |  |
| `expected_version` | integer (≥ 1) | yes |  |

### page_delete

Scope: write. Effect: writes, destructive, idempotent.

Idempotent soft-delete: sets deleted_at, retains page and version history. Requires source-scoped write or internal token; static public bearer forbidden.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `reason` | string | no | Optional trimmed one-line reason, ≤500 Unicode code points; secret-scanned, stored only with a new version. |
| `slug` | string | yes |  |
| `written_by` | string | no |  |
| `expected_version` | integer (≥ 0) | no | Require this page_get version/page_versions version_n; 0 requires absence. Deleted pages retain versions: use current_version from a failed 0 attempt. Mismatch writes nothing and returns current_version. Omit for an unconditional write, subject to precondition policy. |
| `force` | boolean | no | Overwrite unconditionally, on purpose. Cannot be combined with expected_version. |

### page_restore

Scope: write. Effect: writes, idempotent.

Undelete a soft-deleted page (clears deleted_at). The inverse of page_delete; no-op if the page is missing or already live. WRITE — static public bearer: forbidden; authenticated token: requires the `write` scope (source-scoped); internal token: allowed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes |  |
| `written_by` | string | no |  |

### page_revert

Scope: write. Effect: writes, destructive.

Restore a prior body snapshot as a NEW version, retaining history. version names the target version_n from page_versions. Requires source-scoped write or internal token; static public bearer forbidden.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `reason` | string | no | Optional trimmed one-line reason, ≤500 Unicode code points; secret-scanned, stored only with a new version. |
| `slug` | string | yes |  |
| `version` | integer (≥ 1) | yes |  |
| `written_by` | string | no |  |
| `expected_version` | integer (≥ 0) | no | Require this page_get version/page_versions version_n; 0 requires absence. Deleted pages retain versions: use current_version from a failed 0 attempt. Mismatch writes nothing and returns current_version. Omit for an unconditional write, subject to precondition policy. |
| `force` | boolean | no | Overwrite unconditionally, on purpose. Cannot be combined with expected_version. |

### link

Scope: write. Effect: writes, idempotent.

Assert a typed source→target link; repeating (source,target,type) updates confidence/chunk_id. Confidence defaults 1. works_at/located_at hold one value at a time: a new dated value closes the open one; an overlap, or no valid_from once dated, is refused (link_interval_conflict). Public writes require MEMRAIN_PUBLIC_WRITE=1.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `valid_from` | string | no | Optional inclusive start YYYY-MM-DD. Omission preserves the stored bound; an existing bound cannot change. |
| `valid_until` | string | no | Optional exclusive end YYYY-MM-DD. Must follow valid_from; an existing bound cannot change. |
| `source_slug` | string | yes | The source page slug. Must reference an existing page (FK constraint). |
| `target_slug` | string | yes | The target slug (soft reference; the page may or may not yet exist). Loose names like `Alice Smith` are normalised to `alice-smith`. |
| `type` | string | yes | One of: wikilink, mentions, works_at, attended, founded, advises, invested_in, knows, met, located_at, related_to, supersedes, contradicts. Pass allowAdHocType=true to accept other types. |
| `confidence` | number (0–1) | no | 0..1, default 1.0 for agent-asserted edges. Use <1.0 only for deterministic-extractor outputs whose surface form was ambiguous. |
| `source_chunk_id` | string | no |  |
| `allowAdHocType` | boolean | no |  |

### unlink

Scope: write. Effect: writes, destructive, idempotent.

Remove a manually created typed link. Returns removed and derived_from_text for edges still supplied by markdown/frontmatter/mentions; edit the source page with page_edit to remove those. Idempotent. WRITE — static public bearer: forbidden; authenticated token: requires write scope in its source; internal token: allowed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_slug` | string | yes |  |
| `target_slug` | string | yes |  |
| `type` | string | yes |  |

### add_fact

Scope: write. Effect: writes.

Record an entity claim; corrections create new facts. Identical entity/source/writer claims refresh (inserted:false). Withdrawn entity/source/visibility claims stay withdrawn across case/whitespace changes (withdrawn:true,id:null). Default private is operator-only; tenants use world to recall writes. Provenance: source_slug/source_chunk_id/written_by, else caller; public cannot set written_by. replaces supersedes a live fact, returning replaced. Batch ≤20 items inherits top-level defaults; all validate before writing. Results include saved/failed/partial and outcomes; all-failed is a tool error, mixed status:partial. Public forbids items/replaces; writes need MEMRAIN_PUBLIC_WRITE=1.

Call shape: `{entity_slug, fact} or {entity_slug, items:[{fact}]}`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `valid_from` | string | no | Date the claim became true (YYYY-MM-DD or ISO timestamp, stored as its UTC date). |
| `kind` | string (one of `event`, `preference`, `commitment`, `belief`, `fact`) | no |  |
| `notability` | string (one of `high`, `medium`, `low`) | no |  |
| `claim_metric` | string | no | Metric name; normalized to lower-case snake_case. |
| `claim_value` | number | no | Finite numeric value; put the unit in claim_unit. |
| `claim_unit` | string | no |  |
| `claim_period` | string | no |  |
| `entity_slug` | string | no | Entity (e.g. people/alice); required unless every batch item names one. A bare name resolves uniquely within your write source (entity_resolved_from), else stays unchanged with entity_unresolved and ≤5 candidates. Qualified slugs need not exist. |
| `fact` | string | no | Short claim, one sentence. Required unless `items` is given. |
| `confidence` | number (0–1) | no |  |
| `source_slug` | string | no | Page the fact was extracted from. |
| `source_chunk_id` | string | no |  |
| `written_by` | string | no |  |
| `visibility` | string (one of `private`, `world`) | no | Who may read the fact back. `private` (the default) is operator-only; `world` is also readable by tenant-scoped and public callers. Ignored on public ingress, which always writes `private`. |
| `request_id` | string | no | Optional retry id (1-128 chars), retained 7 days. Same id+arguments replays the first result (replayed:true), without writing; changed arguments are refused. |
| `replaces` | integer (≥ 1) | no | Id of a live fact in your own source that this fact replaces. Not combinable with `items` (put it on the item instead). |
| `items` | array | no | Batch 1..20 {fact,entity_slug?,confidence?,visibility?,replaces?}, instead of fact. Items override top-level valid_from/kind/notability/claim_metric/value/unit/period defaults. |

### add_timeline_event

Scope: write. Effect: writes.

Append a timeline event to an existing page. Returns the stored row, including the original on a duplicate, subject to read redaction. Correct a mistake by appending a new event describing the correction; the original remains. Idempotent on (slug, occurred_at, source_chunk_id) when source_chunk_id is provided. WRITE — refused on public ingress unless the operator sets MEMRAIN_PUBLIC_WRITE=1.

Call shape: `{slug, occurred_at, event}`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The page the event is attached to. Must reference an existing page (FK CASCADE). |
| `occurred_at` | string | yes | When the event happened (ISO-8601). Not when it was recorded. |
| `event` | string | yes |  |
| `source_chunk_id` | string | no |  |
| `request_id` | string | no | Optional retry id (1-128 chars), retained 7 days. Same id+arguments replays the first result (replayed:true), without writing; changed arguments are refused. |

### add_tag

Scope: write. Effect: writes, idempotent.

Add a tag to a page (normalized: trim + lowercase). Idempotent. The page must exist. WRITE — refused on public ingress unless the operator sets MEMRAIN_PUBLIC_WRITE=1.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes |  |
| `tag` | string | yes |  |

### remove_tag

Scope: write. Effect: writes, destructive, idempotent.

Remove a tag from a page. Idempotent (removing an absent tag is a no-op). WRITE — static public bearer: forbidden; authenticated token: requires the `write` scope (source-scoped); internal token: allowed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes |  |
| `tag` | string | yes |  |

### forget_fact

Scope: write. Effect: writes, destructive, idempotent.

Durably withdraw by id within entity/source/visibility, retiring identical live copies (withdrawn_duplicates). Re-add/extraction/import cannot revive it; no undo, audit retained. Repeats no-op; unknown id gives found:false. Stores optional reason. Returns ≤5 similar_active ids/scores for distinct rewordings: confirm separately. Requires owning-source write; static public forbidden.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | integer (≥ 1) | yes | Fact id to forget (entity_facts.id). |
| `reason` | string | no | Optional audit note stored on the forgotten row. |

### set_take_status

Scope: write. Effect: writes, idempotent.

Set a synthesized take's review status: mark it 'accepted' or 'rejected' by take_key. Advisory only — never mutates notes, only the take's own review flag. Tenant-scoped: a take_key that isn't yours is a no-op. Internal-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `take_key` | string | yes | The take's take_key (from list_takes). |
| `status` | string (one of `accepted`, `rejected`) | yes | New review status. |

### takes_add

Scope: write. Effect: writes.

Append a canonical takes-fence row; retain other rows/history. Requires owned page, current version and permitted holder; records authenticated actor. dry_run previews; optional plan_hash pins it. Static public forbidden.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | Owning live page slug. |
| `expected_version` | integer (≥ 1) | yes | Required current page version. |
| `dry_run` | boolean | no | Preview the bounded row diff without writes or model calls. |
| `plan_hash` | string | no | Optional SHA-256 from the matching preview. |
| `reason` | string | no | Optional version reason, up to 500 Unicode code points. |
| `wait_for_index` | boolean | no | Wait for the search mirror after applying. |
| `claim` | string | yes | Single-line claim, up to 4000 Unicode code points. |
| `kind` | string (one of `fact`, `take`, `bet`, `hunch`, `prediction`, `judgment`) | yes |  |
| `weight` | number (0–1) | no |  |
| `since` | string | no | Start date, YYYY-MM-DD. |
| `until` | string | no | End date, YYYY-MM-DD; requires since. |
| `source` | string | no | Single-line citation, up to 4000 Unicode code points. |
| `holder` | string | yes | world, brain, people/<slug> or companies/<slug>; constrained by the credential. |

### takes_update

Scope: write. Effect: writes, destructive.

Patch a canonical takes row at the required page version; retain unrelated bytes/rows and holder. Changed claims clear old resolution. dry_run previews; plan_hash pins it. Static public forbidden.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | Owning live page slug. |
| `expected_version` | integer (≥ 1) | yes | Required current page version. |
| `dry_run` | boolean | no | Preview the bounded row diff without writes or model calls. |
| `plan_hash` | string | no | Optional SHA-256 from the matching preview. |
| `reason` | string | no | Optional version reason, up to 500 Unicode code points. |
| `wait_for_index` | boolean | no | Wait for the search mirror after applying. |
| `row_num` | integer (1–2147483647) | yes |  |
| `claim` | string | no | Single-line claim, up to 4000 Unicode code points. |
| `kind` | string (one of `fact`, `take`, `bet`, `hunch`, `prediction`, `judgment`) | no |  |
| `weight` | number (0–1) | no |  |
| `since` | string | no | Start date, YYYY-MM-DD. |
| `until` | string | no | End date, YYYY-MM-DD; requires since. |
| `source` | string | no | Single-line citation, up to 4000 Unicode code points. |
| `active` | boolean | no | False retracts the row using strikethrough; true reactivates it. |

### takes_resolve

Scope: write. Effect: writes, destructive.

Resolve an active take atomically in its page/ledger. Requires current version and holder permission; actor/time are server-set. dry_run previews; plan_hash pins the request, but apply's timestamp may change after_hash. Static public forbidden.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | Owning live page slug. |
| `expected_version` | integer (≥ 1) | yes | Required current page version. |
| `dry_run` | boolean | no | Preview the bounded row diff without writes or model calls. |
| `plan_hash` | string | no | Optional SHA-256 from the matching preview. |
| `reason` | string | no | Optional version reason, up to 500 Unicode code points. |
| `wait_for_index` | boolean | no | Wait for the search mirror after applying. |
| `row_num` | integer (1–2147483647) | yes |  |
| `quality` | string (one of `correct`, `incorrect`, `partial`, `unresolvable`) | yes |  |
| `evidence` | string | no | Single-line evidence, up to 4000 Unicode code points. |
| `value` | number | no | Finite numeric result, preserved without display rounding. |
| `unit` | string | no |  |

### extract_facts

Scope: write. Effect: writes.

Extract events, preferences, commitments and beliefs from text OR a source_ref page in your grant. Preview by default; persist:true needs write scope and stores rows in your source. entity_hints steer extraction; session_id and visibility stamp stored facts. Input is sanitized and DATA-fenced. Paid, budget-guarded Bedrock; returns enabled:false unless MEMRAIN_FACTS_EXTRACTION=1. Internal-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | no | Raw conversation/transcript text to extract from. Provide this OR `source_ref`. |
| `source_ref` | string | no | A page slug whose markdown_body is extracted (tenant-scoped). Provide this OR `text`. |
| `persist` | boolean | no | Write the extracted facts to the ledger (default false = preview only). Requires a write grant. |
| `entity_hints` | string | no | Comma/space-separated canonical entity slugs to steer the extractor. |
| `session_id` | string | no | Capture-session id stamped on persisted facts. |
| `visibility` | string (one of `private`, `world`) | no | Default visibility for persisted facts (default private). |

### think

Scope: write. Effect: writes.

Multi-hop cited synthesis from pages, takes, graph and trajectories, with conflicts/gaps. Paid, budget-guarded Sonnet; default-off (ran:false unless MEMRAIN_THINK=1). save writes synthesis/<slug> + evidence; take queues its anchor-pinned headline. Both are operator-only, silently ignored otherwise. rounds 1..3 feeds gaps into scoped retrieval. synthesis_status: ok/empty_answer/not_json/output_truncated/no_llm/model_unusable/llm_error. Failed composition over gathered pages keeps synthesis:null and adds a cited extractive fallback (kind:extractive, no model call, never saved).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `question` | string | yes | The question to think about. |
| `anchor` | string | no | Pull the entity subgraph + trajectory around this slug (required for take:true). |
| `rounds` | integer (1–3) | no | Gather/synthesize rounds; each extra round is a fresh paid call under the run budget. Default 1. |
| `save` | boolean | no | Persist the synthesis as a page + evidence rows. Operator-only; ignored otherwise. |
| `take` | boolean | no | Queue the answer's headline claim as a synth_take on `anchor`. Operator-only; ignored otherwise. |
| `model` | string | no | Model id override for the synthesis call. |
| `since` | string | no | Only gather pages whose content date is >= this ISO date. |
| `until` | string | no | Only gather pages whose content date is <= this ISO date. |
| `with_calibration` | boolean | no | Inject the calibration anti-bias block (opt-in). |
| `k` | integer (1–50) | no | Page hits to gather (default 12). |
| `max_takes` | integer (1–100) | no | Take rows to gather (default 20). |
| `reference_date` | string | no | The day to treat as today when reading relative dates in the question (YYYY-MM-DD, not in the future). Default: today in the brain's time zone. |

### put_raw_data

Scope: write. Effect: writes, destructive, idempotent.

Upsert a page payload keyed by (slug,source), REPLACING the prior payload, not keeping history; max 1 MB. source is a data-provider/importer label, not tenant ownership. Requires a live page (else not_found) in the caller’s write source. Write; public forbidden.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The owning page slug; must be a live page. |
| `source` | string | yes | Data-source label, e.g. an importer name. |
| `data` | object | yes | The raw payload (plain JSON object, <= 1 MB serialized). |

### log_ingest

Scope: write. Effect: writes.

Append one ingestion-event row to the audit log (importer/webhook runs, absorb outcomes). Stamped with the caller's write source. WRITE.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_type` | string | yes | Event family, e.g. 'facts:absorb' or an importer name. |
| `source_ref` | string | yes | What was ingested (path, URL, slug). |
| `pages_updated` | array | no | Slugs touched by the run (array of strings). |
| `summary` | string | no | One-line human outcome summary. |

### retry_job

Scope: write. Effect: writes. Operator only.

Re-queue a failed or cancelled job for another attempt (status -> pending, next_attempt_at = now). Returns the refreshed row, or found:false when the id is unknown or the job is not in a retryable state. Operator-only. WRITE — refused on public ingress.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Job id (see jobs_list). |

### ontology_propose

Scope: write. Effect: writes.

Record a dimensional observation about an entity (entity has dimension=value, e.g. role=advisor). Sourced, confidence-weighted, and bi-temporal: a novel dimension lands quarantined, a same-value re-observation corroborates, a different value supersedes forward (or closes a backdated interval). WRITE — refused on public ingress.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entity` | string | yes | Entity slug the claim is about (e.g. people/alice). |
| `dimension` | string | yes | Axis name (e.g. role, employer, location). |
| `value` | string | yes | The value on that axis. |
| `source` | string | no | Provenance page slug (source_slug); omit for a manual claim. |
| `confidence` | number (0–1) | no | 0..1, default 0.7. |
| `valid_from` | string | no | Start of validity, YYYY-MM-DD. Default today; null = -infinity. |
| `visibility` | string (one of `private`, `world`) | no | Row visibility (default private). |

### chronicle_backfill

Scope: write. Effect: writes. Operator only.

Enqueue one paid chronicle-extract job per eligible scoped conversation page, excluding diary/events. Returns pages_enqueued and per-page MEMRAIN_CHRONICLE_WRITE_BUDGET_USD for worst-case spend. dry_run:true counts only. Operator-only write; public forbidden.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dry_run` | boolean | no | Count eligible pages without enqueuing (default false). |
| `limit` | integer (1–500) | no | Max pages to sweep (default 100, hard cap 500). |

## Admin tools

### purge_deleted_pages

Scope: admin. Effect: writes, destructive.

HARD-delete soft-deleted pages older than older_than_hours (default 720 = 30 days; document cycle TTL stays 72). Cascades page versions, aliases and links; also deletes raw_data, tags and redirects to purged slugs, with per-table counts. Returns reaped slugs, count and ttl_hours. Admin scope in the owning source or internal token required; static public bearer forbidden. page_delete needs write scope; purge needs admin.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `older_than_hours` | number (≥ 0) | no | Age cutoff in hours. Pages soft-deleted longer ago than this are reaped. Default 720 (30 days). |
| `slugs` | string[] | no | Only these slugs, and only those soft-deleted past the cutoff. Omit to reap every expired page. |
| `dry_run` | boolean | no | Reap nothing; return `planned` (the slugs a real run would reap now) and its `plan_hash`. |
| `expected_plan_hash` | string | no | The `plan_hash` of an earlier dry run. The purge is refused unless the plan still hashes the same, so exactly the reviewed pages go. |

### quarantine_list

Scope: admin. Effect: writes. Operator only.

Operator-only, read-only quarantined IDs/sources/paths/fixed reason codes. No titles, bodies or free-form details. Default 20, max 100.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer (1–100) | no |  |
| `source_ids` | string[] | no | Narrow to exact sources; [] reads nothing. |

### extraction_review

Scope: admin. Effect: writes. Operator only.

Operator-only metadata candidates: missing same-source entity pages and similar facts from at most 200 recent eligible rows; scanned/scan_truncated report bounds. No queues, merges, deletes or models.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer (1–100) | no |  |
| `source_ids` | string[] | no | Narrow to exact sources; [] reads nothing. |

## Agent tools

### submit_agent

Scope: agent. Effect: writes.

Queue a read-only research agent that runs under your own grant: it reads only your sources, uses only the read tools your client is bound to, spends against your daily budget, and stops if your grant is revoked or changed. Returns a job_id; poll get_agent_job. Needs the 'agent' scope, a daily budget on your client, and a free slot under your client's concurrency limit. Writes nothing.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task` | string | yes | What the agent should find out, in plain language (at most 8 KB). |
| `max_usd` | number | no | Spend ceiling for this job in USD; clamped to the brain's per-job ceiling. |

### get_agent_job

Scope: agent. Effect: read-only.

Status and answer of an agent job you submitted with submit_agent: status, stop_reason, final_text, cost_usd, turns and an error when it failed. A job that is not yours reads as not found.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `job_id` | string | yes |  |
