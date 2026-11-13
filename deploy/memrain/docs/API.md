# Memrain — API Reference

The Memrain daemon binds `0.0.0.0:18790` inside its container but is
**reachable only on the Docker `internal` network** for in-stack
callers (via Docker DNS as `http://memrain:18790`) and through Cloudflare
Tunnel for the public MCP surface at `https://brain.<your-domain>/mcp`.

Routes:

- `POST /mcp` — JSON-RPC 2.0 entry point; every tool is reached via
  `tools/call`. Accepts a personal access token, an OAuth access token or
  the public bearer; in-stack callers send `MEMRAIN_INTERNAL_TOKEN`.
- `GET /health` — operational probe (no auth).
- `GET /.well-known/…` — OAuth authorization-server and protected-resource
  metadata (no auth).
- `/authorize`, `/token`, `/register`, `/revoke` — the OAuth flow; each
  handler authenticates the client itself.
- `POST /ingest` — webhook capture (needs the `write` scope). The capture is
  queued; before the job writes it re-checks the token that queued it, and a
  token revoked or narrowed in the meantime refuses the job for good.
- `/admin` — the admin panel, behind its own sign-in.

## `GET /health`

Liveness + DB stats + active engine kind. No auth.

```jsonc
// 200 OK
{
  "ok": true,
  "db": "postgres",   // or "pglite"
  "version": "0.1.0",
  "stats": { "documents": 114, "chunks": 244, "embeddings": 244 }
}
```

## MCP JSON-RPC transport — `POST /mcp`

Standard JSON-RPC 2.0, `Content-Type: application/json`. Single-request
or batched (array).

### `initialize`

```jsonc
// request
{ "jsonrpc": "2.0", "id": 1, "method": "initialize" }

// response
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "protocolVersion": "2025-03-26",
    "serverInfo": { "name": "memrain", "version": "0.1.0" },
    "capabilities": { "tools": {} }
  }
}
```

If at least one skill explicitly opts into prompts and is available to the
caller, `capabilities` also contains `"prompts": {}`. Public callers never
receive that capability.

### `prompts/list` and `prompts/get`

Prompts come from the configured skill pack. A skill must declare top-level
`prompt: true`, and the caller must have access to `list_skills`, `get_skill`
and every tool declared by that skill. No bundled skill is opted in by default.
The same contained-path, symlink and 256 KiB file-size checks used by
`get_skill` apply. Public callers receive `-32601` for both methods.

```json
{ "jsonrpc": "2.0", "id": 2, "method": "prompts/list", "params": {} }
```

The result contains `prompts: [{name, description}]`, at most 50 eligible
prompts in name order. Pass a returned `nextCursor` as `params.cursor` for
the next page. Descriptions are capped at 500 characters.

To retrieve an opted-in skill named `read`, for example:

```json
{ "jsonrpc": "2.0", "id": 3, "method": "prompts/get", "params": { "name": "read" } }
```

The result contains a description and one `user` text message containing the
skill's Markdown body without frontmatter. Arguments must be omitted or `{}`;
there is no interpolation, tool execution or model call. Hidden, unknown,
unreadable and unsafe names all return `-32602` with `Prompt not found`.

### `tools/list`

```jsonc
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
```

