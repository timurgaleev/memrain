# Configuration reference

This page lists every setting you can change, what each one does, and which
ones cost money. You need it when you want to turn a feature on or off or tune
how Memrain behaves. The defaults work, so you do not need this page to get
started: begin with [QUICKSTART.md](./QUICKSTART.md), and read
[HOW-IT-WORKS.md](./HOW-IT-WORKS.md) to see what the settings control.

Most runtime knobs are environment variables prefixed `MEMRAIN_`; deploy-level
keys (secret names, `COMPOSE_FILE`) and Terraform variables are listed in their
own sections below.
An install from before the rename keeps working with its old names in 1.0.x;
see [Legacy names](#legacy-names).
This page is the authoritative list: each row gives the variable, its default,
what it does, and whether it costs money.

## How configuration flows

There are two gates between a value you type and the running process:

1. **The host `.env` file** — `/opt/memrain/.env` on the live instance, rendered
   by `scripts/bootstrap.sh` from `/etc/stack-env` at boot (the `.env` that
   `scripts/init.sh` writes is for the local checkout only). This is what
   `docker compose --env-file .env` reads.
2. **The compose allowlist** — the `environment:` block in
   `deploy/docker-compose.yml`. **Only variables listed there are passed into
   the container.** A flag set in `.env` but absent from the allowlist does
   nothing — compose never forwards it.

So enabling a flag is a two-step operation: put it in `.env`, and make sure the
same key appears in the compose `environment:` block. The secret-backed values
(`MEMRAIN_POSTGRES_URL`, `MEMRAIN_PUBLIC_BEARER`) arrive by a third path — the
`env_file: .secrets/memrain.env` written by `deploy/secrets/fetch-secrets.sh` —
not the allowlist.

The tables below mark each variable's allowlist status:

- **allowlisted** — already in the compose `environment:` block; set it in
  `.env` and recompose.
- **code-only** — read by the source but *not* in the default allowlist. To use
  it you must **add the key to the compose `environment:` block yourself**, then
  set it in `.env`. These are mostly retrieval-tuning knobs left at their
  built-in defaults.

## How to enable a flag

```bash
# 1. On the live host, add the flag to /opt/memrain/.env
echo 'MEMRAIN_DREAM_SYNTHESIS=1' >> /opt/memrain/.env

# 2. Confirm the key is in the compose allowlist (environment: block).
#    If it is "code-only" below, add a line to deploy/docker-compose.yml:
#      - MEMRAIN_MYFLAG=${MEMRAIN_MYFLAG:-}
#    and commit/deploy that change first.
grep MEMRAIN_DREAM_SYNTHESIS deploy/docker-compose.yml

# 3. Rebuild and restart memrain so it picks up the new env.
bash deploy/deploy.sh
#    Other services: docker compose --env-file .env up -d --build <service>
#    (never add -f: it overrides COMPOSE_FILE in .env and drops the ingress overlay)

# 4. Verify the process actually sees it, and the brain is healthy.
docker exec deploy-memrain-1 sh -c 'echo "$MEMRAIN_DREAM_SYNTHESIS"'
docker exec deploy-memrain-1 wget -qO- http://127.0.0.1:18790/health   # -> {"ok":true,...}
```

A boolean flag is "on" only for the exact value the code checks (usually `=1`).
Numeric knobs fail **loud** on a malformed value — a typo aborts the process at
boot rather than silently falling back, so a bad edit is caught immediately.

---

## Quality & cost tiers (pick one)

Memrain's **runtime code ships everything paid OFF by default** — a bare
`git clone` is a pure retrieval brain that never makes a billable model call
beyond embeddings, so cloning the repo can never surprise you with a bill. The
opt-in happens one layer up: **`scripts/init.sh` defaults to the Max quality
tier** and writes those flags into the generated (gitignored) `.env`, so a real
operator install gets the full-featured experience by default. Pick `balanced`
or `free` at the init prompt, or set `MEMRAIN_INIT_TIER=free|balanced|max` for the
non-interactive path. **More spend buys more quality** — the paid tiers below are
what the project is capable of at its best, and Max is the *recommended* setup.
Change tiers any time by editing the flags in `.env` (all are in the compose
allowlist) and recomposing. On an EC2 host every `scripts/bootstrap.sh` run
rewrites `.env` and keeps only the `*_SECRET_NAME` keys, so re-add hand-set
flags after a bootstrap re-run.

| Tier | What you get | Flags | ~Cost/mo* |
|------|--------------|-------|-----------|
| **Free — Retrieval** (runtime default) | Hybrid search + graph + code intel. No LLM calls beyond embeddings. | *(none)* | infra only (~$52) |
| **Balanced — Haiku** *(best value)* | + Haiku two-pass rerank on every search, nightly note synthesis, per-source health, tenant fail-closed. Sharper ranking + a self-thinking brain, cheaply. | `MEMRAIN_RERANK` `MEMRAIN_DREAM_SYNTHESIS` `MEMRAIN_DOCTOR_PER_SOURCE` `MEMRAIN_TENANT_FAIL_CLOSED` | +$5–15 |
| **Max quality — Sonnet** *(recommended for best results)* | Everything. Sonnet graph-aware rerank on every search, relational reasoning, `think`, scheduled deep-synth, take-ensemble grading, conversation→facts, per-chunk LLM contextual embeddings. The full-fat brain. | all of the above **plus** `MEMRAIN_GRAPH_RERANK` `MEMRAIN_RELATIONAL_LLM` `MEMRAIN_THINK` `MEMRAIN_DEEP_SYNTH` `MEMRAIN_TAKE_ENSEMBLE` `MEMRAIN_FACTS_EXTRACTION` `MEMRAIN_CONTEXTUAL_LLM` | +$25–390 |

\* Above the ~$52/mo fixed infra (one small EC2 + RDS). Variable cost is
dominated by **`MEMRAIN_GRAPH_RERANK`** — a paid Sonnet call on *every* search, so
it scales with query volume (the swing between the $25 and $390 ends of the Max
tier). If you want Max-tier reasoning everywhere *except* the per-search Sonnet
cost, run the **Balanced** tier's `MEMRAIN_RERANK` (Haiku, ~$1–3/mo) in place of
`MEMRAIN_GRAPH_RERANK` — near-identical ranking quality at a fraction of the cost.
Every paid Sonnet slice is independently bounded by a `*_BUDGET_USD` cap
(default `1.0`), so no single call or run can run away.

The Free tier is what the code does with no flags set; `scripts/init.sh`
proposes Max by default. Set `MEMRAIN_INIT_TIER=free|balanced|max` to pick
non-interactively.

---

## 1. Core / required

The values a working install cannot start without. The first three come from
Secrets Manager (via `fetch-secrets.sh`), not the compose allowlist.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMRAIN_POSTGRES_URL` | *(none — required)* | RDS Postgres connection URL (`postgres://…?sslmode=require`). Injected from the `<prefix>/memrain-postgres-url` secret via `.secrets/memrain.env`. Without it the index has nowhere to live. | free |
| `MEMRAIN_PUBLIC_BEARER` | *(none)* | Static bearer token accepted on public `/mcp` requests. Injected from `<prefix>/memrain-public-bearer`. It carries no tenant and reaches only the public read subset, so give people a personal access token (`memrain auth create <name> --source <src>`) or an OAuth client instead. `deploy/systemd` ships a rotation timer that bootstrap does not install. | free |
| `MEMRAIN_INTERNAL_TOKEN` | *(none)* | Shared bearer authenticating peer containers on the internal docker bridge to Memrain's mutating routes. From `<prefix>/memrain-internal-token`. | free |
| `MEMRAIN_HOST` | `127.0.0.1` | Bind address of the HTTP server. The image sets `0.0.0.0` inside the container; the CLI `--host` flag overrides. It is not the public hostname. | free |
| `SUBDOMAIN` | `brain` | The public MCP subdomain. `init.sh` and `bootstrap.sh` write it into `.env` together with `PUBLIC_HOST=<subdomain>.<domain>`; the server does not read it (the terraform var `subdomain` is the source of truth). | free |
| `MEMRAIN_REQUIRE_POSTGRES` | off (`=1` on) | For a host that must run on Postgres. With it on, a PGLite `config.json` or a missing Postgres URL stops the server and the container entrypoint instead of starting an empty local brain, `init --pglite` refuses, and `fetch-secrets.sh` fails when the URL secret is missing. `bootstrap.sh` writes it on new installs. Env-only: a `runtime_config` row cannot set it. | free |
| `MEMRAIN_VAULT_PATHS` | `/memory` (compose) | CSV of directory roots the indexer may sweep and the path-guard treats as in-bounds. Mounted read-only into the container. | free |
| `MEMRAIN_CODE_PATHS` | `/repo-source` (compose) | CSV of repo checkouts the code-chunkers index (call/def/ref graph). Empty → boot warns "0 indexable files" and continues. | free |
| `MEMRAIN_VAULT_PATH` | unset | Single vault path for `reindex` and `integrity` when no `--vault` flag is given, and for `doctor`'s vault check. It takes precedence over `storage.vault` in the config file. Code-only; the server sweeps `MEMRAIN_VAULT_PATHS`. | free |
| `MEMRAIN_VERSION` | `dev` | Build stamp baked into the image by `deploy/deploy.sh` (`git describe`). `/health` and MCP `serverInfo.version` report it; `memrain auth doctor --expect-version` compares against it. Set by the deploy script, not by hand. Allowlisted (build arg). | free |

### Secret names

`deploy/secrets/fetch-secrets.sh` reads four secrets under `SECRETS_PREFIX`
(from `.env`) and writes them to `deploy/.secrets/`:

| Secret | Written as |
|---|---|
| `<prefix>/memrain-postgres-url` | `MEMRAIN_POSTGRES_URL` in `.secrets/memrain.env` |
| `<prefix>/memrain-public-bearer` | `MEMRAIN_PUBLIC_BEARER` in `.secrets/memrain.env` |
| `<prefix>/memrain-internal-token` | `MEMRAIN_INTERNAL_TOKEN` in `.secrets/memrain.env` |
| `<prefix>/cloudflared-tunnel-token` | `TUNNEL_TOKEN` in `.secrets/cloudflared.env` |

A stack whose secrets carry other names sets any of four optional `.env` keys
to the full secret id: `POSTGRES_URL_SECRET_NAME`, `PUBLIC_BEARER_SECRET_NAME`,
`INTERNAL_TOKEN_SECRET_NAME` and `TUNNEL_TOKEN_SECRET_NAME`. A non-empty value
is used exactly as written: no prefix is added and no other name is tried.
Unset or empty means the default name above. A value outside the Secrets
Manager name alphabet stops the script before any AWS call. The bearer
rotation script and `scripts/mcp-refresh.sh` read `PUBLIC_BEARER_SECRET_NAME`
too. These keys are not part of the rename and stay in 1.1.0.
`scripts/mcp-refresh.sh` runs on the operator's machine and does not read
`.env`: it needs `MEMRAIN_MCP_URL` (the `https://<host>/mcp` endpoint) and
`AWS_REGION`, and takes `MEMRAIN_SECRETS_PREFIX` (its default is the legacy
prefix, so set it to your `SECRETS_PREFIX`), `MEMRAIN_MCP_NAME` (default `memrain`),
`MEMRAIN_MCP_SCOPE` (default `user`) and `AWS_PROFILE`.

The script fetches every value into a temporary file first and replaces the
files only when all of them were read. Any error other than "secret not
found" (access denied, expired credentials, throttling) makes it exit 1 with
every existing file left as it was. A tunnel token secret that does not exist
or has no value yet is the one exception: the script warns and writes an
empty `cloudflared.env` only when none exists, never over a file that holds
a token.

---

## 2. Retrieval & ranking (free)

Pure-retrieval tuning. All run locally against Postgres + the Titan embedding
already computed — no per-call model cost. Most are **code-only**: they have
sensible built-in defaults and are not in the compose allowlist, so add the key
to `environment:` before overriding.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMRAIN_GRAPH_SIGNALS` | off (`=1` on) | Fold graph centrality signals into the ranking score. | free |
| `MEMRAIN_GRAPH_SIGNALS_FLOOR` | unset (gate off) | Ratio in `0..1`; hits below the floor are excluded from the graph boost. Unset → every hit stays eligible. Fail-loud on out-of-range. | free |
| `MEMRAIN_RECENCY_DECAY` | built-in map | Per-path-prefix half-life/floor overrides, merged over the default decay map (`prefix:halfLifeDays:floor`, CSV). Recency weighting is on by default. | free |
| `MEMRAIN_ALIAS_HOP` | on (`=0` off) | Inject up to 3 alias/redirect hops so a query for an alias also surfaces the canonical page. | free |
| `MEMRAIN_NEARDUP_JACCARD` | `0.85` | Jaccard threshold for near-duplicate collapse in results. A value `> 1.0` disables dedup. | free |
| `MEMRAIN_TITLE_BOOST` | `1.25` (on) | Multiplier applied to hits whose title matches the query. A value in `(0,1)` is inert (boost only multiplies up). | free |
| `MEMRAIN_CURATION_BOOST` | built-in map | Per-prefix score multipliers (`prefix:factor`, CSV). Set replaces the default map entirely. | free |
| `MEMRAIN_BACKLINK_BOOST` | on (`=0` off) | Always-on log-scaled backlink-count boost (`1 + 0.05·ln(1+in_degree)`, floor-gated) so hub pages carry a standing lift. `=0` disables. | free |
| `MEMRAIN_COSINE_RESCORE` | off (`=1` on) | Blend a query-chunk cosine term into the fused score (`0.7·RRF + 0.3·cosine`). Inert on the keyword-only fallback path. | free |
| `MEMRAIN_SEARCH_EXCLUDE` | empty | CSV of path prefixes to exclude from search results (e.g. `.raw/`). | free |
| `MEMRAIN_QUERY_CACHE` | on (`=0` off) | Cache query→results within a process. | free |
| `MEMRAIN_QUERY_CACHE_SEMANTIC` | off (`=1` on) | Adds a paraphrase arm to the query cache — a near-identical query hits on query-embedding cosine instead of an exact-string match. Only ever *adds* hits; never suppresses a fresh search. (mig 065.) | free |
| `MEMRAIN_QUERY_EMBED_TIMEOUT_MS` | `6000` | Wall-clock budget for the query-embed Bedrock call; on timeout search falls back to keyword-only (non-fatal). Floor 2000ms. | free |
| `MEMRAIN_EMBED_DIM` | `1024` | Embedding vector width. Must match the `vector(...)` column width — changing it requires a schema migration + full re-embed. Fail-loud on a non-positive-integer value. | free |
| `MEMRAIN_CHUNK_OVERLAP` | `300` (on) | Characters of tail-of-previous-chunk to prepend to each chunk. `0` turns overlap off; an unparseable value falls back to the default. Applies to newly indexed pages; stored chunks keep their overlap until re-indexed. Capped at half the previous chunk. | free |
| `MEMRAIN_TRACK_RETRIEVAL` | on (`=0` off) | Write-back `last_retrieved` timestamps on hit. | free |
| `MEMRAIN_ANOMALY_SIGMA` | `2` | k in `mean + k·stddev` for usage-insight anomaly flags. | free |
| `MEMRAIN_SEARCH_MODE` | `conservative` | Picks a bundle of search knobs at once. `conservative`: every optional stage off, no token cap. `balanced`: Haiku rerank, graph signals, cosine rescore and the relational arm on, 12000-token result cap. `tokenmax`: all of that plus LLM query expansion, no cap. A per-knob env set to `1`/`0` wins over the bundle. Unknown values fall back to `conservative`. | paid in `balanced`/`tokenmax` (Haiku) |
| `MEMRAIN_RELATIONAL_ARM` | from the mode bundle | `1` adds the relational (typed-edge) arm to hybrid search, `0` removes it, whatever the mode says. | free |
| `MEMRAIN_RELATIONAL_ARM_WEIGHT` | `1.0` | RRF weight of the relational arm. Non-positive or invalid values fall back to the default. | free |
| `MEMRAIN_TITLE_ARM` | on (`=0` off) | Title-match arm that lets a query naming a page reach it directly. | free |
| `MEMRAIN_MAXPOOL` | off (`=1` on) | Each retrieval arm returns its best chunk per page, so the candidate budget covers distinct pages. Skipped for `exact` intent and structural walks. | free |
| `MEMRAIN_MAX_TYPE_RATIO` | `0.6` | Largest share of the candidate set one page type may hold. `>= 1` disables the cap. Fail-loud on a malformed value. | free |
| `MEMRAIN_RECENCY_BOOST` | built-in map | Per-prefix recency boost (`prefix:halfLifeDays:coefficient`, CSV), merged over the defaults. `0` for either number marks a prefix evergreen. Fail-loud on a malformed entry. | free |
| `MEMRAIN_QUERY_CACHE_SIM` | `0.92` | Cosine floor for a hit on the semantic query-cache arm (`MEMRAIN_QUERY_CACHE_SEMANTIC`). Values outside `(0, 1]` fall back to the default. | free |
| `MEMRAIN_QUERY_CACHE_TTL` | `3600` | Seconds a semantic query-cache entry lives. | free |
| `MEMRAIN_RERANK_WINDOW` | `30` | How many top candidates the rerank pass sees; it may promote one from below the return cutoff. Clamped to `>= k`. Allowlisted. | free (the rerank call itself is priced under `MEMRAIN_RERANK`) |
| `MEMRAIN_RERANK_TIMEOUT_MS` | `5000` | Wall-clock limit for one rerank call; on timeout the hits come back unreranked. | free |
| `MEMRAIN_TRAJECTORY_REGRESSION_THRESHOLD` | `0.1` | Drop in `find_trajectory` score that counts as a regression. Must be in `(0, 1)`; anything else uses the default. | free |
| `MEMRAIN_ORPHAN_EXCLUDE_WRITERS` | built-in list | Replaces the list of `written_by` values whose pages never count as orphans. Presence decides: set to empty, every page counts. CSV. | free |
| `MEMRAIN_ORPHAN_EXCLUDE_EXTRA` | empty | Adds `written_by` values to that list. CSV. | free |

`near_symbol` and `walk_depth` are **search-tool parameters**, not env vars —
pass them per call (`walk_depth` 1–2, capped at 2; inert unless `walk_depth > 0`
or `near_symbol` is set). They drive the structural call-graph expansion pass.

---

## 3. Agent-layer synthesis (cheap — Claude Haiku)

Opt-in synthesis chain (atoms → concepts → takes → grade → calibration) written
to the isolated `synth_*` store and read via `list_concepts` / `list_takes`.
Runs on Bedrock **Claude Haiku** (the utility tier — Amazon Nova was removed).
Cost is low but non-zero; all default OFF, so the brain is pure-retrieval unless
you opt in.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMRAIN_RERANK` | off (`=1` on) | Two-pass rerank — reorders the top hybrid hits with one Claude Haiku call per search. The budget alternative to the paid Sonnet `MEMRAIN_GRAPH_RERANK`; near-identical ranking quality. | cheap (Haiku, ~$1–3/mo) |
| `MEMRAIN_DREAM_SYNTHESIS` | off (`=1` on) | Appends the Haiku synthesis chain to quiet-hours cycle ticks only. Idempotent, count-capped. | cheap (Haiku) |
| `MEMRAIN_DREAM_SYNTHESIS_MAX_DOCS` | `25` | Max source docs fed per synthesis run. Code-only. | — |
| `MEMRAIN_DREAM_SYNTHESIS_MAX_CONCEPTS` | `30` | Max concepts produced per run. Code-only. | — |
| `MEMRAIN_DREAM_SYNTHESIS_MAX_TAKES` | `25` | Max takes produced per run. Code-only. | — |
| `MEMRAIN_DREAM_SYNTHESIS_MIN_GRADED` | `5` | Minimum graded takes before the run is considered complete. Code-only. | — |
| `MEMRAIN_GRADE_MIN_AGE_DAYS` | `182` | Minimum age a take must reach before it becomes eligible for grading — lets a take settle before it is judged. `0` disables the gate. Fail-loud on a negative value. Code-only. | free |
| `MEMRAIN_TAKE_EMBED` | off (`=1` on) | Embed each synthesized take so takes are semantically searchable; off leaves the take's embedding column NULL. Code-only. | cheap (embed) |
| `MEMRAIN_DREAM_INTERVAL_S` | `21600` (6h) | Maintenance-cycle interval. | free |
| `MEMRAIN_DREAM_STALE_DAYS` | `30` | Re-embed docs older than this many days during the cycle. | free |
| `MEMRAIN_UTILITY_MODEL` | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | Overrides the Haiku utility-tier model id (intent classification, query expansion, rerank, synthesis, contextual blurbs). Use the per-feature keys below to move one call site. | cheap (Haiku) |
| `MEMRAIN_INTENT_LLM` | off (`=1` on) | Paid Haiku tie-break for queries the regex intent taxonomy cannot place. Off, intent classification makes no model call. Code-only. | cheap (Haiku) |
| `MEMRAIN_QUERY_EXPANSION` | off (`=1` on) | LLM query expansion: Haiku generates query variants for extra keyword passes. Off in the default search mode. Code-only. | cheap (Haiku) |
| `MEMRAIN_EXPANSION_MODEL` | utility model | Model id for query expansion only. Allowlisted. | cheap (Haiku) |
| `MEMRAIN_INTENT_MODEL` | utility model | Model id for the `MEMRAIN_INTENT_LLM` tie-break only. Allowlisted. | cheap (Haiku) |
| `MEMRAIN_RERANK_MODEL` | utility model | Model id for the `MEMRAIN_RERANK` two-pass rerank only. Allowlisted. | cheap (Haiku) |
| `MEMRAIN_CONCEPTS_MODEL` | utility model | Model id for concept synthesis only; `MEMRAIN_CONCEPTS_BUDGET_USD` prices the same model. Allowlisted. | cheap (Haiku) |
| `MEMRAIN_WORTH_GATE` | off (`=1` on) | A cached Haiku verdict ("is this transcript worth synthesizing?") in front of the paid transcript consumers (reflections, conversation-facts backfill). Fail-open: a judge error lets the transcript through. Code-only. | cheap (Haiku) |
| `MEMRAIN_SYNTH_PAGES` | on (`=0` off) | Mirrors synthesis atoms and concepts into pages. `0` keeps them in the `synth_*` tables only. Code-only. | free |
| `MEMRAIN_LLM_MAX_INFLIGHT` | `4` | Bedrock chat calls one process runs at once; the rest wait. Code-only. | — |

Model ids resolve in `core/llm/resolve-model.ts`, in this order: the feature's
own key (`MEMRAIN_<FEATURE>_MODEL`), then the tier key (`MEMRAIN_UTILITY_MODEL` or
`MEMRAIN_FACTS_MODEL`), then the built-in default. An empty value falls through.

---

## 4. Paid opt-in Bedrock Sonnet slices

**Every flag here triggers a PAID Claude Sonnet call when set.** Each is bounded
by its own `*_BUDGET_USD` companion (default `1.0`) via a USD `BudgetTracker`
that stops making calls once the budget is spent. All default OFF.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMRAIN_THINK` | off | Enables `memrain think <q>` deep synthesis — **CLI-only**, does not fire on search. | **paid (Sonnet)** |
| `MEMRAIN_DAILY_BUDGET_USD` | off | Brain-wide daily USD cap over every paid call (all clients, cycle, jobs and CLI) in a UTC day, holds included. Blank, malformed or negative is off; `0` refuses everything. Refusals carry reason `daily_cap`. Suggested `1.00`. Allowlisted. | — |
| `MEMRAIN_CYCLE_MAX_USD_PER_DAY` | off | Daily USD cap over calls made under a cycle phase. Same parsing as `MEMRAIN_DAILY_BUDGET_USD`. Suggested `0.30`. Allowlisted. | — |
| `MEMRAIN_THINK_BUDGET_USD` | `1.0` | USD ceiling for `think`. | — |
| `MEMRAIN_THINK_OUTPUT_TOKENS` | `4000` | Output-token cap for one `think` call. `think` returns structured JSON, so a cut-off answer is total loss rather than a shorter answer — raise this if answers come back incomplete. Clamped to 8000. Code-only. | — |
| `MEMRAIN_THINK_AUTO_ANCHOR` | on (`=0` off) | When a temporal question ("when did X change, is it still…") names no anchor, `think` derives candidate entity slugs from the question + retrieved pages and anchors on them. Temporal/knowledge-update intents only, fail-soft. A behavior toggle inside the `think` flow — no extra billable call beyond `think` itself. Code-only. | — |
| `MEMRAIN_RELATIONAL_LLM` | off | Sonnet fallback for the relational retrieval arm when the cheap path is inconclusive. | **paid (Sonnet)** |
| `MEMRAIN_RELATIONAL_LLM_BUDGET_USD` | `1.0` | USD ceiling for the relational arm. | — |
| `MEMRAIN_GRAPH_RERANK` | off | Sonnet rerank over graph-expanded candidates — **fires on every search**, so the highest-frequency paid path. Enable deliberately. | **paid (Sonnet)** |
| `MEMRAIN_GRAPH_RERANK_BUDGET_USD` | `1.0` | USD ceiling for graph rerank. | — |
| `MEMRAIN_DEEP_SYNTH` | off | Scheduled `think` over the top concepts during the cycle. | **paid (Sonnet)** |
| `MEMRAIN_DEEP_SYNTH_BUDGET_USD` | `1.0` | USD ceiling for deep-synth. | — |
| `MEMRAIN_DEEP_SYNTH_MAX_QUESTIONS` | built-in | Cap on questions per deep-synth run. | — |
| `MEMRAIN_TAKE_ENSEMBLE` | off | N-judge Sonnet grading of takes. | **paid (Sonnet)** |
| `MEMRAIN_TAKE_ENSEMBLE_BUDGET_USD` | `1.0` | USD ceiling for the ensemble. | — |
| `MEMRAIN_TAKE_ENSEMBLE_JUDGES` | `3` | Judges per take. | — |
| `MEMRAIN_FACTS_EXTRACTION` | off | Conversation → structured facts extraction via Sonnet. | **paid (Sonnet)** |
| `MEMRAIN_FACTS_BUDGET_USD` | `1.0` | USD ceiling for facts extraction. | — |
| `MEMRAIN_OWNER_ENTITY` | unset | Slug of the brain owner's entity page (e.g. `people/alice`). When set, a first-person claim the owner makes as `User` in a first-party transcript (Claude Code, Codex, ChatGPT, Claude.ai imports under `transcripts/`, or a `User:` turn in `extract-conversation-facts`) and that the extractor left without an entity is stored on this entity instead of being dropped. Diarised speakers ("Speaker 2") never map. Unset: no change. An invalid slug is ignored with one warning. | — |
| `MEMRAIN_FACTS_JUNK_FILTER` | on (`=0` off) | Drops extracted "facts" that are assistant plan narration ("Let me read the file"), narration about the conversation itself, or a provider spend/rate-limit error sentence. Three anchored patterns; a `commitment` is exempt from the narration one. | free |
| `MEMRAIN_FACTS_MAX_WINDOWS` | `1` | Extractor calls one long non-transcript page may get. `1` reads the first 12,000 characters, as before. Higher cuts the body at paragraph boundaries into 12,000-character windows, one call each under the same per-write ceiling (`MEMRAIN_FACTS_WRITE_BUDGET_USD`); the first window the ceiling refuses ends the run. Transcript pages are already split by the importer. Clamped to 20. | **paid (Sonnet)** per window |
| `MEMRAIN_THINK_QUOTE_VERIFY` | on (`=0` off) | Checks every quoted span of four or more words in a `think` answer against the evidence it was given: an exact match stays, a near match is repaired to the evidence's wording, anything else loses its quotes and is marked `[unverified]`. Deterministic, no model call. | free |
| `MEMRAIN_TIMEZONE` | `UTC` | IANA time zone `think` uses for "today" and for page dates (e.g. `Europe/Berlin`). An invalid name falls back to UTC. | free |
| `MEMRAIN_FACTS_MODEL` | `eu.anthropic.claude-sonnet-4-6` | Overrides the paid-tier Sonnet model id for the slices above. | **paid (Sonnet)** |
| `MEMRAIN_FACTS_EXTRACT_MODEL` | `MEMRAIN_FACTS_MODEL` | Model id for fact extraction only (on write, on demand and the conversation backfill). Allowlisted. | **paid (Sonnet)** |
| `MEMRAIN_THINK_MODEL` | `MEMRAIN_FACTS_MODEL` | Model id for `think` only. Allowlisted. | **paid (Sonnet)** |
| `MEMRAIN_DRIFT_MODEL` | `MEMRAIN_FACTS_MODEL` | Model id for the drift judge only (the cycle phase that checks whether a take's evidence still holds). Allowlisted. | **paid (Sonnet)** |
| `MEMRAIN_DEEP_MODEL` | unset (falls back to Sonnet) | Opt-in deeper model for scheduled deep-synth. Unset, deep-synth runs on the `MEMRAIN_FACTS_MODEL` model. Code-only. | **paid** |
| `MEMRAIN_CONCEPTS_BUDGET_USD` | `0.5` | USD ceiling for one `synthesize_concepts` run. Unlike the caps above this one is ALWAYS on — `maxConcepts` bounds the call count, not the spend, and the cycle passes no tracker of its own. Concepts refused by the ceiling keep their deterministic narrative. Code-only. | — |
| `MEMRAIN_REFLECTIONS` | off | `reflections` cycle phase: one budget-capped Sonnet pass over recent un-reflected transcripts writes cited `reflections/<topic-slug>` pages, giving the `patterns` phase a source to mine. Runs before `patterns`. Code-only. | **paid (Sonnet)** |
| `MEMRAIN_REFLECTIONS_BUDGET_USD` | `1.0` | USD ceiling for the reflections pass. Code-only. | — |
| `MEMRAIN_REFLECTIONS_LOOKBACK_DAYS` | `14` | How far back the pass scans for un-reflected transcripts. Code-only. | — |
| `MEMRAIN_REFLECTIONS_MAX_TRANSCRIPTS` | `20` | Max transcripts fed into one reflections pass. Code-only. | — |
| `MEMRAIN_PATTERNS` | off | `patterns` cycle phase: one budget-capped Sonnet pass mines recent `reflections/` pages for themes recurring across ≥`MIN_EVIDENCE` distinct reflections and writes one `patterns/<topic-slug>` page each (citing its evidence). The one synthesis phase that writes real pages; reads/writes pinned to a single `source_id` (no cross-tenant mining). Code-only. | **paid (Sonnet)** |
| `MEMRAIN_PATTERNS_BUDGET_USD` | `1.0` | USD ceiling for the patterns pass. Code-only. | — |
| `MEMRAIN_PATTERNS_REFLECTION_PREFIX` | `reflections/` | Slug prefix the miner reads (kept in lockstep with what the reflections phase writes). Code-only. | — |
| `MEMRAIN_PATTERNS_MIN_EVIDENCE` | `3` | Minimum distinct reflections a theme must span before a pattern page is written. Code-only. | — |
| `MEMRAIN_PATTERNS_LOOKBACK_DAYS` | `30` | How far back the patterns pass reads reflections. Code-only. | — |
| `MEMRAIN_PATTERNS_MAX_REFLECTIONS` | `100` | Max reflections fed into one patterns pass. Code-only. | — |
| `MEMRAIN_AUTO_THINK` | off (`=1` on) | `auto-think` cycle phase: runs the questions in `MEMRAIN_AUTO_THINK_QUESTIONS` through `think` and writes each answer as a draft page under `drafts/think/`. Code-only. | **paid (Sonnet)** |
| `MEMRAIN_AUTO_THINK_QUESTIONS` | empty | CSV of standing questions. With none set the phase does nothing. Code-only. | — |
| `MEMRAIN_AUTO_THINK_MAX` | `5` | Max questions per run. Code-only. | — |
| `MEMRAIN_AUTO_THINK_BUDGET_USD` | `2.0` | USD ceiling for one run, shared across its questions. `0` is a real cap. Code-only. | — |
| `MEMRAIN_AUTO_THINK_COOLDOWN_HOURS` | `12` | Minimum hours between runs per tenant. `0` disables the cooldown. Code-only. | — |
| `MEMRAIN_DRIFT` | off (`=1` on) | `drift` cycle phase: takes (weight 0.3–0.85) whose source document was re-ingested after the take was made are judged against the new text, and the result is written to a `drift-reports/` page. Code-only. | **paid (Sonnet)** |
| `MEMRAIN_DRIFT_BUDGET_USD` | `1.0` | USD ceiling for one drift run. `0` is a real cap. Code-only. | — |
| `MEMRAIN_DRIFT_COOLDOWN_HOURS` | `12` | Minimum hours between drift runs per tenant. Code-only. | — |
| `MEMRAIN_DRIFT_MAX_CANDIDATES` | `12` | Max takes judged per run. Code-only. | — |
| `MEMRAIN_ENRICH_THIN` | off (`=1` on) | `enrich-thin` cycle phase: rewrites a few short real pages in place, expanding each from its linked neighbours only (one Sonnet call per page, citations as wiki links). Code-only. | **paid (Sonnet)** |
| `MEMRAIN_ENRICH_THIN_BUDGET_USD` | `1.0` | USD ceiling for one run. `0` is a real cap. Code-only. | — |
| `MEMRAIN_ENRICH_THIN_COOLDOWN_HOURS` | `12` | Minimum hours between runs per tenant. Code-only. | — |
| `MEMRAIN_ENRICH_THIN_MAX_PAGES` | `3` | Max pages rewritten per run. Code-only. | — |
| `MEMRAIN_ENRICH_THIN_THRESHOLD` | `400` | Body length (characters) under which a page counts as thin. Code-only. | — |
| `MEMRAIN_ENRICH_THIN_TYPES` | `person,company,concept,note` | Page types eligible for enrichment. CSV. Code-only. | — |
| `MEMRAIN_FACTS_WRITE_BUDGET_USD` | `0.08` | USD ceiling for one fact extraction, either the one a page write triggers when `MEMRAIN_FACTS_EXTRACTION` is on or an on-demand `extract_facts` call, including its one retry when the output is cut off. Code-only. | — |
| `MEMRAIN_AUTO_CHRONICLE` | off (`=1` on) | On an operator write of a conversation-shaped page, queue one `chronicle_extract` job that projects its events into the chronicle. Tenant and public writes never trigger it. Code-only. | **paid (Sonnet)** |
| `MEMRAIN_CHRONICLE_WRITE_BUDGET_USD` | `0.05` | USD ceiling for one page's chronicle extraction (also what `chronicle_backfill` quotes per page). Code-only. | — |
| `MEMRAIN_CHRONICLE_TZ` | `UTC` | Time zone used to turn a chronicle event's time into a date. Code-only. | free |
| `MEMRAIN_TAKE_AUTO_RESOLVE` | off (`=1` on) | Lets a high-confidence ensemble verdict resolve a take instead of staying advisory. Never overwrites a human resolution. Code-only. | free (uses the ensemble's calls) |
| `MEMRAIN_PROBE_VERDICT_TTL_DAYS` | `30` | Days a cached contradiction-probe verdict is reused before the pair is judged again. Code-only. | — |
| `MEMRAIN_REMEDIATION_MAX_USD` | `1.0` | USD ceiling for one `memrain doctor --remediate` run (the re-embed and re-run jobs it queues). Code-only. | — |
| `MEMRAIN_PROBE_CONTRADICTIONS` | off | Latent-contradiction probe (mig 064): a paid cycle phase that caches LLM-suspected fact conflicts so `find_contradictions` can surface them. Paired candidates stay `source_id`-scoped (no cross-tenant pairing). Code-only. | **paid (Sonnet)** |
| `MEMRAIN_PROBE_CONTRADICTIONS_BUDGET_USD` | `1.0` | USD ceiling for the contradiction probe. Code-only. | — |
| `MEMRAIN_FACTS_BACKFILL` | off | `conversation-facts-backfill` cycle phase: extracts facts from historical transcripts that predate on-write extraction. Synthesis-written pages (`reflections/`, `patterns/`) are excluded from the selector. No-ops unless set truthy. Code-only. | **paid (Sonnet)** |
| `MEMRAIN_FACTS_BACKFILL_BUDGET_USD` | `1.0` | Brain-wide USD ceiling for the backfill. Code-only. | — |
| `MEMRAIN_CONTEXTUAL_RETRIEVAL` | off | **LLM-free** contextual-embed wrapper. ⚠️ Enabling it changes only *future* embeds — **run a full re-embed after enabling**, or the vector space becomes a mix of wrapped and unwrapped vectors and search quality degrades. | free (but forces re-embed) |
| `MEMRAIN_CONTEXTUAL_LLM` | off | **PAID per-chunk** contextual tier (Haiku): asks a utility model to write a short blurb situating EACH chunk within its whole document, replacing the deterministic synopsis before embedding. Fail-open — budget/errors fall back to the deterministic prefix. ⚠️ Same re-embed caveat as above; run `reindex --contextual` after enabling. | **paid (Haiku)** |
| `MEMRAIN_CONTEXTUAL_LLM_DOC_MAX_CHARS` | `60000` | How much of the document the contextual tier sends with each chunk: a window of about this many characters around the chunk. Clamped to 2000–300000. Allowlisted. | — |
| `MEMRAIN_CONTEXTUAL_LLM_BUDGET_USD` | `5.0` | USD ceiling for the per-chunk LLM tier. Shared across a whole `reindex --contextual` run; when spent mid-run, remaining chunks fall back to deterministic. A later `--force` re-run with more budget upgrades them. | — |
| `MEMRAIN_EMBED_MAX_INFLIGHT` | `4` | How many chunks an interactive write (`page_put`, `page_append`, `page_revert`, `page_restore`) situates and embeds at once, shared by every concurrent write in the process. Each chunk costs a contextual call and an embed; serially a page paid about 1.3 s per chunk. Sweeps, reindex and the cycle stay serial. `1` restores the old serial behaviour everywhere. Not the backfill's pool width (`MEMRAIN_EMBED_CONCURRENCY`), and not applied to query embeds. | — |
| `MEMRAIN_PAGE_MIRROR_SYNC` | `1` | Where a written page's search mirror is built. `1` (default): inline, before `page_put` / `page_append` return, which is where their latency goes. `0`: queued as a `page_mirror` job on the worker, so the write returns at once and search sees the page seconds later; the response carries `search_pending: true` and `search_job_id` instead of `search_indexed`, and a caller that must search straight away passes `wait_for_index: true`. `page_revert` and `page_restore` always mirror inline. | — |
| `MEMRAIN_LLM_TIMEOUT_MS` | per kind | Shared Bedrock request timeout for every call kind that has no knob of its own. A timeout ENDS the request (it used to only log a warning while the request ran on) and the SDK retries it with the other transient failures — up to 4 attempts, adaptive backoff. | — |
| `MEMRAIN_LLM_UTILITY_TIMEOUT_MS` | `30000` | Timeout for utility-tier chat (Haiku): contextual chunk blurbs, reranking, query expansion, intent. | — |
| `MEMRAIN_LLM_REASONING_TIMEOUT_MS` | `120000` | Timeout for reasoning-tier chat (Sonnet). Longer by default so a long generation does not start failing now that the limit is enforced. | — |
| `MEMRAIN_EMBED_TIMEOUT_MS` | `10000` | Timeout for Titan embedding calls. | — |


> **Measured, not estimated** — a single-operator brain with
> `MEMRAIN_CONTEXTUAL_LLM=1`, 30 days to 2026-09-08: the utility tier booked
> **$12.12 over 1924 calls**, and **970 of those calls ($9.83) landed inside a
> `page_put` window** — i.e. eight dollars in ten are spent wrapping chunks
> while the caller waits. `page_put` averaged **33 s** that week (worst 116 s),
> against **2 cents** for every Titan embedding in the same period. The wrapper
> is on the write path and synchronous: one Haiku call per chunk, per write.
> Turn it off and writes drop to seconds; measure `eval-probe`'s hit rate
> before and after rather than guessing at the quality it buys.

---

## 5. Auth & source scoping

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMRAIN_TENANT_FAIL_CLOSED` | off (`=1` on) | When on, an authenticated PUBLIC principal with no source grant reads/writes **nothing** instead of the redacted whole brain. The static bearer (no `authInfo`) is unaffected. Flip once a real remote OAuth client with a grant exists. | free |
| `MEMRAIN_OPERATOR` | unset (falls back to `USER`, then `cli`) | Name recorded as the actor on grant changes made with `memrain auth rescope-client`. Audit data only; it grants nothing. A self-chosen label, not an authenticated identity. | free |
| `MEMRAIN_PUBLIC_WRITE` | `0` | When `1`, the public `/mcp` path may call the constructive write tools (`index`, `page_put`, `page_append`, `add_fact`, `add_timeline_event`, `add_tag`, `link`). Destructive ops + privacy-sensitive reads stay internal-only regardless. The static bearer is permanent, so anyone holding it can then write; prefer scoped PATs or OAuth clients for writers. | free |
| `MEMRAIN_ASSUME_PUBLIC` | off (`=1` on) | Treat every HTTP request as public ingress. Public detection otherwise keys on the `Cf-Connecting-Ip` header a Cloudflare Tunnel injects; behind another proxy that does not add it, set this (or inject the header) or remote callers are judged as internal peers. Allowlisted. | free |
| `MEMRAIN_HTTP_CORS_ORIGIN` | unset (no cross-origin) | CSV of browser origins allowed to call Memrain cross-origin. Unset denies every cross-origin request. Allowlisted. | free |
| `MEMRAIN_MCP_RATE_LIMIT_PER_TOKEN_PER_MINUTE` | unset (off) | Per-credential cap on `/mcp` requests per minute, applied after authentication, on top of the per-IP limiter. Allowlisted. | free |
| `MEMRAIN_PUBLIC_READ_BODIES` | off (redacted) | When on, public reads return full page bodies instead of redacted snippets. Leave off on a shared brain. Code-only. | free |
| `MEMRAIN_HTTP_TRUST_PROXY` | off (`=1` on) | Let every header-keyed rate limiter fall back to `X-Forwarded-For` (first hop) then `X-Real-IP` when `Cf-Connecting-Ip` is absent. Both are attacker-controlled unless a trusted reverse proxy overwrites them, and a spoofable key is worse than none — the caller rotates values and mints a fresh bucket per request. Off, an unattributable caller is not metered per-IP at all. Turn on ONLY behind a proxy that terminates the client connection and rewrites those headers itself. | free |
| `MEMRAIN_ADMIN_BOOTSTRAP` | unset | Admin-panel bootstrap token consumed by `serve.ts` at start. Must be 32+ chars from `[A-Za-z0-9_-]` or the server refuses to boot; unset ⇒ an ephemeral per-run token is printed to stderr. | free |
| `MEMRAIN_ENABLE_DCR` | off (`=1` on) | Dynamic Client Registration. Default OFF: `POST /register` returns 404 and discovery omits `registration_endpoint`, so no one can self-register a client — an operator creates clients via `memrain auth register-client`. When on, a self-registered client gets the `authorization_code` grant (`client_credentials` is refused). **That grant only carries operator consent when `/authorize` is gated on a logged-in operator, so the server refuses to boot with DCR on unless `MEMRAIN_OAUTH_REQUIRE_LOGIN=1` (with `MEMRAIN_ADMIN_BOOTSTRAP`) or the explicit `MEMRAIN_ENABLE_DCR_INSECURE=1` is also set.** Turn on only if a client must self-register. | free |
| `MEMRAIN_ENABLE_DCR_INSECURE` | off (`=1` on) | Also let self-registered clients request the `client_credentials` grant, which mints a token WITHOUT the `/authorize` consent step. Implies `MEMRAIN_ENABLE_DCR`, and acknowledges that an unauthenticated caller can obtain a default-tenant token with no operator in the loop (satisfies the DCR boot check without `MEMRAIN_OAUTH_REQUIRE_LOGIN`). Leave off unless a trusted machine-to-machine client must self-register — prefer `memrain auth register-client` instead. | free |
| `MEMRAIN_OAUTH_REQUIRE_LOGIN` | off (`=1` on) | When on, `GET /authorize` requires a logged-in operator (admin session) before issuing an authorization code; off (default) auto-approves. Needs `MEMRAIN_ADMIN_BOOTSTRAP` set to be usable. | free |
| `MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE` | off (`=1` on) | What happens when a client presents a refresh token it already rotated more than 60 seconds ago. Off (default): the request is refused with `invalid_grant` and logged as `[oauth] refresh token reuse`, and the session keeps working. On: every live access and refresh token of that sign-in is also deleted, so both holders must sign in again. Turn on once the logs show no legitimate client replays late. | free |
| `MEMRAIN_PUBLIC_URL` | unset (request host) | External base URL (Cloudflare tunnel origin). When set, the OAuth discovery document + issuer advertise this `https://…` origin so a cloud MCP client auto-configures against the real host. Set it behind any TLS-terminating proxy: unset, the issuer comes from the request (`http://…` there), and the RFC 8707 `resource` check at `/authorize` and `/token` refuses a client's `https://` connector URL with `invalid_target`. `serve` warns at boot when OAuth is on and it is unset. | free |
| `MEMRAIN_HOT_MEMORY_META` | off (`=1` on) | Surface a `_meta` block on `hot_memory` responses (non-public calls only). Stays dark — empty payload — until an operator opts in. Code-only. | free |
| `MEMRAIN_DOCTOR_PER_SOURCE` | off (`=1` on) | Makes `doctor` WARN per-source (per-tenant) when a single source has chunks but zero embeddings. | free |
| `MEMRAIN_REQUEST_LOG_DB` | off (`=1` on) | Persist per-request MCP logs to the DB (in addition to stderr). Code-only. | free |
| `MEMRAIN_LOG_REQUESTS` | off | Emit redacted per-request MCP param logs to stderr. Nothing is logged unless set. Code-only. | free |
| `MEMRAIN_DEPLOYMENT_IDENTITY` | unset | One line on what this brain is (for example "Team brain for the docs group"). Appended to the MCP `initialize` instructions as a `Deployment:` paragraph after Memrain's built-in operating contract. Trimmed and capped at 2000 characters. Served to **every** caller, public ingress included: public-facing prose only, never a secret. | free |
| `MEMRAIN_MCP_INSTRUCTIONS` | unset | Extra operator guidance appended after the deployment identity in the `initialize` instructions (for example where meeting notes belong). Trimmed and capped at 2000 characters. Served to every caller, public ingress included, so it must not hold secrets. | free |
| `MEMRAIN_MCP_LENIENT_ARGS` | off | MCP calls that pass an argument the tool does not declare are refused with `invalid_params` and a did-you-mean hint. `=1` accepts and ignores unknown arguments again: a temporary escape for an old client, since a misspelled key is then dropped without an error. | free |

### Agent jobs and skill optimization

Both are off unless switched on, and both run under a per-run dollar ceiling.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMRAIN_AGENT_ENABLED` | off (`=1` on) | Registers the `subagent` job kind: a read-only research agent (`memrain agent run`) that uses Memrain's read tools and writes nothing. Allowlisted. | **paid (Sonnet)** |
| `MEMRAIN_AGENT_TENANT_ENABLED` | off (`=1` on) | Also lets OAuth clients holding the `agent` scope queue jobs with `submit_agent` / `get_agent_job`, run under the submitter's grant and daily budget. Needs `MEMRAIN_AGENT_ENABLED=1`. Allowlisted. | **paid (Sonnet)** |
| `MEMRAIN_AGENT_MAX_USD` | `0.25` | Per-job ceiling; a job's own `max_usd` is clamped to it. Allowlisted. | — |
| `MEMRAIN_SKILLOPT_ENABLED` | off (`=1` on) | Enables `memrain skillopt eval`, which scores skill routing on the pack benchmark. Allowlisted. | **paid (Haiku)** |
| `MEMRAIN_SKILLOPT_MAX_USD` | `0.25` | Per-run ceiling; `--max-usd` can lower it, not raise it. Allowlisted. | — |
| `MEMRAIN_SKILLS_DIR` | `deploy/skills` (compose: `/skills`) | Skill pack served by `list_skills` / `get_skill` and linted by `memrain skillpack lint`. Allowlisted. | free |

### Source scope contract

Every read path takes the caller's source scope as `sourceIds`, and its four
shapes mean different things:

| `sourceIds` | Who | Reads |
|---|---|---|
| `undefined` | the local CLI, the internal token, the operator | the whole brain — no predicate at all |
| `[]` | an authenticated caller granted nothing | **nothing** |
| `[NO_SOURCE_SENTINEL]` | the write-side floor; a read helper that meets it treats it as `[]` | nothing (same as `[]`) |
| `['a', 'b']` | a scoped or federated grant | only those sources |

Folding `[]` into `undefined` is the bug shape: it hands the caller with no
grant strictly more than a caller with a narrow one. The rule is therefore:

> **Never test a source list with `x && x.length`.** Test `!== undefined`, or
> build the SQL through the helper below.

`deploy/memrain/src/core/source-scope.ts` is the one reading of that contract:

- **`isNoGrant(scope)`** — true for `[]` or a sentinel-only list. Use it to
  return early before doing paid or expensive work: `hybridSearch` returns no
  rows before embedding the query or touching the cache, so an empty grant costs
  nothing.
- **`andSourceScope(col, scope, params)`** — the SQL fragment for a read. It
  returns `""` when unscoped (so the operator's SQL text is byte-identical),
  ` AND FALSE` for an empty grant or a sentinel-only list (never a lookup of the
  sentinel id — `registerSource` refuses that id), and ` AND <col> = ANY($n::text[])` otherwise,
  pushing the bound array onto `params` only when it emits a predicate. The
  column must be a plain `column` or `alias.column` identifier.
- **`normalizeScope(scope)`** — cleans a list for a bound array (drops blanks,
  dedupes) while keeping `undefined` unscoped and `[]` empty. Use it instead of a
  local normaliser; a local one that returns `undefined` for an empty list is the
  bug shape.
- **`normalizeSourceFilterParam(value)`** — for a USER-supplied filter only (a
  CLI flag, a bench fixture): an empty or blank list means "no filter given" and
  becomes `undefined`. Never pass an auth-derived scope through it.

Three tests hold the contract in place:

- `deploy/memrain/tests/source_scope_pattern_ratchet.test.ts` scans
  `deploy/memrain/src` (comments stripped) for the collapsing
  `sourceIds && sourceIds.length` shape, its `Array.isArray(x) && x.length` form,
  and normalisers that map an empty list to `undefined`, under any
  `source(s)`/`sourceId(s)` name, and fails on any hit. A second case proves the pattern still matches a probe,
  so the ratchet cannot pass by matching nothing.
- `deploy/memrain/tests/operator_scope_parity.test.ts` proves the operator's reads
  did not move. It seeds a fixed two-tenant brain, runs 46 read tools UNSCOPED
  through `dispatchTool`, and compares the SQL text, bound params and response of
  each with `deploy/memrain/tests/fixtures/operator_scope_parity.json`
  (timestamps, latencies and float tails beyond six decimals are scrubbed). When
  an operator-visible change is intended, re-record deliberately and review
  the fixture diff line by line before accepting it:

  ```bash
  cd deploy/memrain
  MEMRAIN_RECORD_OPERATOR_PARITY=1 bun test tests/operator_scope_parity.test.ts
  git diff tests/fixtures/operator_scope_parity.json
  ```

  Any diff you did not intend is a regression in the operator path, not a
  fixture to refresh.
- `deploy/memrain/tests/tenant_isolation_matrix.test.ts` gives every MCP operation
  a row in `deploy/memrain/tests/fixtures/tenant_isolation_matrix.ts` (`isolated`,
  `brainwide`, `operator_only`, `write`, or `skip` with the suite that owns it)
  and fails when an operation has none. Each `isolated` read must first show
  the operator a second tenant's data (otherwise the row is vacuous and fails),
  then must not show it to a scoped, a federated or a no-grant caller.

Hybrid search honours the contract end to end: query-cache keys for `[]` differ
from the unscoped key, both hydration passes are scoped, and the identifier,
relational, structural and alias-hop arms read nothing for an empty grant. The
final hydration pass also applies the visibility filter, so a soft-deleted,
archived or quarantined page no longer surfaces as a structural neighbour. The
remaining layers — core readers, MCP dispatch, derived writes, source deletion,
purge and code-graph edges — are tracked with file:line in `TODO.md` under
RM-01.

The same split governs writes. A page's derived rows — links, mentions, typed
and verb edges, the extraction watermark, fence-derived facts — carry the
**page's** source, not the caller's, so an unscoped operator write cannot
re-home a tenant's projections into `default`. `page_put` does this; the
`page_append`, `page_revert` and `page_restore` paths still carry the caller's
source (RM-01 Release B).

### Running more than one tenant

A source is the tenancy unit: it owns writes, and a client's read set is a union
of sources. Nothing below is on by default — a single-operator brain stays
single-tenant and unaffected.

```bash
# 1. One source per person or team.
memrain sources register alice --kind other --path-prefix tenant:alice

# 2. One OAuth client per source. --source is the WRITE authority;
#    --federated-read is the read union (list only what this client may see).
memrain auth register-client alice-laptop \
  --scopes 'read write' --source alice --federated-read alice

# 3. Optional daily ceiling, in USD, enforced across every paid op.
memrain auth set-budget <client_id|token_name|enrollment_id> 2.00 # 'none' removes it
```

A cap can sit on an OAuth client, a personal access token (by name) or an
enrollment. To see where the money went, run `memrain spend [--days N]` (default
7) or call `GET /admin/api/spend/report?days=N`: spend by model, feature and
spender (OAuth clients, personal access tokens, enrolled people), plus the
unpriced models and the calls that failed before the provider reported usage.

Print the client's own view any time with the `whoami` tool: it returns the
`write_source` and the `read_sources` the token actually carries.

What a scoped client can reach, and what it cannot:

| Surface | Scoped client sees |
|---|---|
| `search`, `page_get`, `page_list`, `recall`, `think` | its own read set only |
| `add_tag` on another tenant's slug | the same "not found" as a slug nobody holds — no existence oracle |
| an enrollment code | single-use, expiring; binds the grant to one source |
| `index` / `page_put` onto another tenant's path | refused (`permission_denied`) |
| `get_brain_identity` counters | its own read set; `sources` is the size of that set |
| `run_doctor`, `stats`, `get_status_snapshot` (whole brain) | refused — operator-only |
| `sources_list` | only the sources its grant covers |
| `purge_deleted_pages` | needs the `admin` scope, recorded deliberately |

### Connecting a whole team through ONE connector

> Task-oriented walkthrough, day-2 operations and troubleshooting:
> [TEAM-SETUP.md](./TEAM-SETUP.md). What follows is the reference.

On a Claude Team or Enterprise plan **only an Owner can add a connector**, and
every member then authorises against that single client. So the tenant cannot
come from the client row — one connector would be one tenant for everybody.
An **enrollment-mode** client fixes that: the grant is bound to a source at the
moment the person authorises, not at registration.

```bash
# 1. One source per person.
memrain sources register alice --kind other --path-prefix tenant:alice

# 2. ONE connector for the whole team, in enrollment mode.
memrain auth register-client team-connector --tenant-mode enrollment \
  --scopes 'read write' --source default \
  --redirect-uris 'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback'

# 3. One code per person, bound to her source. Printed ONCE.
memrain auth enroll alice --label alice --client <client_id> --ttl 7d
```

The Owner puts the connector URL + `client_id` + `client_secret` into the
organisation's connector once (Advanced settings). Each person clicks
**Connect**, is asked for her enrollment code, and from then on her sessions —
and every refresh after them — are pinned to her own source.

**In enrollment mode the code is the per-person credential; the client secret
is shared.** The `client_id` and secret identify the connector, not a person,
and every organisation admin can read them in the connector settings. That is
safe only because a browser client (registered with `--redirect-uris`) has no
`client_credentials` grant, so the secret alone mints nothing: `/authorize`
shows the code form and stops there. Check the grant list with
`memrain auth list-clients`; the step-by-step is in
[TEAM-SETUP.md](./TEAM-SETUP.md#why-sharing-the-connector-secret-is-safe).

`memrain auth enrollments [--client <client_id>]` lists what was issued (never
the codes). `memrain auth revoke-enrollment <id>` kills a code that has not been
used; `memrain auth revoke-grant <id>` cuts off a person who already redeemed
hers and deletes that grant's tokens, while everyone else on the connector keeps
working. `memrain auth enroll --replaces <id>` issues a new code for the same
person, keeping her source, read set, spend key and daily cap. A code is
single-use, expires (7 days by default), and a wrong, used, expired or revoked
code all fail identically so the form cannot be used to probe. The admin
panel's Credentials page has the same actions under **Members** for each
browser connector.

**Per-person connectors** (`--tenant-mode client`, the default) are still the
right shape when each person has her own individual Pro/Max account and adds
her own connector: the tenant then comes from the client row, so
`claude-alice` → source `alice` with no code to enter. Here the client secret
IS the per-person credential — hand it over the way you would a password, and
never share one client between two people.

**Budgets are per person on a team connector.** A token redeemed from an
enrollment code spends under that enrollment, and
`memrain auth set-budget <enrollment_id> <usd>` caps one person. Without such a
cap, the connector's `budget_usd_per_day` applies to each person separately.

**`MEMRAIN_OAUTH_REQUIRE_LOGIN` does not apply to an enrollment-mode client** —
the code is the resource-owner authentication. It does gate a `client`-mode
connector: the flag makes `GET /authorize` bounce an unauthenticated browser to
`/admin/login`, and that page accepts exactly one credential, the operator
bootstrap token (a magic link minted by whoever holds it grants a 7-day ADMIN
session). Memrain has no per-user login, so with the flag on a teammate can only
finish a `client`-mode flow by holding an operator session for the whole brain.
Keep it on for a brain that serves one operator; turn it off before handing a
`client`-mode connector to anyone else.

With the flag off, `/authorize` is still not a free-for-all:

- a code is only ever sent to a **registered** `redirect_uri` on that client;
- exchanging the code for a token requires the **client secret**, so a caller
  who knows only the `client_id` gets nothing;
- a public client (no secret) in `client` mode is refused with
  `unauthorized_client` while `/authorize` auto-approves;
- Dynamic Client Registration stays off, so nobody can mint a client.

Register the callback the person's account actually uses. `claude.ai` and
`claude.com` are different origins to the allow-list; a connector on the origin
you did not register fails with `redirect_uri is not registered for this
client`. Replace a client's list without rotating its secret:

```bash
memrain auth set-redirect-uris <client_id> \
  https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback
memrain auth rescope-client <client_id> --source alice --federated-read alice
```

Every rescope is revisioned and audited. Preview it with `--dry-run` (prints
the before/after diff and the current revision), then apply it with
`--expected-revision N`: if someone changed the grant in between, it fails with
`grant_conflict` and writes nothing. `memrain auth grant-history <client_id>`
shows who changed the grant and when; the admin API exposes the same through
`POST /admin/api/rescope-client` (`dry_run`, `expected_revision`) and
`GET /admin/api/grant-audit?client_id=`.

The `actor` on an audit row is a label, not an authenticated identity. The CLI
records `MEMRAIN_OPERATOR` (else `USER`, else `cli`), which whoever runs the
command can set to anything; the admin API records `admin` for every change.
Read it as a note about who said they made the change, and rely on host access
logs when you need to know who did.

Two things to know before you rely on this:

- **Set `MEMRAIN_TENANT_FAIL_CLOSED=1`** once a real scoped client exists. Without
  it an authenticated public principal that carries NO grant falls back to the
  redacted whole brain instead of to nothing. Every scoping rule in the table
  above binds on the caller's grant, so a grantless principal is the one caller
  they do not constrain — this flag is what removes that hole, not an
  optimisation.
- **Dynamic Client Registration hands every self-registered client the same
  `default` tenant.** If you enable `MEMRAIN_ENABLE_DCR`, two people who each
  register through it share one tenant and read each other's notes. Register
  clients yourself (`memrain auth register-client --source …`), or rescope one
  afterwards with `memrain auth rescope-client <client_id> --source SRC
  --federated-read SRC`.

---

## 6. Maintenance cycle & ingest / ops

Knobs for the 13-phase maintenance cycle, the file/code sweeps, migrations, and
job timeouts. The compose-allowlisted ones carry explicit defaults in
`deploy/docker-compose.yml`; the rest are code-only.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMRAIN_CYCLE_PHASE_TIMEOUT_MS` | `900000` (15m) | Per-cycle-phase wall-clock cap so a hung phase can't wedge the tick and strand the cycle lock. | free |
| `MEMRAIN_CYCLE_SKIP_PHASES` | none | CSV of cycle phase names to skip every tick — operator escape hatch to isolate a phase with a live defect. | free |
| `MEMRAIN_CYCLE_FIRST_TICK_DELAY_MS` | built-in | Delay before the first cycle tick after boot (lower on a tiny instance). | free |
| `MEMRAIN_CYCLE_FRESHNESS_ENFORCE` | off (`=1` on) | Enforce (vs warn) the cycle-freshness staleness gate. | free |
| `MEMRAIN_CYCLE_FRESHNESS_WARN_HOURS` | `6` | Hours of cycle staleness before a WARN. Clamped ≤ the fail threshold. | free |
| `MEMRAIN_CYCLE_FRESHNESS_FAIL_HOURS` | `24` | Hours of cycle staleness before a failure. | free |
| `MEMRAIN_CYCLE_GC` | on (`=0` off) | Run the manual GC step each cycle. | free |
| `MEMRAIN_CYCLE_RSS_LOG` | on (`=0` off) | Log per-phase RSS memory during the cycle. | free |
| `MEMRAIN_CODE_SWEEP_DELAY_MS` | `20` (compose) / `0` | Delay between files during the code-index sweep. | free |
| `MEMRAIN_PARSE_TIMEOUT_MS` | `5000` (5s) | Per-file chunker parse cap; `0` disables the cap. | free |
| `MEMRAIN_JOB_TIMEOUT_MS` | off | Per-job wall-clock cap. Off unless set. | free |
| `MEMRAIN_JOB_STALL_GRACE_MS` | `30000` | How long past a job's lease the stall sweep waits before requeueing it. Digits only. Allowlisted. | free |
| `MEMRAIN_JOB_LLM_HALT` | on | A Bedrock outage, throttle or missing model defers jobs (without spending a retry) for a cooling-off period. `0`, `false` or `off` restores plain retries. Allowlisted. | free |
| `MEMRAIN_EMBED_GAPS` | on | Cycle phase that embeds chunks stored without a vector (after an outage or spend refusal). `0` turns it off. Allowlisted. | **paid (Titan)** |
| `MEMRAIN_EMBED_GAPS_MAX_PER_CYCLE` | `200` | Most chunks the embed-gaps phase embeds per cycle. Allowlisted. | — |
| `MEMRAIN_SYNTHESIS_ONCE_PER_DAY` | on | Runs each synthesis phase at most once per UTC day. `0` turns it off. Allowlisted. | free |
| `MEMRAIN_WORKER_DRAIN_MS` | `8000` (8s) | On shutdown, how long the jobs worker lets a running job finish. A job still running after it is aborted and handed back to `pending` (`last_error = 'worker_shutdown'`) without spending its retry or stall budget, and the worker lock is released at once. `0` hands back immediately. Keep it under the compose `stop_grace_period` (30s). | free |
| `MEMRAIN_MAX_BODY_BYTES` | `1048576` (1 MiB) | HTTP request-body size cap; over-cap requests get 413. | free |
| `MEMRAIN_NO_SANITY` | off (`=1` on) | Kill switch for the content-sanity ingest gate. Set truthy to skip junk/oversize/markup assessment entirely. The gate runs unless this is set. | free |
| `MEMRAIN_SANITY_DISPOSITION` | `quarantine` | How a junk-flagged doc is handled: default quarantines + stamps `content_flag` (still stored, embed-skipped); `reject` hard-rejects it at ingest. | free |
| `MEMRAIN_CONTENT_SANITY_DISABLE` | empty | CSV of content-sanity pattern names to switch off (e.g. `access_denied,operator_literal_2`), so one pattern that keeps hiding legitimate pages can be silenced without dropping the whole gate. Unknown names are ignored. Each quarantine trip writes an audit row naming the patterns that fired, and `memrain doctor` warns with the count of quarantined pages and the top patterns; disable the culprit, then `memrain quarantine clear`. Allowlisted. | free |
| `MEMRAIN_SANITY_LITERALS_FILE` | unset | Path to an operator literals file (one case-insensitive literal per line, blanks/`#` ignored) so site-specific boilerplate the built-in patterns miss is quarantined. Fail-open. | free |
| `MEMRAIN_PAGE_WARN_BYTES` | `50000` | Byte size above which a page crosses into the markup prose-check window. | free |
| `MEMRAIN_PAGE_BLOCK_BYTES` | `500000` | Byte size above which an oversize page is soft-blocked (no junk match required). | free |
| `MEMRAIN_MAX_MARKUP_RATIO` | `0.85` | Markup-to-prose ratio above which a page is flagged `markup_heavy` (flagged, not hidden). | free |
| `MEMRAIN_SECRET_SCAN_DISPOSITION` | `redact` | What happens to a credential found in content being stored — `page_put` / `page_append`, indexed files, facts, timeline entries, hot memory, chronicle entries, `put_raw_data`, `/ingest` and `capture`. `redact` (default) replaces each with `[REDACTED:<kind>:<fingerprint>]` before storage or embedding; `flag` stores it unchanged but still records the finding; `reject` refuses the write. Findings are recorded in the ingest log by kind and a 12-hex SHA-256 fingerprint only, never the value. Allowlisted. | free |
| `MEMRAIN_SECRET_SCAN_ALLOW` | empty | CSV of 12-hex fingerprints (as printed in a redaction marker) to leave in place — for a string that matches a credential pattern but is not one. Allowlisted. | free |
| `MEMRAIN_GITHUB_TOKEN` | unset | Token for `memrain connectors github sync` when `--token-file` is not given. A fine-grained, read-only token for the repositories you mirror is enough. Sent only to `api.github.com`; never stored, logged or put in an MCP payload. Allowlisted. | free |
| `MEMRAIN_CONNECTOR_GAP_HEAL_MINUTES` | `15` | Minutes a connector re-reads behind its watermark on each run, so an item whose update became visible late is not skipped. Allowlisted. | free |
| `MEMRAIN_CONNECTOR_STALL_DAYS` | `7` | `memrain doctor` warns on a connector whose last clean run is older than this many days (it also warns when the last run was `auth_required` or `forbidden`). Allowlisted. | free |
| `MEMRAIN_MIGRATION_LOCK_TIMEOUT` | `10s` | Per-migration advisory-lock timeout (e.g. `10s`, `500ms`, `5min`). Fail-loud on a malformed value. | free |
| `MEMRAIN_LOCK_STEAL_GRACE_SECONDS` | derived: 2 × (TTL in seconds ÷ 6), min `60` s | Grace before a stale cycle-lock holder can be taken over. Auto-derived from TTL when unset. | free |
| `MEMRAIN_EXTRACT_STALE_BATCH` | `50` | Batch size for the stale-links re-extract sweep. | free |
| `MEMRAIN_EXTRACT_TIME_BUDGET_MS` | `1800000` (30m) | Wall-clock budget for one stale-extract invocation. `--catch-up` removes the cap. | free |
| `MEMRAIN_EMBED_CONCURRENCY` | `8` | Max in-flight embed calls in the backfill fan-out pool; a full backfill is ~pool-size faster than serial. | free |
| `MEMRAIN_REEMBED_ON_SIGNATURE_CHANGE` | off (`=1` on) | Re-embed a chunk when the embed signature (model/dim/wrapper) changes, not just when its text changes. Opt-in by design — a bare toggle can trigger a large re-embed. | free (Bedrock embed) |
| `MEMRAIN_FACT_DECAY` | off (`=1` on) | Apply confidence decay to aging facts. | free |
| `MEMRAIN_FACTS_DEDUP` | off (`=1` on) | Insert-time fact dedup/supersede: a cosine-0.95 fast-path collapses near-identical tuples; off means exact-tuple dedup only. | free |
| `MEMRAIN_FACTS_DEDUP_LLM` | off (`=1` on) | Adds a paid classifier step to `MEMRAIN_FACTS_DEDUP` for the ambiguous near-duplicates the cosine fast-path can't decide. Inert unless `MEMRAIN_FACTS_DEDUP` is also on. | **paid (LLM)** |
| `MEMRAIN_FACTS_FENCE` | on (`=0` off) | Fence guard: a dedup supersede never suppresses an operator's fenced fact claim. Kill switch — leave on. | free |
| `MEMRAIN_TYPED_LINKS` | off (`=1` on) | Infer typed relations on links (opt-in; a wrong inferred relation is worse than none). | free |
| `MEMRAIN_LINK_VERB_INFER` | off (`=1` on) | Infer link verbs from surrounding text. | free |
| `MEMRAIN_GAZETTEER` | off (`=1` on) | Gazetteer-based auto-linking of known entities. | free |
| `MEMRAIN_MEETING_TIMELINE` | off (`=1` on) | Extract meeting entries into the timeline during the cycle. | free |
| `MEMRAIN_WIKILINK_CANONICALIZE` | built-in | Canonicalize wikilink slugs to their target pages. | free |
| `MEMRAIN_WIKILINK_TRGM` | built-in | Use trigram similarity to resolve fuzzy wikilink slugs. | free |
| `MEMRAIN_SALIENCE_HIGH_TAGS` | built-in | CSV of tags treated as high-emotion/high-salience in salience recompute. | free |
| `MEMRAIN_CONFIG_PATH` | built-in | Override path to the on-disk config file. | free |
| `MEMRAIN_AUDIT_DIR` | built-in | Directory for the weekly audit file. | free |
| `MEMRAIN_WASM_DIR` | built-in | Override path to the tree-sitter WASM parser directory. | free |
| `MEMRAIN_INGEST_MAX_BYTES` | `1048576` (1 MiB) | Payload cap for `POST /ingest`, counted as the body streams. Allowlisted. | free |
| `MEMRAIN_SECRET_SCAN_HIGH_ENTROPY` | on | Redacts high-entropy values assigned to secret-looking keys (`password=`, `api_key:` …). `0`, `false`, `off` or `no` disables it. Allowlisted. | free |
| `MEMRAIN_SECRET_SCAN_ECHO` | on | Also redacts bare repeats of a value already caught in the same write. `0`, `false`, `off` or `no` disables it. Allowlisted. | free |
| `MEMRAIN_INGEST_TRANSCRIPT_MAX_BYTES` | `8388608` (8 MiB) | Largest session log `POST /ingest` accepts from `memrain transcripts push` (and the CLI reads); a bigger log is refused whole, never truncated. Allowlisted. | free |
| `MEMRAIN_TRANSCRIPT_MAX_FILE_BYTES` | `104857600` (100 MiB) | Largest export `memrain transcripts ingest` accepts; a bigger file is refused whole, never truncated. Allowlisted. | free |
| `MEMRAIN_MAX_FENCES_PER_PAGE` | `100` | Fenced code blocks per markdown page that are chunked as code. | free |
| `MEMRAIN_BODY_TIMELINE` | on (`=0` off) | Turns `## Timeline` bullets, `### YYYY-MM-DD` headers and `[Source: X, YYYY-MM-DD]` citations in a written page into timeline events. Allowlisted. | free |
| `MEMRAIN_TIMELINE_ANCHOR` | off (`=1` on) | Writes one anchor timeline event per dated page, a capped batch per run. | free |
| `MEMRAIN_RECHUNK_SWEEP` | off (`=1` on) | Cycle phase that re-chunks and re-embeds documents written by an older chunker version, a bounded batch per tick. | Titan embeds |
| `MEMRAIN_RECHUNK_SWEEP_MAX` | `25` | Max documents per tick. | — |
| `MEMRAIN_RECHUNK_SWEEP_MAX_CHARS` | `1000000` | Character budget per tick; at least one document always runs. | — |
| `MEMRAIN_DOCTOR_JOB_WEDGE_SEC` | `3600` | Seconds a running job may go without progress before `doctor` calls it wedged. | free |
| `MEMRAIN_HNSW_ZOMBIE_SWEEP` | off (`=1` on) | Drops invalid (half-built) vector indexes at boot. Postgres only, best-effort. `doctor` reports them either way. Allowlisted. | free |
| `MEMRAIN_PG_POOL_MAX` | `10` | Postgres connection pool size. | free |
| `MEMRAIN_PG_STATEMENT_TIMEOUT_MS` | `30000` | `statement_timeout` for the engine's sessions. Migrations use their own. | free |
| `MEMRAIN_MIGRATION_STATEMENT_TIMEOUT` | `30min` | Statement timeout for one migration (`600s`, `30min`, milliseconds). Fail-loud on a malformed value. | free |
| `MEMRAIN_MIGRATE_BACKOFF_MS` | unset (5s/15s/45s) | Replaces the migration retry backoff with one fixed delay. For tests. | free |
| `MEMRAIN_BULK_MAX_RETRIES` | built-in | Retries for a transient database error in bulk work. `0` disables retries. | free |
| `MEMRAIN_NO_DB_CONFIG` | off (`=1` on) | Skips the `memrain config set` overlay: stored `MEMRAIN_*` values are normally applied at boot where the real environment leaves a key unset. | free |
| `MEMRAIN_PGLITE_NO_LOCK` | off (`=1` on) | Skips the lock file that stops two processes opening one PGLite directory. Only for a filesystem that cannot hold it. | free |
| `MEMRAIN_TEST_PGLITE_TEMPLATE` | unset | Test-only. A new PGLite directory starts as a copy of this already-migrated one; `scripts/test-sharded.sh` sets it. Never set it in `.env` or compose. | free |

### Maintenance mode

Four switches control the work `serve` starts on its own at boot. They are
read from the environment only: a `runtime_config` row can never set them, so
a leftover row cannot stop the worker for good or restart work during
maintenance. All four are in the compose allowlist with an empty default.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMRAIN_MAINTENANCE` | off (`=1` on) | Maintenance mode. Forces the three switches below off, whatever they say, and skips the boot sweep of expired OAuth tokens, so a server in maintenance writes nothing by itself. `/health` then carries `"maintenance":true` and `deploy/deploy.sh` does not start the ingress. | free |
| `MEMRAIN_BOOT_CODE_SWEEP` | on (`=0` off) | Registers the code roots and sweeps them at boot. | free |
| `MEMRAIN_JOBS_WORKER` | on (`=0` off) | Starts the jobs worker. Off, a submitted job stays `pending` and nothing claims it. | free |
| `MEMRAIN_CYCLE` | on (`=0` off) | Starts the maintenance cycle loop, whatever `MEMRAIN_DREAM_INTERVAL_S` says. | free |

An empty value counts as unset. Any value other than `0` or `1` fails closed:
it turns maintenance on, or turns a switch off, and the boot log names the
invalid switch. When anything is off, `serve` prints one line such as
`[memrain] maintenance=on code_sweep=off jobs_worker=off cycle=off`.

`memrain status` reports a `quiescence` block: the running state of the
switches, plus counts of running and leased jobs and of live cycle and worker
locks. `memrain status --quiescent` exits 0 only when maintenance is on (or
all three switches are off) and no job, cycle or worker is active; otherwise
it exits 3 and prints what failed.

To prove that nothing changed across a maintenance step, compare two outputs
of `deploy/memrain/scripts/sql/data-manifest.sql`. It is a read-only psql
script that prints one line per table (row count and SHA-256 over every row),
sequence, function, trigger and column list. Run it from the checkout:

```bash
psql "$POSTGRES_URL" -X -A -t -q -v ON_ERROR_STOP=1 \
  -f deploy/memrain/scripts/sql/data-manifest.sql > before.txt
# ... the step ...
psql "$POSTGRES_URL" -X -A -t -q -v ON_ERROR_STOP=1 \
  -f deploy/memrain/scripts/sql/data-manifest.sql > after.txt
diff before.txt after.txt   # exit 0: identical
```

Every line counts; explain any difference from the diff lines themselves.
psql cannot open a PGLite data directory: for a PGLite install, keep a copy
of the stopped data directory instead.

---

## 7. Terraform infrastructure variables

Set in `terraform/terraform.tfvars` (generated by `scripts/init.sh`). Full
schema in `terraform/variables.tf`.

| Variable | Default | Description |
|---|---|---|
| `aws_region` | `eu-west-1` | AWS region for the stack. |
| `aws_profile` | `default` | AWS CLI profile (matches `~/.aws/config`). |
| `tfstate_region` | `eu-central-1` | Region of the S3 bucket holding terraform state (often differs from `aws_region`). |
| `domain` | `""` | Public root domain (e.g. `example.com`). Used by the Cloudflare Tunnel and OAuth flows. |
| `subdomain` | `brain` | Subdomain serving the public MCP (e.g. `brain` → `brain.example.com`). |
| `memex_subdomain` | `null` | DEPRECATED alias of `subdomain`; when set it still wins, and a `check` warns. Removed in 1.1.0. |
| `github_owner` | `""` | GitHub username/org owning the public repo. |
| `repo_name` | `memrain` | Public repo name; used for tags, S3 keys, tfstate prefix. |
| `secrets_prefix` | `memrain` | Secrets Manager namespace — every secret is `<secrets_prefix>/<name>`. |
| `use_ssh_deploy_key` | `false` | Only true while migrating from a private SSH-clone flow. Public installs leave false (HTTPS clone). |
| `ssh_public_key` | `""` | Public key to register as the EC2 key pair. Empty skips key-pair creation (SSM replaces SSH). |
| `project_name` | `memrain` | Prefix for AWS resource names + on-host paths (`/opt/<project>`, `/mnt/<project>-efs`). Changing it on an existing stack renames about 20 ForceNew resources: pin every name first (UPGRADING step 0). |
| `app_slug` | `memrain` | Application slug in the RDS names (`<project_name>-<app_slug>`): instance identifier, subnet group, parameter group. |
| `db_name` | `memrain` | Postgres database created with the RDS instance. Ignored once the instance exists (ForceNew); rename an existing database in SQL. |
| `db_username` | `memrain` | RDS master user. Ignored once the instance exists (AWS cannot rename it). |
| `rds_apply_immediately` | `false` | Apply RDS modifications now instead of in the next maintenance window. Set true only for the apply that needs it. |
| `efs_creation_token` | `null` → `<project_name>-data` | EFS creation token. Immutable on an existing file system: pin the current value. |
| `secrets_read_prefixes` | `[]` → `[secrets_prefix]` | Secret prefixes the instance role may read. List a second one while secrets move between prefixes. |
| `instance_type` | `t4g.medium` | EC2 instance type (Graviton ARM64). Must be ARM64-compatible unless you also change the AMI filter. |
| `ebs_volume_size` | `20` | Root EBS volume size (GB). |
| `vpc_cidr` | `10.0.0.0/16` | VPC CIDR block. |
| `public_subnet_cidr` | `10.0.1.0/24` | Public subnet CIDR for the primary AZ. |
| `availability_zone` | `eu-west-1b` | AZ for the primary subnet. |
| `multi_az_subnet_cidrs` | `{eu-west-1a=10.0.2.0/24, eu-west-1c=10.0.3.0/24}` | Extra subnets to satisfy the RDS multi-AZ subnet group. |
| `bedrock_allowed_regions` | EU family + `us-east-1` | Regions where the instance role may invoke the expensive Claude models; an IAM Deny blocks `anthropic.claude-*` elsewhere. |
| `bedrock_model_id` | `eu.anthropic.claude-haiku-4-5-20251001` | Bedrock CRIS inference-profile id for the primary model, validated against an allowed list. The **runtime** utility tier is the built-in Claude Haiku default (overridable per feature with the `MEMRAIN_<FEATURE>_MODEL` keys, or with `MEMRAIN_UTILITY_MODEL`); this terraform var is informational: it feeds only the `bedrock_model` output, and IAM does not reference it. |
| `alarm_email` | `""` | Email for the EC2 status-check CloudWatch alarm. Empty skips email (alarm still fires). |
| `ssh_allowed_cidr` | `""` | CIDR allowed inbound SSH. Empty disables SSH — use SSM Session Manager. |
| `enable_vpc_endpoints` | `false` | Enable interface VPC endpoints (Bedrock, SM, SSM, Logs). ~$43/mo — off for personal use. |
| `enable_cloudtrail` | `true` | Enable CloudTrail API auditing (logs in S3, 90-day retention). |
| `repo_url` | `""` | Git URL the EC2 clones at first boot. HTTPS for public repos; SSH form needs `use_ssh_deploy_key = true`. |
| `ingress_mode` | `cloudflare` | How the public MCP endpoint is reached: `cloudflare` (Cloudflare Tunnel sidecar, no inbound ports) or `caddy` (Caddy terminates TLS on the instance, opens inbound 80/443). |
| `caddy_manage_dns` | `true` | `caddy` ingress only: create the `<subdomain>.<domain>` A record in the domain's Route53 hosted zone. Set false when DNS lives elsewhere and create the record to the instance EIP yourself. |
| `efs_backup` | `true` | AWS Backup's daily EFS backups (35-day retention). Set false only if another backup covers the mount. |

> The `bedrock_model_id` var does not change what runs:
> the **retrieval brain calls only Anthropic models via Bedrock at runtime** —
> Claude Haiku for the utility tier (built-in default, overridden by
> `MEMRAIN_UTILITY_MODEL`) and Claude Sonnet for the paid slices
> (`MEMRAIN_FACTS_MODEL`). Amazon Nova was removed from the request path.

### Resource name variables

Every AWS resource name resolves through a variable that defaults to `null`,
which derives the name as shown (`<p>` is `project_name`, `<acct>` the AWS
account id). A new install leaves them unset. An install created before the
rename pins each one to its current value (UPGRADING step 0): most of these
names are ForceNew, and the data-bearing resources carry `prevent_destroy`.

| Variable | Derived default |
|---|---|
| `rds_identifier` | `<p>-<app_slug>` |
| `db_subnet_group_name` | `<p>-<app_slug>` |
| `db_parameter_group_name` | `<p>-<app_slug>-pg16` |
| `ec2_sg_name` | `<p>-sg` |
| `rds_sg_name` | `<p>-rds` |
| `efs_sg_name` | `<p>-efs-sg` |
| `vpc_endpoints_sg_name` | `<p>-vpc-endpoints-sg` |
| `iam_role_name` | `<p>-role` |
| `instance_profile_name` | `<p>-instance-profile` |
| `custom_policy_name` | `<p>-custom-policy` |
| `efs_client_policy_name` | `<p>-efs-client` |
| `log_group_name` | `/<p>/app` |
| `sns_topic_name` | `<p>-alarms` |
| `scripts_bucket_name` | `<p>-scripts-<acct>` |
| `cloudtrail_bucket_name` | `<p>-cloudtrail-<acct>` |
| `cloudtrail_name` | `<p>-trail` |
| `key_pair_name` | `<p>-key` |
| `postgres_url_secret_name` | `<secrets_prefix>/memrain-postgres-url` |
| `public_bearer_secret_name` | `<secrets_prefix>/memrain-public-bearer` |
| `internal_token_secret_name` | `<secrets_prefix>/memrain-internal-token` |
| `tunnel_token_secret_name` | `<secrets_prefix>/cloudflared-tunnel-token` |
| `deploy_key_secret_name` | `<secrets_prefix>/github-deploy-key` |

---

## Legacy names

Installs from before the rename to Memrain keep working in 1.0.x without
changes. The old names below are read as a fallback. **All of them are removed
in 1.1.0, which refuses to start while a legacy name is still in use**, so
move to the new names (UPGRADING.md) before taking 1.1.0. Data written by
older versions stays readable for good: fence markers, token and client ids
and stored values need no migration.

**Environment variables.** Every `MEMEX_X` variable is read as `MEMRAIN_X`.
The new name wins: a legacy value applies only when `MEMRAIN_X` is unset or
empty, and when both are set to different values `MEMRAIN_X` is used and
`serve` names the key at boot (never the value). An empty legacy value counts
only when `MEMRAIN_X` is not set at all. Compose resolves the host `.env` the
same way (`${MEMRAIN_X:-${MEMEX_X:-default}}`), so a legacy `.env` still
works, and `memrain doctor` warns while a legacy name is in use.

**Stored settings (`memrain config set`).** The `runtime_config` table is
read under both prefixes, and the overlay applies a key only where the
environment leaves it unset. For a knob `X`, highest first:

1. the environment variable `MEMRAIN_X`, even when empty;
2. the environment variable `MEMEX_X`;
3. a stored `MEMRAIN_X` row;
4. a stored `MEMEX_X` row, only when no `MEMRAIN_X` row exists;
5. the built-in default.

`memrain config set` stores `MEMRAIN_X` even when given `MEMEX_X`, and
leaves an older `MEMEX_X` row in place, where the new row shadows it.
`memrain config unset` under either spelling removes both names, and so does
`config unset --pattern` with a `MEMRAIN_` or `MEMEX_` prefix, so a shadowed
row cannot come back. `MEMEX_NO_DB_CONFIG=1` still switches the overlay off
like `MEMRAIN_NO_DB_CONFIG=1`. `memrain doctor` warns about each stored
`MEMEX_X` row that has no `MEMRAIN_X` row (re-set it with `memrain config set`
before 1.1.0) and lists shadowed rows as information only.

**Other names.**

| Legacy | New |
|---|---|
| `~/.memex/config.json`, `memex.yml` | `~/.memrain/config.json`, `memrain.yml` (the new one wins; `init` refuses while an unmoved `~/.memex` holds data) |
| `x-memex-*` ingest headers | `x-memrain-*` (both families at once with different values → 400) |
| `<prefix>/memex-*` secrets | `<prefix>/memrain-*`, tried first; an unset `SECRETS_PREFIX` means `memex` |
| the `memex` command | `memrain` |
| the `memex` compose network alias | the `memrain` service name |
| `STACK_MEMEX_SUBDOMAIN`, terraform `memex_subdomain` | `STACK_SUBDOMAIN`, `subdomain` |
