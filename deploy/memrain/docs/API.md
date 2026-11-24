# Memrain — API Reference

The Memrain server binds `0.0.0.0:18790` inside its container but is
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
  handler authenticates the client itself. `/register` (Dynamic Client
  Registration) answers only with `MEMRAIN_ENABLE_DCR=1`.
- `/admin` — the admin panel, behind its own sign-in.

## `GET /health`

Liveness, active engine kind and build stamp. No auth; no corpus counts (those
are behind the admin panel).

```jsonc
// 200 OK
{
  "ok": true,
  "db": "postgres",        // or "pglite"
  "version": "v0.26.0-0-gabc1234",  // build stamp from git describe ("dev" when unstamped)
  "edition": "lite",
  "schema_ahead": false,
  "keyword_only": true     // present only with MEMRAIN_KEYWORD_ONLY=1
}
```

A failed or timed-out database probe answers `503` with `ok: false` and a
generic `error`; `maintenance: true` is added in maintenance mode.

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
    "serverInfo": { "name": "memrain", "version": "<build stamp, same as /health>" },
    "capabilities": { "tools": {} }
  }
}
```

### `tools/list`

```jsonc
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
```

Returns the tools the caller may call, each with a JSON-Schema draft-7
`inputSchema`. **`tools/list` is the live source of truth**, and each tool carries
MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`). The 29
tools, grouped:

- **Search** — `search`, `search_exact`, `resolve_slugs`, `get_chunks`.
- **Read pages** — `page_get`, `page_list`, `page_versions`.
- **Write pages** — `page_put`, `page_append`, `page_edit`, `page_rename`,
  `page_delete`, `page_restore`, `page_revert`, `purge_deleted_pages`, `index`.
- **Links and tags** — `link`, `unlink`, `get_links`, `backlinks`, `add_tag`,
  `remove_tag`, `get_tags`.
- **Brain and access** — `get_brain_identity`, `whoami`, `stats`,
  `sources_list`, `sources_status`, `run_doctor` (`stats` and `run_doctor` are
  operator only).

A call to any other tool name answers `not_found` (`unknown tool: <name>`).

On the **public** ingress, write tools and any tool that surfaces page
slugs / note content / operational state are filtered out of `tools/list`
and rejected from `tools/call` (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`) — see
Auth below. The static public bearer keeps `search`, `backlinks`,
`page_get`, `page_list`, `page_versions`, `get_brain_identity` and `whoami`.

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

Every code, with its class, retryability and what to do, is listed in
[docs/ERRORS.md](../../../docs/ERRORS.md); every tool and its parameters in
[docs/TOOLS.md](../../../docs/TOOLS.md). Both pages are generated from the code
(`bun scripts/gen-catalogs.ts`) and a test fails when they fall behind.

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

### Per-call source narrowing

`search` and `page_list` accept `source_ids`. It must be an array of at most 100
exact, nonempty source IDs, each at most 200 characters with no surrounding
whitespace. Duplicates are folded. Omission preserves the credential's grant;
`[]` selects no sources and `null` is invalid. Any ID outside a scoped grant
returns `permission_denied` before retrieval. Narrowing never grants access
to a tool or source the credential cannot already use. Page-list cursors
remain bound to the effective source scope; keep the same scope when
continuing a listing.

### Temporal manual links

`link` accepts `valid_from` and `valid_until` as calendar dates in `YYYY-MM-DD`
format. The start is inclusive, the end exclusive; when both are set, the end
must follow the start. Omitted bounds preserve existing values. A previously
unset bound may be assigned once, and repeating the same value is idempotent;
changing an assigned bound returns `conflict`. Existing links retain unbounded
dates until explicitly assigned.

`get_links` accepts:

| Parameter | Contract |
|---|---|
| `status` | `all` (default), `active`, `expired` or `future` |
| `as_of` | Optional valid `YYYY-MM-DD`; defaults to today's UTC date for filtered statuses; refused with `all` or omitted status |

Active links have no start or start on/before the chosen day, and have no end
or end after it. Expired links end on/before that day; future links start after
it. Filtering precedes limits. Omitted status preserves the previous shape; explicit status adds
nullable validity fields to authorized edge metadata. Public edge projections
continue to omit validity and provenance.

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

### CLI `--json`

`status`, `doctor`, `sources`, `secrets`, `export`, `engine` and `version`
accept `--json`, and with it stdout is exactly one JSON object —
`JSON.parse(stdout)` is enough. Progress and warnings stay on stderr; exit
codes are the same as without the flag.

- A command that has its own JSON report prints it unchanged, on success and
  on failure. The exit code says which it was.
- Other output is wrapped: `{"ok": true, "data": {"text": "…"}}`.
- A failure with no JSON report of its own is
  `{"ok": false, "error": {…}, "exit_code": N}`. A structured error adds
  `code`, `error_class`, `retryable` and a `docs` link into ERRORS.md.

```bash
memrain status --json | jq .
```

## Auth & exposure

- **Internal traffic** (no `Cf-Connecting-Ip`) keys into a single
  "internal" rate-limit bucket; the trust boundary is the Docker network.
  With `MEMRAIN_INTERNAL_TOKEN` set, an internal request needs
  `Authorization: Bearer <MEMRAIN_INTERNAL_TOKEN>` (or a personal access or
  OAuth token, with `auth.selfIssued.enabled`) and is refused with 401
  otherwise; a write `tools/call` that reaches the transport without the
  internal token returns JSON-RPC `-32001`. With the token unset, internal
  requests are not authenticated at all (a startup warning says so).
- **Public traffic** arrives via Cloudflare Tunnel
  (`https://brain.<your-domain>/mcp`). Cloudflare injects
  `Cf-Connecting-Ip`; the per-IP rate limiter keys on that. Public
  callers must present `Authorization: Bearer <public-bearer>`; the
  mutating tools are filtered from discovery and blocked from dispatch
  via `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` (in `mcp/dispatch.ts` /
  `http/public_guard.ts`) unless `MEMRAIN_PUBLIC_WRITE=1`. Public read
  tools additionally redact note bodies by default.