Returns every registered tool, each with a JSON-Schema draft-7
`inputSchema`. **`tools/list` is the live source of truth**, and each tool carries
MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`); the groups below are a map, not an exhaustive contract:

- **Search / retrieval** — `search`, `query` (refinement), `backlinks`,
  `get_chunks`, `resolve_slugs`, `relational_recall`, `stats`.
- **Pages** — `page_get`/`page_list`/`page_versions` + writes
  `page_put`/`page_append`/`page_delete`/`page_restore`/`page_revert` +
  `purge_deleted_pages`.
- **Graph & links** — `graph_neighbors`/`graph_query`/`traverse_graph`,
  `get_links`/`list_link_sources`, `link`/`unlink`.
- **Entities & facts** — `entity_facts`/`entity_timeline`/`entity_recall`,
  `add_fact`/`add_timeline_event`, `recall`/`forget_fact`,
  `add_tag`/`remove_tag`/`get_tags`.
- **Insights** — `find_orphans`, `find_experts`, `find_contradictions`,
  `find_trajectory`, `get_recent_salience`, `find_anomalies`.
- **Code graph** — `code_callers`, `code_callees`.
- **Push-context** — `volunteer_context`, `context_pack`, `context_delta`.
- **Advisor / skillpack** — `advisor`, `list_brain_skillpack`.
- **Synthesis (read)** — `list_concepts`, `list_takes`,
  `get_calibration_profile` (the opt-in LLM-synthesis output store).
- **Jobs** — `jobs_list`/`jobs_get`/`jobs_logs` + `jobs_submit`/`jobs_cancel`.
- **Admin / misc** — `index`, `log_friction`, `get_brain_identity`,
  `quarantine_list`, `extraction_review`.

On the **public** ingress, write tools and any tool that surfaces page
slugs / note content / operational state are filtered out of `tools/list`
and rejected from `tools/call` (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`) — see
Auth below. (`list_link_sources` and `get_brain_identity` are the only
catalogue/counter reads kept public-safe.)

### `tools/call`

```jsonc
{
  "jsonrpc": "2.0", "id": 3,
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": { "q": "your query", "k": 5 }
  }
}
```

Returns:
```jsonc
{
  "jsonrpc": "2.0", "id": 3,
  "result": {
    "content": [
      { "type": "text", "text": "<JSON-stringified tool result>" }
    ],
    "isError": false   // true if the tool errored — JSON-RPC error envelope is reserved for protocol failures
  }
}
```

### Tool errors

A known failure returns `isError: true` with a JSON envelope:

```jsonc
{
  "error": "version_conflict",        // stable machine code
  "error_class": "conflict",          // invalid_request | permission | not_found | conflict | refused | limit | transient
  "retryable": false,                 // true when the same request may succeed later
  "message": "…",                     // internal ingress only
  "suggestion": "…"                   // optional recovery hint
}
```

Public ingress omits `message`. An unexpected failure on public ingress
returns the text `internal error (incident <16 hex>)`; the server log line
for that failure carries the same incident id.

### Page write reasons

`page_put`, `page_edit`, `page_delete` and `page_revert` accept optional
`reason: string`. Nonblank reasons must be one line of valid Unicode text:
CR, LF, U+2028, U+2029, NUL and lone surrogates are refused. Whitespace is
trimmed; blank input becomes `null`. The trimmed value may contain at most
500 Unicode code points. Invalid input returns `invalid_params` before page
mutation, and long input is never truncated.

The reason follows the configured secret redaction, rejection or flag policy,
including cross-field echoes on put/edit. It is stored as `change_reason` on
an actual new version and returned by authorized `page_versions` reads,
including the default metadata-only projection. Old versions have `null`.
No-op writes and repeated deletion add no version. A revert records its own
new reason, or `null` when omitted, without copying the target version's reason.
Public responses omit reasons even when public body reads are enabled;
remote quarantined history also withholds them. Page content hashes and
snapshots do not incorporate reason metadata.

Fact reconciliation after `page_put`, `page_edit`, `page_append` and successful
`page_restore`/`page_revert` can return `superseded_rows`: bounded fact-fence row
numbers whose exact source/page/row/claim remains superseded. Stored page text
and tombstone history remain intact. Restore/revert reconcile only when
`restored`/`reverted` is true.

### Canonical take writes

`takes_add`, `takes_update` and `takes_resolve` edit the takes fence of an
existing live page. Every call requires `slug` and `expected_version` (integer
at least 1). The page must satisfy the caller's read/write source grants and
slug-prefix restrictions; holder permissions apply to previews and writes.
The static public bearer cannot call these tools.

