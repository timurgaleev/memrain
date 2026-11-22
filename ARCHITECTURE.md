# ARCHITECTURE.md

This page shows what runs where: the AWS resources, the containers, and how a
request reaches Memrain. It is for people who run, change or review the
infrastructure. To install Memrain, start with
[docs/QUICKSTART.md](./docs/QUICKSTART.md); for a plain tour of how it answers
a question, read [docs/HOW-IT-WORKS.md](./docs/HOW-IT-WORKS.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
  <img src="docs/assets/architecture-light.svg" alt="AI agents reach Memrain through a Cloudflare Tunnel or Caddy; inside your AWS account one EC2 instance runs the memrain container and one ingress container (cloudflared or Caddy) and uses RDS Postgres with pgvector, Amazon Bedrock, EFS, Secrets Manager, and backups." width="100%">
</picture>

> Source-of-truth diagram + inventory for the `memrain` stack.
> Updated alongside every terraform / compose / systemd change.

## Topology

```
   MCP clients (Claude Code, Codex,                 people in a browser
   claude.ai, ChatGPT, Cursor)                      (admin panel)
                │                                          │
   https://brain.<domain>/mcp              https://brain.<domain>/admin
                └──────────────────┬───────────────────────┘
                                   ▼
                  cloudflared (sidecar)  or  caddy (ingress_mode = "caddy")
                                   │
                ┌── docker-compose internal bridge ──┐
                                   │
     memrain  (/health · /mcp · /ingest · OAuth · /admin)
       ├─ jobs worker + daemon scheduler (opt-in: MEMRAIN_DAEMONS=1)
       │    cycle · connector_sync · notifications · loops_sweep
       └─ connector sync  ──►  Google · Microsoft Graph · Slack · Fireflies
                                   │                       (read-only, opt-in)
     Bedrock Titan v2 (embeddings) + Claude Haiku (intent/expansion, Ask)
                 + opt-in Claude Sonnet (synthesis, think)
                                   │
          RDS Postgres + pgvector  (directly, or through PgBouncer)
                                   │
                  EFS (container runtime state)
                                   │
       AWS Secrets Manager (incl. the optional connector key)
```

The stack runs as one VPC + one EC2 + one RDS + one EFS in a single
AWS region. There are no autoscaling groups, no orchestrator, no
external message broker — the whole runtime fits in `t4g.medium`.

## Container inventory

| Container | Image | Owns |
|---|---|---|
| `memrain` | built from `deploy/memrain/` (Bun + Alpine) | Knowledge brain: hybrid search (+ graph-signals ranking), entity + code call graph, code/markdown chunkers, fact extraction, push-context, advisor, MCP server (106 tools), a maintenance cycle (15 deterministic phases + 11 opt-in LLM-synthesis phases), and, each off until switched on, the daemon scheduler, connectors and the admin **Ask** chat. Every route except `GET /health`, the OAuth metadata and flow endpoints (`/.well-known/*`, `/authorize`, `/token`, `/register`, `/revoke`), the `/admin` pages (which carry their own sign-in) and `/s/` share links (when on; the link's password is the credential) needs a credential; `POST /mcp` is the agent contract and `POST /ingest` takes OAuth bearers with the `write` scope. Bedrock: Titan v2 embeddings, plus opt-in Claude Haiku (intent/expansion/rerank) and the opt-in, off-by-default Claude Sonnet note synthesis. Answer synthesis is the MCP client's job. |
| `cloudflared` | `cloudflare/cloudflared:2025.4.0` (upstream) | Public HTTPS ingress (Cloudflare Tunnel), the default `ingress_mode`. The dashboard routes `brain.<domain>/mcp` to Memrain on the internal docker bridge. |
| `caddy` | `caddy:2.10` (upstream) | The alternative ingress (`ingress_mode = "caddy"`): terminates TLS with Let's Encrypt on the instance's own public IP, no tunnel. Runs as a compose override, so exactly one of the two ingress containers exists per deployment. See [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md#alternative-caddy-ingress-no-cloudflare). |

Inter-container ports are not exposed to the host. `cloudflared`
reaches the Memrain MCP server over the compose `internal` bridge
network on `memrain:18790`. The service also answers to the network alias
`memex`, so an ingress configured before the rename to Memrain keeps working
in 1.0.x.

## Memrain daemon — internal modules

Beyond the per-recipe code under `deploy/memrain/src/recipes/`, the
daemon ships a handful of focused infrastructure modules. Listed here
so future contributors don't reach for them blindly.

| Module | Responsibility |
|---|---|
| `core/engine/{factory,pglite,postgres,interface}.ts` | Engine abstraction. `factory.makeEngine(config)` returns either a PGLite (dev fallback) or postgres-js adapter; both implement the same `transaction()` surface so the migration runner can be atomic on either backend. |
| `core/path_guard.ts` | Confines the `index` MCP tool's `path` argument to `MEMRAIN_VAULT_PATHS` / `MEMRAIN_CODE_PATHS`. Uses `realpathSync` so a symlink inside the vault that points outside is resolved + rejected. Dotfile / `.env` / `.git` / `.obsidian` / `.ssh` / `credentials` deny-list applies even inside an allowed root. |
| `core/concurrency.ts` | Tiny FIFO `Semaphore` used by the file sweep to bound concurrent `indexFile()` calls. Avoids the busy-wait + non-deterministic ordering of `while inFlight.size >= N: await sleep`. |
| `http/body_limit.ts` | `parseJsonBody<T>(req)` — 1 MiB POST body cap (override via `MEMRAIN_MAX_BODY_BYTES`). Returns either parsed JSON or a ready-built `413`/`400` Response. Every POST handler uses this. |
| `http/public_guard.ts` | Detects a public Cloudflare-tunnel request (presence of `Cf-Connecting-Ip`), enforces bearer auth via `crypto.timingSafeEqual` on equal-length Buffers, and rejects mutating tools unless `MEMRAIN_PUBLIC_WRITE=1`. |
| `mcp/http_transport.ts` | MCP JSON-RPC POST handler. Public and internal traffic key into separate `RateLimiter` instances — public uses Cloudflare's `Cf-Connecting-Ip`, internal collapses to a single "internal" bucket (XFF / X-Real-IP are attacker-controlled and would defeat per-IP limits). |
| `mcp/rate_limit.ts` | Token-bucket limiter with periodic idle-bucket eviction + `maxKeys` cap — bounded memory under high public IP variety. |
| `core/migrate.ts` | Single-tx migration runner: `engine.transaction(tx => { tx.exec(sql); tx.query("INSERT INTO migrations …") })`. A crash between the two phases used to leave the migration applied-but-unrecorded → re-run on next boot, breaking non-idempotent SQL. |
| `core/code-graph.ts` + `core/code-edges.ts` + `core/code-entities.ts` + `core/code-walk.ts` + `core/chunkers/code.ts` | Code intelligence: indexing + call graph. `memrain index` auto-detects source files (TS/Python), and the `code_callers` / `code_callees` / `code_def` / `code_refs` tools answer who-calls-what over `entity_mentions`, and `code_flow` / `code_blast` do a bounded transitive traversal (`walk_depth`). |
| `core/context/*` | Push-context (deterministic, no LLM): `volunteer.ts` extracts entities from a conversation window and resolves them to pages by alias/title/slug; `volunteer-events.ts` logs what was volunteered for a feedback metric. Backs the `volunteer_context` tool + `memrain watch`. |
| `core/advisor/*` | Read-only diagnostics: ranks pending migrations / stalled jobs / low embed coverage / setup smells into `{severity, fix_command}` findings (the `advisor` tool). Reuses the doctor/status/jobs primitives. |
| `core/synthesis/*` + `core/llm/{haiku,sonnet}.ts` | **Opt-in, off-by-default** LLM synthesis phases: `extract-atoms → synthesize-concepts → propose-takes → grade-takes → calibration-profile`, plus `reflections`, `patterns` (theme miner), `probe-contradictions`, and `deep-synth`. `think` runs the same relational-LLM pass as the opt-in `think` MCP tool and `memrain think` (both need `MEMRAIN_THINK=1`), with an entity-extract auto-anchor. Output is written ONLY to dedicated `synth_*` tables — `documents`/`chunks`/`pages` are never mutated. `haiku.ts` (utility) and `sonnet.ts` (paid slices) are the shared Bedrock helpers, each with an injectable seam so tests run with zero Bedrock calls. |
| `core/facts*` (`facts-extract` · `facts-classify` · `facts-reconcile` · `facts-recall` · `facts-decay` · `facts-fence` · `facts-queue`) | Structured entity facts. On-write extraction pulls `{subject, predicate, object}` triples into `entity_facts`; `facts-fence.ts` renders the deterministic "facts fence" block appended to a page; reconcile dedups + supersedes stale facts (with a `forgotten_cause` audit) and decays confidence over time. Paid Sonnet tier, default-OFF; the `entity_facts` tool reads them back and `add_fact` / `forget_fact` mutate them. |
| `core/content-sanity.ts` | Ingest quality gate. Scores incoming chunk text against junk/boilerplate patterns (plus an operator literal channel, `MEMRAIN_SANITY_LITERALS_FILE`) and quarantines scraper garbage before it is embedded. Fail-open. |
| `core/contextual-reembed.ts` + `core/search/contextual-llm.ts` | **Opt-in** contextual retrieval (LLM tier): before embedding, a Haiku pass prepends a short document-situating blurb to each chunk so the vector carries whole-doc context. Tracked by `chunks.contextual_embedded` (migration 057); `memrain reindex --contextual` re-embeds the corpus. |
| `core/search/relational-plan.ts` · `relational-chain.ts` | Multi-hop relational recall. A question chaining two or three typed relations ("who founded the companies alice invested in") is planned deterministically (relation lexicon, one anchor entity, hops ordered anchor-outward, page-type coherence; coordination, negation, dates, counts and comparatives are refused rather than guessed) and walked one bounded query per hop (50 frontier nodes, 100 edges per node, 10 paths per node). Every hop reads links in the caller's sources with both ends live and lands only on pages the caller may read (soft delete, held or quarantined mirrors, trust floor; remote callers also lose diary/journal pages and owner-only lineage). Answers carry their best path. `MEMRAIN_RELATIONAL_CHAIN=0` turns planning off. |
| `core/search/entity-anchor.ts` · `chunk-windows.ts` | Opt-in entity anchor (`MEMRAIN_ENTITY_ANCHOR=1`): a current-state query naming one entity page fuses that page and up to 10 pages linking to it, newest first, as one more RRF list. Chunk windows read the neighbouring chunks of many hits in one query, own document only; `query` attaches them with `window: 1..2`. |
| `core/search/alias-fanout.ts` · `relational-pin.ts` · `target-trace.ts` | Search refinements: a declared alias inside a longer query is searched again under the page's name (keyword arm, at most 2 lists); the two-pass rerank is skipped when the head is certain and re-pins relational-arm pages after it; `memrain search diagnose` records each stage's candidates and names the first stage that dropped a target page. |
| `core/search/query-cache.ts` | Semantic query cache (migration 065): a normalized-query + embedding-nearest lookup that returns a prior result set when a new query is semantically close enough, saving a full hybrid retrieval + embed round-trip. |
| `core/embed-backfill.ts` + `core/embedding.ts` | Embed provenance. Every vector is stamped with an `embedding_signature` (model + dim + contextual flag, migration 066); the opt-in `MEMRAIN_REEMBED_ON_SIGNATURE_CHANGE` auto-invalidates + re-embeds any row whose stored signature drifts from the current one. `core/embed-skip.ts` marks oversize / junk frontmatter as keyword-only (indexed, never embedded). Re-indexing a doc reuses a chunk's stored vector when its text is unchanged, so an edit only pays to embed the chunks that actually moved. Each vector also stores a hash of its exact embedding input (model, width, contextual tier, `<context>` prefix and text; `embeddings.input_hash`, migration 187), so with contextual wrapping on a retitle or synopsis change re-embeds the wrapped chunks it changed; a vector stored without the hash is reused by its text. |
| `core/scope.ts` + `core/visibility.ts` | Source scoping. Every row carries a `source_id` key; application-layer scoping + write-time fail-closed checks confine each remote credential (OAuth client / PAT) to its granted sources, and `scope.ts` defines the OAuth scope hierarchy (`read`/`write`/`admin`/`sources_admin`/`users_admin`/`agent`) the ingress gate enforces. |
| `mcp/visibility.ts` | The one predicate behind `tools/list` and `tools/call`: the ingress walls (public denylist, internal-token wall) and the per-credential gates (fail-closed write source, operator-only tools, per-op scope, slug-bound deny-by-default). `tools/list` advertises exactly the tools it finds no refusal for, so a listed tool is never refused for scope or permission. Argument-level refusals (a slug outside the bound prefixes) stay in dispatch. |
| `core/write-requests.ts` | Retry-safe writes. A `request_id` on `page_put`, `page_append`, `add_fact` or `add_timeline_event` claims a `write_requests` row keyed by caller grant, tool and id; a retry with the same arguments replays the stored result, other arguments are refused, and a retry during the first call gets `request_in_progress`. Conditional writes (`expected_version`) are checked in `core/pages.ts` under the slug's write lock. |
| `core/cycle/phase-context.ts` | Cycle fencing. Each phase runs with its own abort signal and a lock fence in async context: `phaseCheckpoint()` at the top of each loop iteration stops a timed-out or aborted phase, and `phaseFenceCheck()` before a shared-state write confirms the cycle lock still carries this run's tenure, so a run whose lock was taken ends as `partial/lock_stolen` instead of overlapping the new holder. |
| `core/transcripts/*` | Transcript import behind `memrain transcripts ingest`: format detection plus ChatGPT, Claude.ai, Codex rollout and Claude Code session adapters. Only what was said is kept (tool traffic, reasoning, sub-agent logs and system reminders are dropped); secrets are redacted before render and long sessions split into `-pN` parts at message boundaries. |
| `core/connectors/*` | Connectors: provider adapters (Google, Microsoft Graph, Slack, Fireflies, GitHub), the token vault (`vault.ts`), the sync engine (`sync-engine.ts`, `sync-store.ts`), deletion and retention (`retention.ts`) and meeting-credential redaction. See [Connectors](#connectors). |
| `core/daemons/*` | The daemon scheduler: registry, cron windows, per-daemon controls (`daemon_controls`), caps and status. |
| `core/budget.ts` | The spend ledger and wallet: every paid call is held at its maximum cost before it is sent, then settled; day caps per brain, client, daemon and path. |
| `core/trust-tier.ts` + `core/write-gate*.ts` + `core/trust-frame.ts` | Trust tiers and the write gate: who wrote a row, the deterministic instruction-text detector, held items, and the frame outside text is read back in. |
| `core/chat/*` + `http/chat-api.ts` + `http/share.ts` | The **Ask** chat: one `think` synthesis per answer under a per-answer hold, threads, saving an answer as a page, optional share links. |
| `core/loops/*` | Open loops: deterministic reply-owed / waiting / promise / RSVP detection over connector pages (`memrain waiting`, `loops_list`). |
| `core/notifications/*` | Owner notifications: stored rows, the admin and doctor views, and the optional signed webhook. |
| `core/members.ts` + `core/groups.ts` + `core/grant-profiles.ts` + `core/member-offboarding.ts` | Members, groups and grant profiles, and offboarding (export, then erase a member's own source). |
| `http/admin-office.ts` | The admin **Office** page feed: which workers and clients exist and are busy, by name only. |
| `http/oauth.ts` | **Default-OFF** optional OAuth/JWT bearer path. When `auth.oauth.enabled`, a Bearer JWT is verified against the issuer JWKS (RS256/ES256 via WebCrypto, no new dep); a valid token maps to the **public, redacted** read scope only — never internal, never a write path. |
| `core/extension.ts` | Extension hooks for a build that wraps the server: request and operation admission, a hold on background work, member and page room checks, a second spend hold, extra routes, admin routes and CLI commands, extra env-only config keys. The wrapper's own entrypoint registers them before it loads the CLI; with nothing registered every hook is a no-op. Environment that only a wrapper understands (`MEMRAIN_TENANT_ID`, `MEMRAIN_CONTROL_URL`) with no extension registered stops startup, so a misstarted wrapper fails closed. |

## Platform layer (2.0)

Release 2.0 adds a layer around the brain: connectors that read outside
accounts, background daemons under hard spend caps, trust tiers with a write
gate, the **Ask** chat, and members and groups. Connectors, daemons other than
`cycle`, Ask and members stay off until the operator switches them on. Two
parts are active from the upgrade on: trust tiers are recorded on new writes,
and the write gate checks outside text in `flag` mode (stored, marked and read
back inside a stronger frame; nothing is hidden).

```mermaid
flowchart TD
  P["Google · Microsoft Graph · Slack · Fireflies<br/>read-only provider APIs"]
  subgraph M["memrain container"]
    D["daemon scheduler<br/>cycle · connector_sync · notifications · loops_sweep"]
    K["vault<br/>tokens sealed with the connector key"]
    S["sync engine<br/>cursors · holds · mass-delete guard · retention"]
    G["page write<br/>secret scan · write gate · trust tier"]
    W["spend wallet<br/>hold max cost · settle · pause on overrun"]
    A["Ask chat and MCP search<br/>min_trust · outside-text frame"]
    L["open loops"]
    N["notifications<br/>admin · doctor · signed webhook"]
  end
  DB[("Postgres<br/>pages · chunks · trust_tier<br/>connector_* · open_loops · chat_*")]
  B["Bedrock"]
  P --> S
  D --> S
  K --> S
  S --> G --> DB
  D --> L --> DB
  D --> N
  A --> DB
  S -. embeddings .-> W
  A -. model calls .-> W
  W --> B
```

### Connectors

- **Gates.** Connectors open only with a usable connector key and
  `MEMRAIN_CONNECTORS_ENABLED=1`. Syncing also needs the scheduler
  (`MEMRAIN_DAEMONS=1`), the `connector_sync` daemon enabled, and a brain-wide
  `MEMRAIN_DAILY_BUDGET_USD`, because each written page is embedded.
  [docs/connectors/ENABLE.md](./docs/connectors/ENABLE.md) is the order.
- **Vault.** OAuth tokens and the operator's own OAuth client secrets are
  sealed with AES-256-GCM under a key-encryption key that never reaches the
  database: `<secrets_prefix>/memrain-connector-kek`, fetched as
  `MEMRAIN_CONNECTOR_KEK` (or `MEMRAIN_CONNECTOR_KEK_FILE`). Each sealed row
  records only the key's id and is bound to its row, so a copied or altered
  ciphertext fails to open. Without a key, connectors stay closed; nothing is
  stored in the clear. `memrain connectors rotate-kek` replaces the key
  ([docs/connectors/KEY.md](./docs/connectors/KEY.md)).
- **Sources by kind.** Every account writes into a source of the matching kind
  and never into a notes source: `mailbox` (Gmail, Outlook mail), `calendar`
  (Google Calendar, Outlook calendar), `chat` (Slack channel days, Teams chat
  days) and `meeting` (Teams transcripts, Fireflies). These kinds, with
  `github` and `webhook`, are outside sources.
- **Sync engine.** One run per account under a run lock and the account's
  daily item and dollar caps. A stream's cursor moves only once every item up
  to its checkpoint is written, unchanged or held, so an interrupted run
  resumes without a gap. Items that keep failing are held with a back-off. A
  body past the part size is stored as a contents page plus `part-NNN` pages.
  Live tokens are swept out of the text, and every item goes through the normal
  page write as outside text, with embeddings booked to `connector:<account>`.
- **Deletes and retention.** An item deleted at the provider soft-deletes its
  page and parts (a tombstone version, out of search, `page_restore` until the
  purge). Past the mass-delete guard (`MEMRAIN_CONNECTOR_MASS_DELETE_*`) the
  deletions are held for the owner instead. Retention windows
  (`MEMRAIN_CONNECTOR_RETENTION_DAYS_*`: mail and chat 180 days, calendar and
  meetings 365) hard-delete a page and what was derived from it; a page a
  person edited after the connector's last write is detached and kept.
- **State.** `connector_accounts`, `connector_credentials`,
  `connector_oauth_clients`, `connector_cursors`, `connector_items`,
  `connector_notices`, `connector_oauth_states`, `connector_client_holds`
  (migrations 152 to 154, 167 to 169).

### Scheduler and spend wallet

- **Daemons.** `MEMRAIN_DAEMONS=1` starts an in-process scheduler next to the
  jobs worker. One process leads through a `cycle_locks` row and queues each
  daemon window once. Built in: `cycle` (the maintenance cycle, its own loop),
  `connector_sync` (every 15 minutes, paid), `notifications` (every 5
  minutes) and `loops_sweep` (every 30 minutes). Only `cycle` is enabled by
  default. `memrain daemons enable|disable|pause|resume|status` steer them;
  `MEMRAIN_DAEMONS_DISABLED` switches one off from the environment, and five
  failed runs in a row pause a daemon.
- **Wallet.** Every paid call is held in the spend ledger at its maximum cost
  before it is sent and settled afterwards, so a cap counts calls in flight.
  Caps stack and the lowest wins: the brain day (`MEMRAIN_DAILY_BUDGET_USD`),
  the cycle day, each daemon's day and run caps, and per-client caps. A paid
  daemon does not run at all without the brain day cap. A path whose call
  costs more than its hold is paused until `memrain spend resume <path>`.
  `MEMRAIN_PROVIDER_LEASES` optionally caps parallel model calls per family.
- **Notifications.** A needed reconnect, held deletions or items, a paused
  path or daemon, write-gate holds and a refused OAuth app become rows in
  `notifications`, shown in the admin and `memrain doctor`, and optionally
  sent as a signed POST (`MEMRAIN_NOTIFY_WEBHOOK_URL`), retried when a
  delivery fails.

### Trust tiers and the write gate

- **Tiers.** Pages and facts written since 2.0 record the least trusted writer
  they have had (migration 158): `owner` (the operator, the CLI, the brain's own
  writers), `member` (a member principal), `agent` (any other authenticated
  client) or `external` (text in an outside source). A later owner edit never
  raises a tier. A row with no stored tier (anything written before 2.0, and a
  document indexed without one) gets it derived at read time. `search`, `query` and `context_pack` take `min_trust`.
  Rows derived from other text (atoms, takes, timeline entries, facts drawn
  from a page or chunk, concept pages, think syntheses, consolidated facts)
  take the least trusted tier of what they were drawn from (migration 184,
  `core/trust-derived.ts`); a row a model wrote (atoms, proposed and think
  takes, concept, atom and think pages) is also capped at `agent`. A write less
  trusted than the fact or ontology value it would replace, or a remote forget
  of a more trusted fact, leaves it in place and files a trust proposal
  (migrations 185 and 192, `core/trust-proposals.ts`) that the owner accepts or
  rejects with `memrain trust` or on the admin Approvals page. A credential can carry a
  read floor (`min_trust` on the token or client row, migration 186): it reads
  through `search`, `query` and `context_pack` at that floor or stricter, and
  every other tool that returns stored text is refused to it
  (`mcp/read-floor.ts`).
- **Write gate.** A deterministic check, with no model call, runs when
  outside or agent text is indexed for search. It looks for text that reads as
  instructions to an AI: directives that try to replace the reader's
  instructions, chat-template role markers, tool-call shaped text, requests to
  send data out, directives to the memory itself, standing rules addressed to
  an agent and requests for credentials. `MEMRAIN_WRITE_GATE_EXTERNAL`
  (default `flag`) and `MEMRAIN_WRITE_GATE_AGENT` (default `off`) choose
  between `flag` (stored, marked, read back inside a stronger frame),
  `quarantine` (out of search until `memrain write-gate approve|reject`) and,
  for outside text only, `reject`. The owner's own connector sources are
  never held or refused for their content (`quarantine` and `reject` act as
  `flag` there), and agent text that is only tool-call shaped is flagged, not
  held.
  Facts, takes and timeline entries from agents and outside sources pass the
  same detector before they are stored. `MEMRAIN_WRITE_GATE_ROWS` (default
  `flag`) records a receipt; `quarantine` keeps a matching row out of its table
  in `write_gate_row_holds` until `memrain write-gate release|drop`, so no
  reader needs a filter.
- **Paid phases skip outside text.** Facts backfill, on-write extraction and
  the contextual-LLM tier leave connector pages (mail, calendar, chat,
  meeting) alone. Deep synthesis gathers only pages at tier `agent` or above,
  so no outside text, GitHub and webhook pages included, reaches its prompt.

### Ask

The admin **Ask** page (`MEMRAIN_CHAT=1`, which also needs
`MEMRAIN_DAILY_BUDGET_USD`) answers from the brain through one `think`
synthesis per answer. The model gets no tools and writes nothing; a follow-up
is first rewritten into a standalone question by one short call. Each answer is
held at `MEMRAIN_CHAT_ANSWER_MAX_USD` before the first call, inside a per-owner
day and the brain day. Threads live in `chat_threads` / `chat_messages`
(migration 170) and are purged after `MEMRAIN_CHAT_RETENTION_DAYS`. Saving an
answer is a normal page write; with `MEMRAIN_CHAT_SHARE=1` an answer can also
be shared by a password-protected link under `/s/`. See
[docs/CHAT.md](./docs/CHAT.md).

### Members, groups and open loops

- **Members and groups** (migrations 162, 163). A member is a person whose
  tokens, OAuth clients and enrollment grants are bound to them, so one command
  disables them all. A group adds shared read sources to its members' keys and
  never changes where a key writes. Grant profiles (`reader`, `writer`,
  `coding-agent`) expand into scopes and a narrowed tool surface.
  `memrain member remove <id> --erase-personal-source` exports a member's own
  source and then erases it; `MEMRAIN_REQUIRE_MEMBER=1` refuses any credential
  not bound to a member. See [docs/TEAM-SETUP.md](./docs/TEAM-SETUP.md).
- **Open loops** (migration 161). The `loops_sweep` daemon reads mail, chat and
  calendar connector pages and lists replies owed and awaited, promises and
  unanswered invitations, by fixed rules with no model call
  (`memrain waiting`, MCP `loops_list`). See
  [docs/connectors/LOOPS.md](./docs/connectors/LOOPS.md).

### PgBouncer mode

`MEMRAIN_PG_POOLER=pgbouncer` tells the engine that `MEMRAIN_POSTGRES_URL`
is a PgBouncer in transaction mode (1.21 or newer). The engine then sends no
session settings at connect, so the role carries the timeouts, and migrations
and DDL go only over `MEMRAIN_POSTGRES_DIRECT_URL`.

## Access

Agents reach Memrain over MCP. People also use the admin panel (with the
**Ask** chat), which carries its own sign-in. The agent path:

```
MCP client (Claude Code / Cursor / Codex)
      │  Authorization: Bearer <public-bearer>
      ▼
https://brain.<domain>/mcp   →  cloudflared  →  memrain:18790  POST /mcp
      │
      └─ tools/call { name: "search", arguments: { q, k } }  → hybrid retrieval
         (memrain returns cited chunks; the MCP client composes the answer)
```

Hard guarantees:

- **Bearer-gated public ingress.** Every public `/mcp` request needs
  `Authorization: Bearer <public-bearer>`; the token is static unless the optional rotation timer is installed.
  Write tools are filtered from discovery and rejected from the public
  surface; internal write tools require `MEMRAIN_INTERNAL_TOKEN`.
- **Body redaction.** Public read tools omit note bodies unless
  `MEMRAIN_PUBLIC_READ_BODIES=1` — a leaked bearer can't exfil the vault.
- **`tools/list` is what the caller can call.** A token sees only the tools
  its scope, the operator-only set, the fail-closed write gate and its slug
  binding allow (`mcp/visibility.ts`); the operator's list is unchanged. Each
  tool carries MCP `annotations` (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`) derived from its scope.
- **Prompt-injection scrubs.** Retrieved chunks are wrapped in `<note>`
  tags; literal `<note>` / `<system>` / `[INST]` / `</s>` tokens inside
  chunk text are neutralised before going to Bedrock.

### OAuth flow

Memrain is its own OAuth 2.1 authorization server and protected resource
(`http/oauth-endpoints.ts`, `http/oauth-metadata.ts`, `core/oauth-provider.ts`).

- **Discovery.** Protected-resource metadata (RFC 9728) is served at the path
  form `/.well-known/oauth-protected-resource/mcp`, which a client pointed at
  `<issuer>/mcp` derives, and at the bare path for clients that cached it; both
  name `resource: <issuer>/mcp`. The `/mcp` 401 challenge points at the path
  form, and a request with no credential gets no `invalid_token` error code.
  Both metadata documents advertise `scopes_supported: ["read", "write"]`.
  Any other `/.well-known/` probe is a 404.
- **Resource binding (RFC 8707).** The `resource` approved at `/authorize`
  (`<issuer>` or `<issuer>/mcp`, stored as `<issuer>/mcp`) carries into the
  access and refresh tokens and survives rotation; any other value is
  `invalid_target`, at `/token` before the code or refresh token is consumed.
  `/mcp` refuses a token bound to another resource; unbound tokens (older
  tokens, PATs, `client_credentials`) are accepted. The issuer comes from
  `MEMRAIN_PUBLIC_URL`, or from the request when that is unset.
- **Codes.** A code records the client's `grant_revision`; a rescope between
  `/authorize` and `/token` makes it `invalid_grant`. `grant_types` is
  enforced on both grants, and `/authorize` redirects carry RFC 9207 `iss`.
- **Refresh families.** Every token minted from one sign-in shares a
  `family_id`, and a rotated refresh token leaves its hash in
  `oauth_refresh_consumed`. A replay within 60 seconds is refused as a
  retry; a later replay is refused and logged as reuse, and with
  `MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE=1` the whole family is deleted. Per-client
  access and refresh lifetimes override the 1 hour / 30 day defaults.
- **Enrollment lifecycle.** On an enrollment-mode connector the operator
  issues, lists and revokes codes (CLI or `/admin/api/enrollments`), revokes
  one redeemed person with `revoke-grant`, and replaces a lost connector with
  `enroll --replaces`, which keeps the person's source, spend key and cap and
  revokes the old grant once redeemed. Every change writes an
  `oauth_enrollment_audit` row. `invalidate-tokens` drops a client's or one
  grant's tokens and codes without touching the client or its secret, and
  `revoke-client` marks the client deleted and deletes its tokens, keeping its
  grant history and spend rows.

## AWS resource inventory

| Layer | Resource | Created by | Notes |
|---|---|---|---|
| Network | VPC, public subnet, IGW, route table | `terraform/vpc.tf` | Single AZ for the live instance; multi-AZ CIDRs reserved for future ASG. |
| Network | Security group | `terraform/ec2.tf` | Conditional SSH egress (only when `use_ssh_deploy_key = true`). |
| Compute | EC2 (t4g.medium, on-demand) | `terraform/compute.tf` | `lifecycle.ignore_changes = [ami, user_data]` — never replace on plan. |
| Compute | EIP | `terraform/compute.tf` | Public IP for Cloudflare Tunnel edge port (7844). |
| Storage | EFS file system + mount target | `terraform/efs.tf` | Backs container runtime state (Memrain config + recipe state). |
| Storage | RDS Postgres 16 (`db.t4g.micro`) | `terraform/rds.tf` | Hosts the Memrain index; `pgvector` extension enabled. Chunk embeddings are stored as `halfvec(1024)` with an HNSW index (migration 191) so the index stays inside the instance's small cache; rebuild it with `memrain hnsw rebuild`, never `REINDEX ... CONCURRENTLY`. |
| Storage | S3 — terraform state | `terraform/main.tf` (partial backend) | Bucket supplied via `terraform/backend.hcl` from `make init`. |
| Storage | S3 — scripts | `terraform/ec2.tf` | `<project>-scripts-<account_id>`; holds `scripts/bootstrap.sh`. |
| Identity | IAM role + instance profile | `terraform/iam.tf` | Bedrock invoke (Titan + Claude Haiku/Sonnet), Secrets Manager read/rotate, CloudWatch Logs write. |
| Secrets | AWS Secrets Manager | `terraform/secrets.tf` | All credentials live here. Naming: `<secrets_prefix>/<name>`. |
| Observability | CloudWatch log group | `terraform/cloudwatch.tf` | `/<project>/app`, 14-day retention. |
| Observability | SNS topic + email subscription | `terraform/cloudwatch.tf` | Conditional on `alarm_email != ""`. |
| Audit | CloudTrail | `terraform/cloudtrail.tf` | Conditional on `enable_cloudtrail = true`. Multi-region trail by default — captures IAM/STS calls regardless of source region. |

## Scheduled work (host-side systemd timers)

Installed once per deploy from `deploy/systemd/*.{service,timer}`. The
in-process daemons (connector sync, notifications, open loops) are not
timers; see [Scheduler and spend wallet](#scheduler-and-spend-wallet).
Static checks in `tests/test_systemd_units.py` ensure every shipped
unit references a script that exists in the repo.

| Unit | Cadence | Owns |
|---|---|---|
| `memrain-rotate-bearer.timer` (optional, not installed by bootstrap) | `*-*-* 06:00:00 Europe/Berlin` (daily) | Rotate `<secrets_prefix>/memrain-public-bearer`, restage `.secrets/memrain.env`, restart `memrain` so it re-reads the new value. |
| `memrain-eval-probe.timer` | `*-*-* 04:30:00 Europe/Berlin` (daily) | Nightly retrieval-quality probe: replays a golden query set, records hit-rate / rank metrics into `eval_snapshots`, and surfaces the latest snapshot in `memrain doctor`. Staggered clear of the 06:00 rotation so the two units never contend for the container; `Persistent=true` reruns a missed slot. Takes a per-run USD ceiling (`--max-usd`). |

## Storage layout

```
/mnt/<project>-efs/<project>/      # EFS mount on the EC2 host
└── memrain/                       # Memrain runtime config + soul templates

/opt/<project>/                    # repo checkout (cloned by bootstrap.sh)
├── .env                           # rendered by bootstrap.sh on first boot (re-run by hand via SSM)
├── deploy/                        # compose + container build contexts
├── scripts/                       # bootstrap, init, audit, helpers
└── terraform/                     # infra-as-code
```

The "code source" mount at `/mnt/<project>-efs/<project>-repo/` is a
second git checkout used by the Memrain code chunkers as their index
source. `scripts/bootstrap.sh` clones it on first boot; re-run it via SSM to resync.

The authoritative store is RDS Postgres, evolved by the numbered
migration runner (`core/migrate.ts`, through 179). Beyond the core
`documents` / `chunks` / `pages` / `entity_mentions` tables, the schema
carries:

- `synth_*` — the opt-in LLM-synthesis output (atoms, concepts, takes,
  take grades, calibration profile, `synth_contradictions`); never mixed
  into the source note tables.
- `entity_facts` — structured `{subject, predicate, object}` facts with a
  consolidation + `forgotten_cause` audit trail, rendered back onto pages
  via the facts fence.
- `slug_aliases` (migration 067) — canonical-slug redirects so a renamed
  page keeps resolving from its old links.
- `eval_snapshots` (migration 068) — per-run retrieval-quality metrics
  from the nightly `eval-probe`.
- `query_cache` (migration 065) — the semantic query cache.
- typed `links` — edges carry a `kind`/`verb` (NER-inferred, migration
  053) plus a `source_id` tenant key, and every row is scoped by that key
  in the application layer.
- `oauth_codes` / `oauth_tokens` carry their own `source_id`, `federated_read`
  and `grant_bound` (migration 101). `verifyAccessToken` resolves the tenant
  TOKEN-FIRST and falls back to the client row, so one shared connector can
  serve many people in separate tenants — the binding belongs to the
  authorization, not to the client.
- `oauth_enrollments` (migration 102) — one-time codes that supply that
  binding. The operator issues a code for a source; the person presents it once
  at `/authorize`; the code is single-use, expiring and revocable, and only its
  SHA-256 is stored. `oauth_clients.tenant_mode` selects which flow a client
  uses (`client` = the row's own source, the default; `enrollment` = ask).
- Token lifecycle (migration 117): `oauth_tokens.family_id` ties every token
  from one sign-in together, and `oauth_refresh_consumed` keeps the hash of each
  rotated refresh token until its own expiry so a late replay is recognised.
  `oauth_clients.access_ttl_seconds` / `refresh_ttl_seconds` hold per-client
  lifetimes, and `oauth_codes.grant_revision` the client revision a code was
  approved under.
- Enrollment lifecycle (migration 118): `oauth_enrollments.spend_id` is the key
  a person spends under (a replacement code copies its predecessor's, so the
  day's spend and cap stay in one place) and `replaces_id` the enrollment it
  supersedes. `oauth_enrollment_audit` records every issue, revoke and replace
  with actor and channel, with no FK so the history outlives the rows.
- `write_requests` (migration 119) — one row per caller grant, tool and
  `request_id`, holding an argument hash and the first call's result, so a
  retried write replays instead of writing twice. The cycle's purge phase
  drops rows after 7 days.
- `mcp_request_log` (migration 046) — one row per MCP tool call from a caller
  with a credential (OAuth or personal access token) and per admin-panel tool
  call, plus every other call when `MEMRAIN_REQUEST_LOG_DB=1`. The purge phase
  deletes rows older than `MEMRAIN_REQUEST_LOG_RETENTION_DAYS` (default 180)
  in batches of 5000, at most 500,000 rows per cycle.
- The 2.0 platform tables (migrations 151 to 175, all additive): the
  `connector_*` tables; `daemon_controls`, `provider_leases` and
  `spend_path_pauses`; a `trust_tier` column on `pages`, `documents` and
  `entity_facts`; `write_gate_holds`; `notifications`; `loop_threads`,
  `open_loops` and `loop_suppressions`; `members`, `member_audit`, `groups`,
  `group_sources` and `group_members`; `chat_threads`, `chat_messages` and
  `chat_shares`; `retrieval_feedback` and `retrieval_weights`;
  `search_telemetry_shadow`; and a few empty tables that only an extension
  writes to.

## Secrets — what goes where

| Secret name (under `<secrets_prefix>/`) | Consumer | Set by |
|---|---|---|
| `cloudflared-tunnel-token` | cloudflared | Manual; from Cloudflare Zero Trust dashboard. |
| `memrain-postgres-url` | Memrain | terraform — auto-populated from RDS endpoint. |
| `memrain-public-bearer` | Memrain | terraform — `random_password` resource generates at apply. Memrain validates incoming public `/mcp` bearers against it. Static unless the optional `memrain-rotate-bearer.timer` is installed. |
| `memrain-internal-token` | Memrain (internal MCP write tools) | Generated by Terraform (`random_password`) at apply; gates write `tools/call` on the internal path. |
| `github-deploy-key` | bootstrap | terraform — conditional, only when `use_ssh_deploy_key = true`. |
| `memrain-connector-kek` (optional) | Memrain (connector vault, as `MEMRAIN_CONNECTOR_KEK`) | terraform creates the empty secret when `enable_connector_kek_secret = true`; the operator puts the value in by hand ([docs/connectors/KEY.md](./docs/connectors/KEY.md)). |
| `memrain-notify-webhook` (optional) | Memrain (signs notification webhooks, as `MEMRAIN_NOTIFY_WEBHOOK_SECRET`) | terraform creates the empty secret when `enable_notify_webhook_secret = true`; the operator puts the value in. |

`deploy/secrets/fetch-secrets.sh` reads these into the on-host
`deploy/.secrets/*.env` files. Containers `env_file:` mount those at
container start; Memrain reads `MEMRAIN_PUBLIC_BEARER` from `memrain.env`.

## Deploy flow

```bash
# From a maintainer laptop:
git push origin main

# From any shell on the EC2 (use AWS SSM Session Manager):
cd /opt/<project>
git pull --ff-only
bash deploy/secrets/fetch-secrets.sh                   # only if a secret changed
bash deploy/deploy.sh                                  # stamps, builds, waits healthy,
                                                       # then asserts the running
                                                       # container serves that stamp
```

The boot flow (cold start from a new instance):

1. cloud-init writes `/etc/stack-env` from terraform user_data vars.
2. cloud-init downloads `scripts/bootstrap.sh` from the scripts S3 bucket.
3. `bootstrap.sh` installs docker, mounts EFS, clones the repo,
   conditionally fetches the SSH deploy key, renders `/opt/<project>/.env`,
   runs `fetch-secrets.sh`, and brings up the two-container compose
   stack (`memrain`, `cloudflared`).

## Why this shape

- **Single EC2, no orchestrator.** One personal workload doesn't need a
  scheduler. The whole stack survives a `docker compose up -d --build`.
- **EFS for state, RDS for index.** EFS preserves runtime state
  (Memrain config, recipe checkpoints) across instance
  replacements. RDS preserves the Memrain index across container
  rebuilds (PGLite on EFS lost data on SIGKILL — the move to RDS
  fixed that class of failure).
- **Cloudflare Tunnel, no public ports.** The EC2 SG opens nothing
  inbound. cloudflared dials out on tcp/7844 only. SSH is opt-in via
  `ssh_allowed_cidr`; SSM Session Manager is the default access path.
- **Bedrock for inference (Anthropic-only + Titan).** Titan v2 supplies
  embeddings; Claude Haiku is the utility model (intent classification +
  query expansion); the opt-in, default-OFF synthesis + facts slices use
  Claude Sonnet. Answer synthesis is the MCP client's job, except the
  opt-in `think` tool and the **Ask** chat built on it. The
  deterministic core costs about $52/mo in infrastructure (see
  [docs/CONFIGURATION.md](./docs/CONFIGURATION.md)) even with daily use; the paid LLM
  slices only spend when explicitly enabled.
- **MCP for agents, no agent framework.** Agents reach Memrain over plain
  MCP JSON-RPC: one contract, no bot, no bespoke API. The **Ask** chat is for
  people, opt-in, and answers through the same retrieval under the same spend
  wallet.
- **One person's brain, scoped credentials.** A deploy is one user's
  brain on one account. The substrate is nonetheless source-isolated:
  every row carries a `source_id` key. Enforcement is application-layer
  `source_id` scoping plus write-time fail-closed checks; Postgres RLS is
  not the enforcement: migration 049 enables RLS only when the migrating role has BYPASSRLS (not on a stock RDS) and adds no policies. With `MEMRAIN_TENANT_FAIL_CLOSED=1`, each remote credential
  (OAuth app, PAT) sees only its granted sources, so a leaked app token
  does not expose the whole brain. Members and groups add people on top of
  the same sources.

## Out-of-scope (deferred — see `TODO.md`)

- Multi-region failover.
- A managed control plane for hosting many customers (self-service
  onboarding, per-customer billing). Per-source scoping ships today,
  enforced in the application layer (migration 049 enables RLS only when the migrating role has BYPASSRLS (not on a stock RDS) and adds no policies); the
  operator surface for running Memrain *as* a hosted service for many
  customers does not.
- Read replicas / horizontal scaling.
- ASG + spot fleet (a multi-instance variant not built today; the
  current shape is one on-demand instance with
  `lifecycle.ignore_changes`).
- GitHub Pages docs site.
- Standalone Memrain publishing (npm package + container image).
