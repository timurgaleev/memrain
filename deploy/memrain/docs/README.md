# Memrain — Personal-Knowledge Brain

Hybrid vector + keyword + entity-graph search over your markdown notes
and code. Single contract: MCP JSON-RPC at `POST /mcp`. Any
MCP-compatible client (Claude Code, Cursor, Codex) calls the public
surface at `https://brain.<your-domain>/mcp`; in-stack callers reach it
on the internal Docker network.

Bun + TypeScript runtime. Storage: **RDS Postgres 16.13** + pgvector +
tsvector. Embeddings: Bedrock Titan v2 (1024-dim).

## What it does

- Indexes markdown documents from configured vault paths (currently
  `/memory`) into a hybrid index — vectors for semantic recall,
  tsvector for keyword precision, RRF fuse.
- Maintains an entity graph (`[[wikilinks]]`, `#hashtags`, dates,
  frontmatter `tags:`) so we can answer "what links to X" and
  "documents tagged Y".
- Runs a 15-phase maintenance cycle every 6 h (`lint`, `embed-stale`,
  `embed-gaps`, `mirror-pages`, `embed-facts`, `extract`,
  `resolve-symbol-edges`, `links-stale`, `reconcile-links`, `orphans-purge`, `recompute-salience`,
  `extract-timeline`, `timeline-anchor`, `snapshot`, `purge`) — the
  authoritative list is `ALL_PHASES` in `src/core/cycle/index.ts`. The
  paid synthesis and facts-maintenance phases are opt-in and run only
  when named explicitly.
- Exposes its MCP tools (search, index, backlinks, stats,
  page_{put,append,delete,get,list,versions}, link, unlink,
  graph_{neighbors,query}, entity_{facts,timeline,recall},
  add_fact, add_timeline_event, jobs_{submit,list,get,cancel,logs},
  log_friction). `/mcp` accepts a personal access token, an OAuth access
  token or the public bearer; what a caller may do follows its scopes and
  sources. In-stack callers send `MEMRAIN_INTERNAL_TOKEN`.
- HTTP routes: `POST /mcp` (the agent contract), `GET /health`, the OAuth
  discovery documents under `/.well-known/`, the OAuth flow at
  `/authorize`, `/token`, `/register` and `/revoke`, `POST /ingest` for
  webhook capture, and `/admin` with its own sign-in. Every tool is
  reached through `tools/call` on `/mcp`.

## What it isn't

- Not a public-facing API by default. The internal Docker network is
  the primary route. The optional public MCP HTTPS surface
  (`https://brain.<your-domain>/mcp`) is the remote AI client path; each
  client authenticates with its own token.
- Not a generic vector DB. The data model is markdown-shaped:
  `documents` → `chunks` → `embeddings` + `entities` + `entity_mentions`,
  layered with `pages`, `links`, `entity_facts`, `timeline_events`,
  `hot_memory`, `jobs`, and `subagent_*` ledgers.
- Per-credential source scoping (each remote client confined to its sources;
  opt-in fail-closed via `MEMRAIN_TENANT_FAIL_CLOSED`). One brain can serve a
  team; see [docs/TEAM-SETUP.md](../../../docs/TEAM-SETUP.md).

## Quick CLI surface

| Command | Purpose |
|---|---|
| `init --pglite` | bootstrap config + db + 4 soul templates (used at first install only) |
| `serve --http --port 18790` | start the daemon |
| `index <path>` / `search <q>` | one-shot indexing / retrieval |
| `reindex [--all] [--vault P]` | walk a vault, re-ingest changed files |
| `extract` | re-run the regex entity extractor over all chunks (no Bedrock) |
| `backlinks <name>` | docs that mention this wikilink target |
| `reconcile-links [--limit N]` | broken `[[wikilinks]]` |
| `orphans` | DB hygiene (delete safe orphans, flag suspicious) |
| `pages [--limit N] [--filter S]` | full catalog of known wikilink targets |
| `lint` | frontmatter conformance |
| `reports [--since H]` | trend report from cycle_snapshots |
| `doctor` | self-diagnostics, exit non-zero on any failed check |
| `integrity [--vault P]` | vault-vs-index drift report |
| `eval [--k N]` | retrieval quality harness against `tests/eval/qrels.json` |
| `eval-replay {capture\|list\|run\|delete}` | regression harness from captured production queries; `run --promote` sets the new baseline |
| `check-resolvable [--limit N] [--threshold P]` | wikilink coverage report; exits 1 when orphan-rate exceeds `P` % |
| `skillify "<prompt>" [--out P] [--slug S] [--dry-run]` | draft a skill `*.md` via Bedrock Claude Haiku + deterministic linter |
| `skillpack [--out P]` | bundle skills as tar.gz with manifest (for downstream agent loaders that consume skill packs) |
| `jobs {list\|stats\|show\|retry\|cancel}` | inspect / reset / cancel rows in the durable job queue |
| `friction {analyze\|propose-fix}` | counts + recents (`analyze`); Claude-Haiku-suggested skill-text edits (`propose-fix`) |
| `migrate-engine --from X --to Y` | copy every table between Engine adapters, then verify counts and content hashes (exit 1 on mismatch) |

## Read more

- `ARCHITECTURE.md` — internals, schema, cycle phases, search pipeline
- `API.md` — HTTP routes + MCP JSON-RPC tool reference
- `OPERATIONS.md` — deploy, restart, troubleshoot, rollback