| Tool | Required fields beyond slug/version | Optional operation fields |
|---|---|---|
| `takes_add` | `claim`, `kind`, `holder` | `weight`, `since`, `until`, `source` |
| `takes_update` | `row_num` and at least one field to update | `claim`, `kind`, `weight`, `since`, `until`, `source`, `active` |
| `takes_resolve` | `row_num`, `quality` | `evidence`, `value`, `unit` |

Kinds are `fact`, `take`, `bet`, `hunch`, `prediction` or `judgment`; holders are
`world`, `brain`, `people/<slug>` or `companies/<slug>` within the credential's
allowlist. Weight is 0–1 (new rows default to 0.5). Dates use `YYYY-MM-DD`;
`until` requires a start and cannot precede it. Claim, citation, evidence and
unit text are single-line, at most 4,000 Unicode code points, without embedded
fence markers. A claim must be nonblank. An update keeps the holder; changing
its claim clears the old resolution. Grades are bound to the exact claim text;
editing it preserves earlier grades as history, excludes them from current
scorecards/calibration and permits a fresh grade. Legacy canonical grades
without a claim binding remain stored but do not count as current evidence.
`active:false` retracts the row using
strikethrough and `true` reactivates it. Resolution requires an active row and
quality `correct`, `incorrect`, `partial` or `unresolvable`; a supplied numeric
value must be finite. The server supplies the actor and resolution timestamp.

All three accept `dry_run`, `plan_hash`, `reason` and `wait_for_index`.
`dry_run:true` is a read-only preview without model calls. The result includes
`row_num`, `take_key`, version/hash metadata, warnings and a bounded `row_diff`
(before/after, at most 2,000 code points each). External row text is escaped
and framed as external content, and the existing secret policy applies.

To apply a reviewed preview, repeat its inputs with `dry_run:false` and its
optional SHA-256 `plan_hash`. The hash pins the page/version, mutation, actor,
scope and secret policy; stale inputs return `conflict`. A resolution's
server timestamp can make applied `after_hash` differ from the preview while
the request's `plan_hash` remains valid. `expected_version` is always required,
even without a plan hash.

Page body/version changes and projection of the targeted canonical take row
commit in one SQL transaction. Other rows and unrelated bytes are retained;
malformed or ambiguous fences are refused. If secret scanning would change
unrelated content, repair that content before retrying. Apply uses the normal
page-indexing path; `wait_for_index:true` waits for its search mirror. The
optional reason follows the page write-reason contract above.

### Bounded context and operator review

