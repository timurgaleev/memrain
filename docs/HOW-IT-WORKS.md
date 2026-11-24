# How Memrain works

This page explains what Memrain does with your notes, how it answers a
question, and what it costs to run. The first sections need no setup
knowledge; the last ones are reference. For the setup itself, see
[QUICKSTART.md](./QUICKSTART.md). What 3.0 removed from the 2.x line is listed
in [UPGRADING.md](../UPGRADING.md).

## In one minute

Memrain is a memory, not a chatbot. It keeps your notes as pages, and when
your AI agent asks a question it hands back the most relevant passages, each
with the page it came from. Your agent (Claude Code, ChatGPT, Codex and so on)
writes the answer from that evidence. Memrain never writes an answer itself.

It is built for one person. One container serves one brain, your agents reach
it over MCP with 29 tools ([TOOLS.md](./TOOLS.md)), and the only model it ever
calls is Amazon Titan, to turn text into embeddings. Turn that off and it runs
with no AWS at all, on keyword search alone.

## 1. How your knowledge gets in

There are four ways in, and they all end in the same place: a page in
Postgres.

- **Your agent writes pages.** `page_put`, `page_edit` and `page_append` create
  and change pages over MCP. Every change is a new version, so nothing an agent
  writes is lost: `page_versions` shows the history and `page_revert` brings an
  old body back.
- **A folder of markdown.** `memrain reindex` walks a vault folder
  (`--vault PATH`, `MEMRAIN_VAULT_PATH` or `storage.vault` in the config) and
  indexes the `.md` files that are new or changed since the last run; `--all`
  re-reads everything. With `--reconcile-deletes` it also retires documents
  whose file is gone, and it refuses to retire more than 50 of them, or a
  quarter of the vault, unless you pass `--allow-mass-delete`. The sweep runs
  when you start it; nothing watches the folder.
- **A Memrain export.** `memrain export` writes live pages as markdown files;
  `memrain import --dir DIR --source ID` reads such a folder back. It only
  creates pages, never overwrites one, and it previews first: the preview
  prints a `plan_hash`, and `--apply --plan-hash HASH` writes exactly that
  plan.
- **Chat history.** `memrain transcripts ingest` reads ChatGPT and Claude.ai
  exports, Codex CLI rollouts (`~/.codex/sessions`) and Claude Code session
  logs (`~/.claude/projects`), one file or a whole directory. It keeps only
  what was said: tool calls and results, reasoning, sub-agent traffic and
  system reminders are dropped, credentials are redacted, and a long session
  is split into parts at message boundaries. Running it again on unchanged
  input writes nothing. See [TRANSCRIPTS.md](./TRANSCRIPTS.md).

Whichever way a page arrives, Memrain then:

1. **Splits** it into short passages.
2. **Embeds** each passage: Titan on Bedrock turns it into a list of 1024
   numbers that captures its meaning, so "car" can find "vehicle".
3. **Stores** the passages and their vectors next to the page. The database
   is the record, not the files on disk.

Editing one line of a page re-embeds only the passages whose text changed;
the others keep their vectors. A page write puts the page into search before
it returns. If embedding fails (Bedrock down, the daily cap spent), the
passages are stored without vectors and stay findable by their words; if the
search copy cannot be written at all, the page is still saved. Either way the
hourly housekeeping (section 7) fills the gap later.

## 2. How a question is answered

When your agent calls `search`, Memrain:

1. **Searches two ways at once**: by meaning, using the embedding of the
   question, and by exact words, using Postgres full-text search.
2. **Merges the two result lists** into one ranking with Reciprocal Rank
   Fusion.
3. **Keeps at most two passages per page**, so one long page cannot fill the
   whole answer. A page and its copies (its compiled-truth header, its file on
   disk) count as one page.
4. **Trims** to the number asked for (`k`, default 20) and, if the agent gave
   a `token_budget`, to that size.
5. **Returns the passages, each with its page, source and date.**

Filters (`types`, `slug_prefix`, `since`, `until`, `source_ids`) run inside
both searches, before any limit, so a filtered match is never pushed out by
unfiltered ones. No model is asked to classify, expand or rerank anything.

