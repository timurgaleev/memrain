# Memrain — Personal-Knowledge Brain

Hybrid vector + keyword search over one person's pages. Single contract: MCP
JSON-RPC at `POST /mcp`. Any MCP-compatible client (Claude Code, Codex,
claude.ai, ChatGPT) calls it at `https://brain.<your-domain>/mcp`; in-stack
callers reach it on the internal Docker network.

Bun + TypeScript runtime. Storage: **RDS Postgres 16** + pgvector + tsvector,
or an embedded PGLite database. Embeddings: Bedrock Titan Text Embeddings v2
(1024-dim), the only model the server calls.

## What it does

- Stores pages with full version history; every write is a new version.
- Indexes pages written over MCP, and markdown files from the configured vault
  path (`/memory` in the container) when `reindex` runs, into a hybrid index —
  vectors for semantic recall, tsvector for keyword precision, fused with
  Reciprocal Rank Fusion.
- Keeps `[[wikilinks]]`, typed links and tags, so it can answer "what links to
  X" and "pages tagged Y".
- Runs one hourly housekeeping pass inside `serve`: purge pages past their
  soft-delete window, rebuild missing search mirrors, embed chunks that have no
  vector, sweep expired OAuth tokens, expire unsettled spend holds, and trim
  the request log. `MEMRAIN_CYCLE=0` turns it off.
- Exposes 29 MCP tools (search, search_exact, resolve_slugs, get_chunks,
  page_{get,list,versions,put,append,edit,rename,delete,restore,revert},
  purge_deleted_pages, index, link, unlink, get_links, backlinks, add_tag,
  remove_tag, get_tags, get_brain_identity, whoami, stats, sources_list,
  sources_status, run_doctor); the full list is
  [docs/TOOLS.md](../../../docs/TOOLS.md). `/mcp` accepts a personal access
  token, an OAuth access token or the public bearer; what a caller may do
  follows its scopes and sources. In-stack callers send
  `MEMRAIN_INTERNAL_TOKEN`.
- HTTP routes: `POST /mcp` (the agent contract), `GET /health`, the OAuth
  discovery documents under `/.well-known/`, the OAuth flow at `/authorize`,
  `/token`, `/register` (only with `MEMRAIN_ENABLE_DCR=1`) and `/revoke`, and
  `/admin` with its own sign-in. Every tool is reached through `tools/call` on
  `/mcp`.

## What it isn't

- Not a chat agent. It returns ranked passages with their sources; the client
  writes the answer.
- Not a public-facing API by default. The internal Docker network is the
  primary route. The optional public MCP HTTPS surface is the remote AI client
  path; each client authenticates with its own token.
- Not a generic vector DB. The data model is page-shaped: `pages` (with
  versions) → `documents` → `chunks` → embeddings, plus links and tags.

## Quick CLI surface

`bun run src/cli.ts --help` is the live list. The main commands:

| Command | Purpose |
|---|---|
| `init --pglite` | create `~/.memrain/` with an embedded PGLite database |
| `serve --http --port 18790` | start the server (loopback only by default) |
| `reindex [--all] [--vault P] [--reconcile-deletes]` | walk a vault, index changed (or all) files |
| `embed [--dry-run] [--limit N] [--all] [--stale]` | backfill missing vectors, or re-embed targets |
| `export --dir DIR [--source ID]` | export live pages as markdown |
| `import --dir DIR --source ID [--apply --plan-hash HASH]` | preview/create new pages from an export; never overwrites existing or deleted slugs |
| `transcripts ingest <path>` / `transcripts status` | import ChatGPT, Claude.ai, Codex and Claude Code history as redacted pages |
| `sources list\|show\|register\|update\|delete\|owner-only` | manage sources |
| `rename <from> <to> --expected-version N` | move a page and its history |
| `auth create\|list\|revoke` | personal access tokens |
| `auth register-client\|list-clients\|revoke-client\|set-redirect-uris` | OAuth clients |
| `auth set-budget <id> <usd\|none>` | a credential's daily spend cap |
| `auth doctor <base-url> --token-file F` | remote check: `/health` stamp, OAuth discovery, MCP, scope |
| `admin setup-link` | one-time link for the panel owner to create a passkey |
| `quarantine list\|clear\|scan` | the content-sanity quarantine |
| `write-gate list\|approve\|reject\|scan` | the write gate's held items |
| `secrets audit\|originals\|reveal\|restore\|backup` | the secret scanner and its sealed originals |
| `config show\|get\|set\|unset` | stored runtime settings (env still wins) |
| `doctor` / `status` | self-diagnostics / one-shot counts and health |
| `backup status --rds-instance ID --efs-id ID` | inspect RDS and EFS backup evidence |
| `apply-migrations [--dry-run]` | manual migration runner (`init`, which the container entrypoint runs, applies them automatically) |

## Read more

- `ARCHITECTURE.md` — internals, schema, search pipeline
- `API.md` — HTTP routes + MCP JSON-RPC reference
- `OPERATIONS.md` — deploy, restart, troubleshoot, rollback