These tools run through `tools/call` and are unavailable to the static public
bearer. They make no inference calls or content writes. They accept optional
`limit` (integer 1–100, default 20) and `source_ids` (an array that only narrows
the caller's grant; `[]` reads nothing).

| Tool | Access | Additional input | Result |
|---|---|---|---|
| `context_delta` | Read scope | Required `since`: `YYYY-MM-DD` or UTC ISO timestamp with seconds, optional 1–3 fractional digits and `Z` | `since`, `complete_change_log:false`, and independent `pages`, `facts`, `events` sections containing `items`, `truncated`, `time_basis` |
| `quarantine_list` | Operator only; admin scope alone is insufficient | None | `items` containing `id`, `source_id`, `source_path`, `reason`, plus `truncated` |
| `extraction_review` | Operator only; admin scope alone is insufficient | None | `candidates`, `truncated`, `scanned`, `scan_truncated` |

`context_delta` applies the limit separately to each section after source,
quarantine, lifecycle and remote diary filters. Page items contain slug,
source, type and update timestamp; fact items contain fact IDs, entity slugs,
source, text and write timestamp; event items contain IDs, entity and event
slugs, source, date and summary. External fact/event text keeps its trust frame.
The time bases are `updated_at`, `written_at` and `event_date` respectively.
Events include the entire UTC day containing `since`, even when a timestamp
was supplied. This read does not touch retrieval counters and is not a complete
change log, deletion feed or point-in-time snapshot.

`quarantine_list` returns live held documents in stable source/path/ID order.
Reason codes are `junk_pattern`, `literal_substring` or `unknown`; titles,
bodies and arbitrary quarantine details are omitted.

`extraction_review` inspects at most 200 recent eligible ordinary facts of
4,096 characters or fewer, excluding hidden, diary and retired evidence.
`missing_entity_page` candidates contain `source_id`, `entity_slug`, `fact_id`.
`similar_facts` candidates contain `source_id`, `entity_slug`, `fact_ids` and
`similarity`; pairs must share a source, entity and speaker, pass the protected
amount/date/polarity check and have token-set similarity of at least 0.85.
No fact text is returned. `scanned` counts the inspected pool;
`scan_truncated` reports more eligible facts beyond it, independently of the
candidate result's `truncated` flag. Candidates do not create a queue or trigger
creation, merge, deletion or extraction.

### Per-call source narrowing

`search`, `query`, `page_list`, `context_delta`, `quarantine_list` and
`extraction_review` accept `source_ids`. It must be an array of at most 100
exact, nonempty source IDs, each at most 200 characters with no surrounding
whitespace. Duplicates are folded. Omission preserves the credential's grant;
`[]` selects no sources and `null` is invalid. Any ID outside a scoped grant
returns `permission_denied` before retrieval or inference. Narrowing never
grants access to a tool or source the credential cannot already use.

The effective source set also reaches refinement, caches, hydration,
supplementary facts, trust framing and hot-memory metadata. Page-list cursors
remain bound to the effective source scope; keep the same scope when continuing
a listing.

### Temporal manual links

`link` accepts `valid_from` and `valid_until` as calendar dates in `YYYY-MM-DD`
format. The start is inclusive, the end exclusive; when both are set, the end
must follow the start. Omitted bounds preserve existing values. A previously
unset bound may be assigned once, and repeating the same value is idempotent;
changing an assigned bound returns `conflict`. Existing links retain unbounded
dates until explicitly assigned.

`graph_neighbors`, `graph_query`, `traverse_graph` and `get_links` accept:

| Parameter | Contract |
|---|---|
| `status` | `all` (default), `active`, `expired` or `future` |
| `as_of` | Optional valid `YYYY-MM-DD`; defaults to today's UTC date for filtered statuses; refused with `all` or omitted status |

Active links have no start or start on/before the chosen day, and have no end
or end after it. Expired links end on/before that day; future links start after
it. One day is used throughout a traversal, and filtering precedes expansion
and limits. Omitted status preserves the previous shape; explicit status adds
nullable validity fields to authorized edge metadata. Public edge projections
continue to omit validity and provenance.

### Typed numeric contradictions

`find_contradictions {mode:"typed", entity_slug?, limit?}` returns
`{ok:true, mode:"typed", typed:[...], truncated}`. `entity_slug` is an exact
filter; `limit` defaults to 20 groups, maximum 200. `slug` and `severity` are
invalid in typed mode. Omitting `mode` retains the asserted/probed response.

Groups share `entity_slug`, `source_id`, `attributed_to`, normalized `metric`,
`unit`, `period` and `month` of `valid_from`. Claims must have finite numeric
values, known valid start dates, overlapping half-open validity intervals and
different numeric values. There is no date inference or currency/unit
conversion; incomplete claim metadata is excluded. Source, visibility,
quarantine and remote diary filters precede grouping.

Each group contains at most 20 `claims` and its own `truncated` flag. Claims
include string `id`, exact decimal-string `value`, `fact`, validity bounds and
source slugs. A divergent pair is retained even when equal-value copies fill
the group. External fact text remains framed and output redaction still
applies. The operation performs no writes or inference calls.

### Retrieval provenance, diagnostics and cost

Search and query hits may include `generated:true`. This requires a current
same-source canonical page version written by a recognized internal generator
with the operator principal, matching body/truth snapshots and hash, and
matching chunk content. A writer label, slug prefix or unknown legacy principal
alone is insufficient. The field is omitted when proof is absent and changes
neither ranking nor trust framing.

Operator `search` and `query` calls with `explain:true` add
`meta.timings_ms` and `meta.pending_embeddings`. Stage timings use a monotonic
clock; pending embeddings count eligible chunks within the effective source
and query filters, excluding code, embed-skipped, quarantined, deleted and
archived documents. A failed count yields `null`, not zero. Tenant/public
metadata omits these fields.

For a query with `refine`, `refinement` measures both searches and their fusion
as one interval, and `projection` measures framing and supplementary facts.
The pending count runs once for the effective source/page filters. Inner
search timings are not added together; refinement diagnostics preserve the
underlying cache behavior and do not start additional inference requests.

When an operator tool call starts at least one metered inference request, the
MCP result also includes `_meta.cost`:

| Field | Meaning |
|---|---|
| `calls` | Metered requests actually started in this dispatch, including nested work |
| `known_usd` | Sum of known settled costs |
| `unknown_calls` | Started calls without a known settled cost |
| `usd` | Total known cost when `unknown_calls` is zero; otherwise `null` |

Pending, timed-out and unpriced calls stay unknown. Parallel dispatches do not
share counters, and requests with no metered call omit `_meta.cost` entirely.
The field is operator-only; an admin-scoped client does not receive it.
Serialized tool-result JSON is compact, without changing values or numeric
precision.

### `ping`

```jsonc
{ "jsonrpc": "2.0", "id": 99, "method": "ping" }
// → { "jsonrpc": "2.0", "id": 99, "result": {} }
```

### Error codes

Standard JSON-RPC + two server-defined:

| Code | Meaning |
|---|---|
| -32700 | parse error (malformed JSON) |
| -32600 | invalid request (missing `jsonrpc: "2.0"`/`method`, or a write tool called from the public ingress) |
| -32601 | method not found |
| -32602 | invalid prompt parameters or unavailable prompt |
| -32603 | internal error |
| -32000 | rate limit exceeded (per-IP token bucket) |
| -32001 | unauthorized — a write tool was called on the internal path without `MEMRAIN_INTERNAL_TOKEN` |

Tool-call errors (a tool throwing) are returned as `result.isError =
true`, NOT as JSON-RPC errors — that's per the MCP spec.

## Calling it

From an MCP client over the public surface (the normal path):

```bash
curl -fsS -X POST https://brain.<your-domain>/mcp \
  -H "Authorization: Bearer <public-bearer>" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"q":"hello","k":1}}}'
```

Or on the EC2 host, directly against the container on the internal
network:

```bash
docker exec deploy-memrain-1 sh -c '
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"stats\"}}" \
    | wget -qO- --post-file=/dev/stdin --header=Content-Type:application/json http://127.0.0.1:18790/mcp
'
```

## Auth & exposure

- **Internal traffic** (no `Cf-Connecting-Ip`) keys into a single
  "internal" rate-limit bucket; the trust boundary is the Docker network.
  Read tools are open. **Write tools require
  `Authorization: Bearer <MEMRAIN_INTERNAL_TOKEN>`** — without it a write
  `tools/call` returns JSON-RPC `-32001` (closes the compromised-sibling
  kill-chain). When the token is unconfigured the gate falls through open
  (legacy single-node mode, with a startup warning).
- **Public traffic** arrives via Cloudflare Tunnel
  (`https://brain.<your-domain>/mcp`). Cloudflare injects
  `Cf-Connecting-Ip`; the per-IP rate limiter keys on that. Public
  callers must present `Authorization: Bearer <public-bearer>`; the
  mutating tools are filtered from discovery and blocked from dispatch
  via `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` (in `mcp/dispatch.ts` /
  `http/public_guard.ts`) unless `MEMRAIN_PUBLIC_WRITE=1`. Public read
  tools additionally redact note bodies unless `MEMRAIN_PUBLIC_READ_BODIES=1`.