When the embedding is unavailable (a Bedrock outage or timeout, or
`MEMRAIN_KEYWORD_ONLY=1`), search runs on words alone and says so in its
`meta` (`vectorEnabled: false`, `degraded`). An empty result carries a `hint`
that tells "nothing matched" apart from "part of the search failed".

For an exact phrase, `search_exact` scans page bodies for the literal text,
with no ranking and no embedding. `page_get`, `page_list`, `resolve_slugs`,
`backlinks` and `get_links` read pages and the links between them directly.

The code is in `deploy/memrain/src/core/search/hybrid.ts`.

## 3. What it costs

There is one paid call: the Titan embedding, made once per changed passage
when it is indexed and once per search for the question. It costs about
$0.02 per million tokens, so ordinary use is pennies a month. The rest of the
bill is the infrastructure you run it on (on the AWS deploy: one small EC2
instance, one small RDS Postgres, EFS and Secrets Manager); see
[DEPLOYMENT.md](./DEPLOYMENT.md).

Two caps keep the embedding bill bounded:

- **The brain's daily cap**, `MEMRAIN_DAILY_BUDGET_USD`, over every paid call.
- **A per-credential daily cap**, set with `memrain auth set-budget <id> <usd>`
  or on the admin Agents page.

Before each call Memrain books the most it could cost against every cap that
applies and settles the real cost afterwards, so calls still running count
against the cap and a burst of parallel calls cannot slip past it. When a cap
is spent, `search` is refused with `budget_exhausted` until the UTC day rolls
over or the cap is raised: a spent budget is your policy, and it should not
look like an empty brain. Pages written meanwhile are still saved, without
vectors; housekeeping embeds them once there is room again. `whoami` shows a
credential its cap and what it has spent today.

With `MEMRAIN_KEYWORD_ONLY=1` nothing is embedded and no call is made at all.
The local trial (`make local-up`) runs this way, with no AWS account.

## 4. Credentials: who can read and write

Every caller presents a credential, and nothing trusts the caller beyond it.

- **OAuth clients.** Memrain is its own OAuth 2.1 server, so Claude.ai,
  ChatGPT and other connector-style clients sign in with the authorization
  code flow; `memrain auth register-client` registers a client by hand.
- **Personal access tokens.** `memrain auth create <name>` mints a long-lived
  token for a CLI or a script. It is printed once; only its hash is stored.
- **The static public bearer.** An optional single token for the public
  ingress. It sees a narrower set of tools and, by default, no page bodies;
  `MEMRAIN_PUBLIC_AUTH=oauth` turns it off so every caller brings its own
  token.
- **The admin panel** at `/admin` signs the owner in with a passkey. A
  one-time setup link from `memrain admin setup-link` creates the first one;
  recovery codes cover a lost device. From the panel you search and read
  pages, check health and spend, mint and revoke tokens, and manage passkeys.

Each OAuth client and token carries a write source, the sources it may read,
its scopes (`read`, `write`, `admin`), optionally the slug prefixes it may
change, and optionally a narrower tool surface. Reads and writes stay inside
that grant, and `tools/list` shows a client only the tools it can actually
call. `stats` and `run_doctor` are for the operator only. A leaked app token
therefore exposes at most what it was granted.

A **source** groups pages. `memrain sources owner-only <id> on` marks one as
owner-only: only the local operator and a credential bound to the brain's
owner can read it, and to everyone else it does not exist. A credential bound
to any other person, or one that carries a read floor from an earlier
install, is refused with `credential_unsupported`.

## 5. Safety

Memrain assumes some text it stores was written by someone else, and that any
credential might leak. Each of these runs without a model call.

- **Secret scan.** Every page write is scanned for credentials: published key
  prefixes, private-key blocks, JWTs, passwords inside URLs, and `PASSWORD=…`
  style assignments with a random-looking value. A match is replaced by a
  `[REDACTED:<kind>:<fingerprint>]` marker before anything is stored, chunked
  or embedded. When the connector key is set, the original is sealed with it;
  `memrain secrets reveal` shows one (audited) and `memrain secrets restore`
  puts a false positive back. `MEMRAIN_SECRET_SCAN_DISPOSITION` can refuse the
  write (`reject`) or keep the text as it is (`flag`) instead of redacting.
  `memrain secrets audit` rescans stored text with the current rules.
- **Quarantine.** A content-sanity check marks scraper junk, oversize dumps
  and markup-heavy boilerplate as it is indexed. Junk is quarantined: kept,
  but out of search and never embedded. An oversize page stays
  keyword-searchable without a vector. Remote readers get a quarantined page's
  metadata without its body. `memrain quarantine list|clear|scan` manages it.
- **Write gate.** Text from an outside source, and agent text if you switch
  it on (`MEMRAIN_WRITE_GATE_AGENT`), is checked for text that tries to talk to
  an AI: "ignore your instructions", fake chat-role markers, tool-call shaped
  text, requests to send data somewhere, orders aimed at the memory itself.
  By default such text is stored but flagged, and whenever it is read back it
  comes wrapped in a notice that it is someone else's data, not an
  instruction. A stricter mode holds it out of search until you decide with
  `memrain write-gate approve|reject`.
- **Trust frame.** Passages that came from outside, or from an agent rather
  than you, are returned by `search` inside an `<external_content>` frame, so
  your agent can tell your words from someone else's.
- **Output redaction.** Every result that carries stored text is scanned for
  credentials again on its way to a non-operator caller, which catches text
  stored before a rule existed.
- **Rate limits.** `/mcp` is rate-limited per client address and, for signed-in
  callers, per token; failed sign-in attempts are throttled separately.

## 6. The shape

Memrain is deliberately small: **one container**, with Postgres (RDS on the
AWS deploy) or an embedded PGLite database behind it. On AWS it runs on one
EC2 instance, keeps its tokens in Secrets Manager and is reached through a
**Cloudflare Tunnel** or, without Cloudflare, a Caddy ingress with Let's
Encrypt TLS ([DEPLOYMENT.md](./DEPLOYMENT.md#alternative-caddy-ingress-no-cloudflare)).
The routes are `POST /mcp`, `GET /health`, the OAuth discovery and flow
endpoints, and `/admin`. There is no worker, no queue and no scheduler beside
the server. Full topology in [ARCHITECTURE.md](../ARCHITECTURE.md).

## 7. It maintains itself

Once an hour (the first run five minutes after start), the server does its
housekeeping in-process:

| Step | What it does |
|---|---|
| `purge` | hard-deletes documents soft-deleted more than 72 hours ago and pages soft-deleted more than 30 days ago, with what hung off them |
| `mirror_pages` | rebuilds the search copy of any page whose copy is missing or stale |
| `embed_gaps` | embeds passages that were stored without a vector, up to `MEMRAIN_EMBED_GAPS_MAX_PER_RUN` (200) per run, under the daily cap |
| `tokens` | removes expired OAuth tokens and codes |
| `reservations` | releases spend bookings that a crashed call never settled |
| `retention` | trims the request log (`MEMRAIN_REQUEST_LOG_RETENTION_DAYS`, 180 by default) and old write-retry receipts |

Only one process does this at a time: the run holds the `memrain-cycle` lock
in the database. A step that fails is recorded and the next one still runs.
No model is called; the only paid calls are the embeddings of `embed_gaps`.
`memrain doctor` reports when it last finished. `MEMRAIN_CYCLE=0` turns it
off, and `MEMRAIN_MAINTENANCE=1` stops every background write.

## 8. Under the hood: the tools

All 29 tools, with their parameters, scopes and errors, are in
[TOOLS.md](./TOOLS.md). A few behaviours worth knowing:

- Writes are safe to retry and to race. `page_put`, `page_append` and
  `page_edit` take a `request_id`: a retry with the same id and arguments
  returns the first result with `replayed: true` and writes nothing.
  `page_put`, `page_delete` and `page_revert` take an `expected_version`;
  `page_edit` and `page_rename` require one. Of two writers that read the same
  version, exactly one commits and the other gets `version_conflict`.
- Deleting is gentle. `page_delete` is a soft delete that `page_restore`
  undoes for 30 days; `purge_deleted_pages` (admin scope) removes pages for
  good, after a dry run that pins exactly which ones.
- `page_get` returns large bodies in windows (`body_window`, `next_offset`);
  `page_list` pages with `next_cursor` until `complete: true`.
- A failed search stage is reported next to the surviving results
  (`meta.degraded`), and a transient database failure returns a retryable
  `db_timeout` or `db_busy` instead of an empty answer.
