# Configuration reference

This page lists every setting you can change, what each one does, and which
ones cost money. You need it when you want to turn a feature on or off or tune
how Memrain behaves. The defaults work, so you do not need this page to get
started: begin with [QUICKSTART.md](./QUICKSTART.md), and read
[HOW-IT-WORKS.md](./HOW-IT-WORKS.md) to see what the settings control.

Most runtime knobs are environment variables prefixed `MEMRAIN_`; deploy-level
keys (secret names, `COMPOSE_FILE`) and Terraform variables are listed in their
own sections below.
An install from before the rename keeps working with its old names in 0.1.x;
see [Legacy names](#legacy-names).
This page is the authoritative list: each row gives the variable, its default,
what it does, and whether it costs money.

## How configuration flows

For host environment settings, there are two gates between a value you type and the running process:

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

## Stored runtime settings

`memrain config set <key> <value>` stores an override in `runtime_config`.
Known keys are typed as flags, integers, or strings. Flags accept `true/false`,
`on/off`, `yes/no`, and `1/0`, and are stored as `1/0`. Integers must be safe
whole numbers; string settings keep their existing domain-specific parsing.
Unknown keys and invalid typed values exit 2; misspelled keys suggest the
nearest known name. `--force` permits a custom key, but does not bypass type
validation for a known key.

Actual process environment values always override stored rows. The command
warns when it sees such an override; a running server loads stored changes on
restart. Environment-only switches remain environment-only, even if a row is
stored. `memrain config show` redacts values; `memrain doctor` reports unknown,
invalid, and noncanonical stored rows without rewriting them. Use `config unset`
to remove an override instead of assigning an empty flag value.

## How to enable a flag

```bash
# 1. On the live host, add the flag to /opt/memrain/.env
echo 'MEMRAIN_HNSW_ZOMBIE_SWEEP=1' >> /opt/memrain/.env

# 2. Confirm the key is in the compose allowlist (environment: block).
#    If it is "code-only" below, add a line to deploy/docker-compose.yml:
#      - MEMRAIN_MYFLAG=${MEMRAIN_MYFLAG:-}
#    and commit/deploy that change first.
grep MEMRAIN_HNSW_ZOMBIE_SWEEP deploy/docker-compose.yml

# 3. Rebuild and restart memrain so it picks up the new env.
bash deploy/deploy.sh
#    Other services: docker compose --env-file .env up -d --build <service>
#    (never add -f: it overrides COMPOSE_FILE in .env and drops the ingress overlay)

# 4. Verify the process actually sees it, and the brain is healthy.
docker exec deploy-memrain-1 sh -c 'echo "$MEMRAIN_HNSW_ZOMBIE_SWEEP"'
docker exec deploy-memrain-1 wget -qO- http://127.0.0.1:18790/health   # -> {"ok":true,...}
```

A boolean flag is "on" only for the exact value the code checks (usually `=1`).
Numeric knobs fail **loud** on a malformed value — a typo aborts the process at
boot rather than silently falling back, so a bad edit is caught immediately.

---

## What costs money

The only paid call Memrain makes is a Bedrock Titan text embedding: one per
chunk written, and one per search query. No other model is called. With
`MEMRAIN_KEYWORD_ONLY=1` nothing is embedded and nothing is paid for.

Two kinds of daily cap bound that spend, both in USD per UTC day:

- `MEMRAIN_DAILY_BUDGET_USD` caps the whole brain (every client, the hourly
  housekeeping and the CLI together).
- `memrain auth set-budget <client_id|token_name|enrollment_id> <usd>` caps
  one OAuth client, personal access token or enrollment (`none` removes it).

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
| `MEMRAIN_KEYWORD_ONLY` | off (`=1` on) | Runs the brain without AWS: nothing is embedded, no model is invoked, and search is keyword-only. Every paid call is refused before it is sent with error `unsupported`, so semantic search is unavailable. `/health` reports `keyword_only: true`. The local Docker quickstart turns it on. Chunks written in this mode have no vectors (an unchanged chunk keeps the one it had); after turning it off, `memrain embed` adds them. | free |
| `MEMRAIN_REQUIRE_POSTGRES` | off (`=1` on) | For a host that must run on Postgres. With it on, a PGLite `config.json` or a missing Postgres URL stops the server and the container entrypoint instead of starting an empty local brain, `init --pglite` refuses, and `fetch-secrets.sh` fails when the URL secret is missing. `bootstrap.sh` writes it on new installs. Env-only: a `runtime_config` row cannot set it. | free |
| `MEMRAIN_VAULT_PATHS` | `/memory` (compose) | CSV of directory roots the path guard treats as in-bounds for the `index` tool. Mounted read-only into the container. With this and `MEMRAIN_CODE_PATHS` both unset, every index request is refused. | free |
| `MEMRAIN_CODE_PATHS` | `/repo-source` (compose) | More roots the same path guard accepts. Lite has no code index; these roots only widen where `index` may read. | free |
| `MEMRAIN_VAULT_PATH` | unset | Single vault path for `reindex` when no `--vault` flag is given, and for `doctor`'s vault check. It takes precedence over `storage.vault` in the config file. Code-only; the server sweeps `MEMRAIN_VAULT_PATHS`. | free |
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
| `<prefix>/memrain-connector-kek` (optional) | `MEMRAIN_CONNECTOR_KEK` in `.secrets/memrain.env` |
| `<prefix>/memrain-notify-webhook` (optional) | `MEMRAIN_NOTIFY_WEBHOOK_SECRET` in `.secrets/memrain.env` |

The two optional secrets have no legacy name to fall back to. Missing, or
created without a value yet, means no line is written and the run succeeds.
The connector key seals the secret store (see `MEMRAIN_CONNECTOR_KEK`); Lite
sends no notifications, so the webhook secret is only kept out of
`runtime_config`.

A stack whose secrets carry other names sets any of six optional `.env` keys
to the full secret id: `POSTGRES_URL_SECRET_NAME`, `PUBLIC_BEARER_SECRET_NAME`,
`INTERNAL_TOKEN_SECRET_NAME`, `TUNNEL_TOKEN_SECRET_NAME`,
`CONNECTOR_KEK_SECRET_NAME` and `NOTIFY_WEBHOOK_SECRET_NAME`. A non-empty value
is used exactly as written: no prefix is added and no other name is tried.
Unset or empty means the default name above. A value outside the Secrets
Manager name alphabet stops the script before any AWS call. The bearer
rotation script and `scripts/mcp-refresh.sh` read `PUBLIC_BEARER_SECRET_NAME`
too. These keys are not part of the rename and stay in 0.2.0.
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
| `MEMRAIN_NEARDUP_JACCARD` | `0.85` | Jaccard threshold for near-duplicate collapse in results. A value `> 1.0` disables dedup. | free |
| `MEMRAIN_CURATION_BOOST` | built-in map | Per-prefix score multipliers (`prefix:factor`, CSV). Set replaces the default map entirely. | free |
| `MEMRAIN_SEARCH_EXCLUDE` | empty | CSV of path prefixes to exclude from search results (e.g. `.raw/`). | free |
| `MEMRAIN_QUERY_EMBED_TIMEOUT_MS` | `6000` | Wall-clock budget for the query-embed Bedrock call; on timeout search falls back to keyword-only (non-fatal). Floor 2000ms. | free |
| `MEMRAIN_EMBED_DIM` | `1024` | Embedding vector width. Must match the `vector(...)` column width — changing it requires a schema migration + full re-embed. Fail-loud on a non-positive-integer value. | free |
| `MEMRAIN_CHUNK_OVERLAP` | `300` (on) | Characters of tail-of-previous-chunk to prepend to each chunk. `0` turns overlap off; an unparseable value falls back to the default. Applies to newly indexed pages; stored chunks keep their overlap until re-indexed. Capped at half the previous chunk. | free |
| `MEMRAIN_TRACK_RETRIEVAL` | on (`=0` off) | Write-back `last_retrieved` timestamps on hit. | free |
| `MEMRAIN_MAX_TYPE_RATIO` | `0.6` | Largest share of the candidate set one page type may hold. `>= 1` disables the cap. Fail-loud on a malformed value. | free |
| `MEMRAIN_SEARCH_SNIPPET_CHARS` | `0` (off) | When `> 0`, the `search` MCP tool cuts each hit's `content` to this many characters at a word boundary and mark it `truncated: true`; a page hit also gets a `full` pointer containing `page_get` with JSON arguments `slug` and `source_id`. `0`, unset or malformed returns hits uncut. Allowlisted. | free |
| `MEMRAIN_RERANK_TIMEOUT_MS` | — | Not read. Lite has no rerank; the name appears only in a code comment. | free |
| `MEMRAIN_ORPHAN_EXCLUDE_WRITERS` | built-in list | Replaces the list of `written_by` values a remote caller may not stamp on a page write; such a value is replaced with the caller's own identity. Lite has no orphan report, so this is all the list does. Presence decides: set to empty, no value is replaced. CSV. | free |
| `MEMRAIN_ORPHAN_EXCLUDE_EXTRA` | empty | Adds `written_by` values to that list. CSV. | free |
| `MEMRAIN_RANK_PAGE_FUSION` | — | Not read. Search does not switch on it; the name appears only in a code comment. | free |

---

## 3. Spend and Bedrock calls

The only model Memrain calls is Bedrock Titan text embeddings. These knobs cap
that spend and bound the calls. A few names below come from pre-Lite releases, which also
called chat models; their rows say what Lite does with them.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMRAIN_DAILY_BUDGET_USD` | off | Brain-wide daily USD cap over every paid call (all clients, the housekeeping embeds and the CLI) in a UTC day, holds included. Blank, malformed or negative is off; `0` refuses everything. Refusals carry reason `daily_cap`. Suggested `1.00`. Allowlisted. | — |
| `MEMRAIN_CYCLE_MAX_USD_PER_DAY` | off | Daily USD cap over calls made under a pre-Lite cycle phase. Lite tags no call with a phase, so the spend it sums is only what a pre-Lite cycle booked today; every paid call is still checked against it, and `0` refuses them all. Same parsing as `MEMRAIN_DAILY_BUDGET_USD`, which is the cap to use. Code-only. | — |
| `MEMRAIN_CHAT_RETENTION_DAYS` | `90` (`0` = keep forever) | Lite has no chat. The housekeeping retention step deletes chat messages a pre-Lite brain kept once they are older than this, and the threads they leave empty. `memrain erase chat --owner KEY` counts one owner's threads and messages; add `--apply` to delete them. Allowlisted. | free |
| `MEMRAIN_EMBED_MAX_INFLIGHT` | `4` | How many chunks an interactive write (`page_put`, `page_append`, `page_revert`, `page_restore`) embeds at once, shared by every concurrent write in the process. `1` embeds one chunk at a time. Not the backfill's pool width (`MEMRAIN_EMBED_CONCURRENCY`), and not applied to query embeds. | — |
| `MEMRAIN_EMBED_TIMEOUT_MS` | `10000` | Timeout for Titan embedding calls. | — |
| `MEMRAIN_LLM_TIMEOUT_MS` | unset | Fallback for `MEMRAIN_EMBED_TIMEOUT_MS` when that is unset. A timeout ends the request. | — |
| `MEMRAIN_LLM_UTILITY_TIMEOUT_MS` | — | Not used: Lite makes no chat-model call. A helper still parses it, but nothing calls the helper. | — |
| `MEMRAIN_LLM_REASONING_TIMEOUT_MS` | — | Not used, as `MEMRAIN_LLM_UTILITY_TIMEOUT_MS`. | — |
| `MEMRAIN_LLM_MAX_INFLIGHT` | — | Not used, as `MEMRAIN_LLM_UTILITY_TIMEOUT_MS`. | — |
| `MEMRAIN_UTILITY_MODEL` | — | Not read. Lite calls no chat model; the name appears only in the hint printed when a Bedrock call fails because its model id does not resolve. | — |
| `MEMRAIN_FACTS_MODEL` | — | Not read, as `MEMRAIN_UTILITY_MODEL`. | — |
| `MEMRAIN_DEEP_MODEL` | — | Not read, as `MEMRAIN_UTILITY_MODEL`. | — |

---

## 4. Auth & source scoping

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMRAIN_TENANT_FAIL_CLOSED` | off (`=1` on) | When on, an authenticated PUBLIC principal with no source grant reads/writes **nothing** instead of the redacted whole brain. The static bearer (no `authInfo`) is unaffected. Flip once a real remote OAuth client with a grant exists. | free |
| `MEMRAIN_OPERATOR` | unset (falls back to `USER`, then `cli`) | Name recorded as the actor on grant changes made with `memrain auth rescope-client`. Audit data only; it grants nothing. A self-chosen label, not an authenticated identity. | free |
| `MEMRAIN_PUBLIC_WRITE` | `0` | When `1`, the public `/mcp` path may call the constructive write tools (`index`, `page_put`, `page_append`, `page_edit`, `add_tag`, `link`). Destructive ops + privacy-sensitive reads stay internal-only regardless. The static bearer is permanent, so anyone holding it can then write; prefer scoped PATs or OAuth clients for writers. | free |
| `MEMRAIN_ASSUME_PUBLIC` | off (`=1` on) | Treat every HTTP request as public ingress. Public detection otherwise keys on the `Cf-Connecting-Ip` header a Cloudflare Tunnel injects; behind another proxy that does not add it, set this (or inject the header) or remote callers are judged as internal peers. Allowlisted. | free |
| `MEMRAIN_HTTP_CORS_ORIGIN` | unset (no cross-origin) | CSV of browser origins allowed to call Memrain cross-origin. Unset denies every cross-origin request. Allowlisted. | free |
| `MEMRAIN_MCP_RATE_LIMIT_PER_TOKEN_PER_MINUTE` | unset (off) | Per-credential cap on `/mcp` requests per minute, applied after authentication, on top of the per-IP limiter. Allowlisted. | free |
| `MEMRAIN_PUBLIC_AUTH` | unset | `oauth`: public requests have no static bearer; a missing or unknown credential gets 401 with the resource-metadata challenge, and OAuth tokens and personal access tokens are verified as usual. Refuses to start with `MEMRAIN_PUBLIC_BEARER` also set; any other value is refused. Environment only. | free |
| `MEMRAIN_REQUIRE_MEMBER` | off (`=1` on) | Refuse a credential on `/mcp` that is not bound to a member (`member_required`). A credential bound to anyone but the enabled owner (config `access.owner_member`) is refused anyway, so with it on only owner-bound credentials work, and with no owner named none do. `memrain auth create <name> --member <owner-id>` binds a personal access token to the owner. Environment only. | free |
| `MEMRAIN_TENANT_ID` | unset | Meant for a wrapped, multi-tenant deployment this build does not support. Set to anything non-blank, every entry point refuses to start. Environment only. | free |
| `MEMRAIN_CONTROL_URL` | unset | As `MEMRAIN_TENANT_ID`: set to anything non-blank, every entry point refuses to start. Environment only; `memrain config set` refuses to store it. | free |
| `MEMRAIN_PUBLIC_READ_BODIES` | off (redacted) | When on, public reads return full page bodies instead of redacted snippets. Leave off on a shared brain. Code-only. | free |
| `MEMRAIN_HTTP_TRUST_PROXY` | off (`=1` on) | Let every header-keyed rate limiter fall back to `X-Forwarded-For` (first hop) then `X-Real-IP` when `Cf-Connecting-Ip` is absent. Both are attacker-controlled unless a trusted reverse proxy overwrites them, and a spoofable key is worse than none — the caller rotates values and mints a fresh bucket per request. Off, an unattributable caller is not metered per-IP at all. Turn on ONLY behind a proxy that terminates the client connection and rewrites those headers itself. On, the admin same-origin check also takes the browser's scheme from `X-Forwarded-Proto` for a host `MEMRAIN_PUBLIC_URL` does not name, so the proxy must send the right value or leave it out. | free |
| `MEMRAIN_ADMIN_BOOTSTRAP` | unset | Admin-panel bootstrap token consumed by `serve.ts` at start. Must be 32+ chars from `[A-Za-z0-9_-]` or the server refuses to boot; unset ⇒ an ephemeral per-run token is printed to stderr. | free |
| `MEMRAIN_ENABLE_DCR` | off (`=1` on) | Dynamic Client Registration. Default OFF: `POST /register` returns 404 and discovery omits `registration_endpoint`, so no one can self-register a client — an operator creates clients via `memrain auth register-client`. When on, a self-registered client gets the `authorization_code` grant (`client_credentials` is refused). **That grant only carries operator consent when `/authorize` is gated on a logged-in operator, so the server refuses to boot with DCR on unless `MEMRAIN_OAUTH_REQUIRE_LOGIN=1` (with `MEMRAIN_ADMIN_BOOTSTRAP`) or the explicit `MEMRAIN_ENABLE_DCR_INSECURE=1` is also set.** Turn on only if a client must self-register. | free |
| `MEMRAIN_ENABLE_DCR_INSECURE` | off (`=1` on) | Also let self-registered clients request the `client_credentials` grant, which mints a token WITHOUT the `/authorize` consent step. Implies `MEMRAIN_ENABLE_DCR`, and acknowledges that an unauthenticated caller can obtain a default-tenant token with no operator in the loop (satisfies the DCR boot check without `MEMRAIN_OAUTH_REQUIRE_LOGIN`). Leave off unless a trusted machine-to-machine client must self-register — prefer `memrain auth register-client` instead. | free |
| `MEMRAIN_OAUTH_REQUIRE_LOGIN` | on (`=0` off) | Owner approval for every new agent sign-in: `GET /authorize` issues a code only to a signed-in operator who approved that exact request in the dashboard. `=0` auto-approves (and then refuses public client-mode clients). Tokens already issued keep working either way. Without `MEMRAIN_ADMIN_BOOTSTRAP` the admin token changes on every restart. | free |
| `MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE` | off (`=1` on) | What happens when a client presents a refresh token it already rotated more than 60 seconds ago. Off (default): the request is refused with `invalid_grant` and logged as `[oauth] refresh token reuse`, and the session keeps working. On: every live access and refresh token of that sign-in is also deleted, so both holders must sign in again. Turn on once the logs show no legitimate client replays late. | free |
| `MEMRAIN_PUBLIC_URL` | unset (request host) | External base URL (Cloudflare tunnel origin). When set, the OAuth discovery document + issuer advertise this `https://…` origin so a cloud MCP client auto-configures against the real host. Set it behind any TLS-terminating proxy: unset, the issuer comes from the request (`http://…` there), and the RFC 8707 `resource` check at `/authorize` and `/token` refuses a client's `https://` connector URL with `invalid_target`. `serve` warns at boot when OAuth is on and it is unset. Passkey sign-in for the admin panel needs it too: the passkey is bound to its hostname, and without an `https://` value the panel offers the bootstrap login only. | free |
| `MEMRAIN_REQUEST_LOG_DB` | off (`=1` on) | Also write calls without a credential (the shared bearer, internal callers) to `mcp_request_log`. Calls with an OAuth or personal access token and admin-panel tool calls are written whatever this says. Code-only. | free |
| `MEMRAIN_REQUEST_LOG_RETENTION_DAYS` | 180 (`0` = keep forever; 7 to 36500) | Days of rows kept in `mcp_request_log`. The hourly housekeeping deletes older rows in batches of 5000, at most 500,000 per run. Under 180 the Overview comparison periods thin out; under 90 the 90-day chart and the idle-client check in `doctor` lose data. 1 to 6 are raised to 7 and anything above 36500 is lowered to it; any other value that is not a whole number falls back to 180 with a warning. | free |
| `MEMRAIN_LOG_REQUESTS` | off | Emit redacted per-request MCP param logs to stderr. Nothing is logged unless set. Code-only. | free |
| `MEMRAIN_DEPLOYMENT_IDENTITY` | unset | One line on what this brain is (for example "Personal notes on infrastructure work"). Appended to the MCP `initialize` instructions as a `Deployment:` paragraph after Memrain's built-in operating contract. Trimmed and capped at 2000 characters. Served to **every** caller, public ingress included: public-facing prose only, never a secret. | free |
| `MEMRAIN_MCP_INSTRUCTIONS` | unset | Extra operator guidance appended after the deployment identity in the `initialize` instructions (for example where meeting notes belong). Trimmed and capped at 2000 characters. Served to every caller, public ingress included, so it must not hold secrets. | free |
| `MEMRAIN_MCP_LENIENT_ARGS` | off | MCP calls that pass an argument the tool does not declare are refused with `invalid_params` and a did-you-mean hint. `=1` accepts and ignores unknown arguments again: a temporary escape for an old client, since a misspelled key is then dropped without an error. | free |
| `MEMRAIN_MCP_FORCE_SURFACE` | unset (off) | Incident switch: `starter` or `verbs` narrows `tools/list` and `tools/call` for every `/mcp` connection, the operator and public bearers included, to that surface (see `memrain auth` tool surfaces). It only narrows: a credential already on a narrower surface keeps it, and `full`, unset or an unknown value (warned once) change nothing. The local CLI and the admin panel are not affected. Environment only: a `memrain config` row is ignored. Read on every request, but the container sees `.env` only when it starts: set it in `/opt/memrain/.env` and run `bash deploy/deploy.sh` (or recreate the memrain container); to lift it, remove the line and do the same. | free |
| `MEMRAIN_MCP_MAX_RESULT_BYTES` | `4194304` (4 MiB) | Maximum serialized UTF-8 tool-result bytes for `page_list`, `page_versions`, `get_chunks` and `search_exact`, measured after redaction, including JSON escaping and metadata. Oversized results return `result_too_large` with pagination/projection advice; stored content is unchanged. Positive safe integer; empty or invalid values use the default. Existing errors and the refusal envelope are exempt. Runtime config takes effect on restart. | free |

### Source scope contract

Every read path takes the caller's source scope as `sourceIds`, and its four
shapes mean different things:

| `sourceIds` | Who | Reads |
|---|---|---|
| `undefined` | the local CLI, the internal token, the operator | the whole brain — no predicate at all (unqualified searches narrow to federated sources first, see below) |
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
  rows before embedding the query, so an empty grant costs nothing.
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
  did not move. It seeds a fixed two-tenant brain, runs its read tools UNSCOPED
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

### Federated sources

Every source carries a `federated` flag (migration 195). A `search` or
`page_list` call that names no source, from a caller whose grant names none
(the operator, the CLI, a key with `read_sources` null), reads the `default`
source plus the federated sources only. A source that is not federated is
reached only by an explicit `source_ids` on `search` or `page_list`, or by a
token or client grant that lists it (grants are never changed by the flag).

A source registered with `--kind code` starts unfederated; every other kind
starts federated. Re-registering a source keeps its flag. Change it on the
brain host:

```bash
memrain sources unfederate notes-archive   # only grants and source_ids reach it
memrain sources federate notes-archive     # unscoped reads reach it again
memrain sources list                       # each row shows "federated"
```

When every source is federated, an unscoped read keeps the `undefined` scope
and its SQL is unchanged. Otherwise the scope becomes the list of federated
sources, and like every source list it leaves out documents no source owns
(`source_id` NULL).

Hybrid search honours the contract end to end: an empty grant returns before
the query is embedded, and both hydration passes are scoped. The final hydration pass also applies the
visibility filter, so a soft-deleted, archived or quarantined page does not
surface.

The same split governs writes. A page's derived rows (links and mentions)
carry the **page's** source, not the caller's, so an unscoped operator write
cannot re-home a source's projections into `default`. `page_put` does this;
the `page_append`, `page_revert` and `page_restore` paths still carry the
caller's source.

### Scoped clients

A source owns writes, and a client's read set is a union of sources. A client
can be held to part of the brain: its own source to write into, and only the
sources it lists to read. Nothing below is on by default.

```bash
# 1. A source for what this client may write.
memrain sources register laptop --kind other --path-prefix laptop

# 2. One OAuth client for it. --source is the WRITE authority;
#    --federated-read is the read union (list only what this client may see).
memrain auth register-client work-laptop \
  --scopes 'read write' --source laptop --federated-read laptop

# 3. Optional daily ceiling, in USD, over this client's paid calls.
memrain auth set-budget <client_id|token_name|enrollment_id> 2.00 # 'none' removes it
```

A cap can sit on an OAuth client, a personal access token (by name) or an
enrollment.

Print the client's own view any time with the `whoami` tool: it returns the
`write_source` and the `read_sources` the token actually carries.

What a scoped client can reach, and what it cannot:

| Surface | Scoped client sees |
|---|---|
| `search`, `search_exact`, `page_get`, `page_list` | its own read set only |
| `add_tag` on another tenant's slug | the same "not found" as a slug nobody holds — no existence oracle |
| an enrollment code | single-use, expiring; binds the grant to one source |
| `index` / `page_put` onto another tenant's path | refused (`permission_denied`) |
| `get_brain_identity` counters | its own read set; `sources` is the size of that set |
| `run_doctor`, `stats` (whole brain) | refused — operator-only |
| `sources_list` | only the sources its grant covers |
| `purge_deleted_pages` | needs the `admin` scope, recorded deliberately |

A deleted page stays restorable for 30 days (720 hours) before the hourly
housekeeping purges it for good, with its versions, aliases, links, `tags`
and the redirects that pointed at it. Indexed
documents, which can be re-read from their files, keep a 72-hour window.
`purge_deleted_pages` without `older_than_hours` uses the same 720 hours and
reports the cutoff it applied as `ttl_hours`; pass `older_than_hours` to purge
sooner, for example after a leaked secret.

A brain upgraded from a pre-Lite release may still hold facts and synthesis rows derived from
a page. The purge removes those with the page: it retires the page's facts
(reported as `facts_retired`; each page that retired facts leaves a row in
`fact_purge_receipts`)
and deletes what synthesis derived from it (reported as `synthesis`). A dry
run reports how many would go.

`purge_deleted_pages` with named `slugs` is the owner's purge of those pages:
it also records the content hash of each page and of every version it kept in
`page_purges` (reported as `tombstoned`). A write of that content under any
slug of the same source is then refused (`invalid_params`), so a re-import
or a restored snapshot cannot bring the text back. The TTL purge leaves no
tombstone. `memrain unpurge <slug> [--source ID]` clears a page's tombstones.

`reindex --reconcile-deletes` soft-deletes documents whose file is gone. It
refuses when the vault root is missing or not a directory, and when more than
50 documents, or more than a quarter of the live documents under the root
(and more than one), would go; pass
`--allow-mass-delete` after checking the count and the sample paths in the refusal.

### OAuth clients

**`MEMRAIN_OAUTH_REQUIRE_LOGIN`** (on by default) makes `GET /authorize`
bounce an unauthenticated browser to `/admin/login`, and that page accepts
exactly one credential, the operator bootstrap token (a magic link minted by
whoever holds it grants a 7-day ADMIN session). It does not apply to an
enrollment-mode client (`--tenant-mode enrollment`), where a one-time code from
`memrain auth enroll` is the authentication and binds the grant to a source;
`memrain auth enrollments`, `revoke-enrollment` and `revoke-grant` manage
those codes and grants.

With the flag off, `/authorize` is still not a free-for-all:

- a code is only ever sent to a **registered** `redirect_uri` on that client;
- exchanging the code for a token requires the **client secret**, so a caller
  who knows only the `client_id` gets nothing;
- a public client (no secret) in `client` mode is refused with
  `unauthorized_client` while `/authorize` auto-approves;
- Dynamic Client Registration stays off, so nobody can mint a client.

Register the callback your account actually uses. `claude.ai` and
`claude.com` are different origins to the allow-list; a connector on the origin
you did not register fails with `redirect_uri is not registered for this
client`. Replace a client's list without rotating its secret:

```bash
memrain auth set-redirect-uris <client_id> \
  https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback
memrain auth rescope-client <client_id> --source laptop --federated-read laptop
```

Every rescope is revisioned and audited. Preview it with `--dry-run` (prints
the before/after diff and the current revision), then apply it with
`--expected-revision N`: if someone changed the grant in between, it fails with
`grant_conflict` and writes nothing. `memrain auth grant-history <client_id>`
shows who changed the grant and when; the admin API exposes the same through
`POST /admin/api/rescope-client` (`dry_run`, `expected_revision`) and
`GET /admin/api/grant-audit?client_id=`. A client's daily budget
(`auth set-budget`) is part of the same revision and audit trail.

The admin panel's grant editor (Agents → Credentials → Permissions) edits a
client's sources, write fence, scopes, tool surface and daily budget.
**Preview changes** sends `dry_run: true` and shows the changed rows, what the
change does to issued tokens, and which fields it widens; it also
returns a `plan_hash`, an HMAC over the client id, revision and resulting
grant, keyed from the admin secret. **Apply reviewed changes** resends the same
partial change with `expected_revision` and that `plan_hash`; the server
recomputes the plan under the row lock and refuses with `409 grant_conflict` if
the revision moved (the response carries the current grant) or
`409 plan_changed` if the plan differs. A change that widens authority (a new
scope, source or read source, a looser fence, a tenant-mode change, a wider
tool surface, a higher or removed budget) needs a passkey confirmation from the last five minutes (`403 reauth_required`); a
narrowing does not, and a brain with no passkey enrolled needs none. The same
step-up guards registering a client, minting an API key, issuing an enrollment,
changing a client's redirect URIs and setting its token TTL. On an
enrollment-mode client, tokens issued from an enrollment keep that
enrollment's sources and its own daily budget when it has one. A bootstrap-token sign-in counts as a
step-up for its first ten minutes. Grant
profiles are presets recorded for audit; they do not limit what the editor may
set.

The `actor` on an audit row is a label, not an authenticated identity. The CLI
records `MEMRAIN_OPERATOR` (else `USER`, else `cli`), which whoever runs the
command can set to anything; the admin API records `admin` for every change.
Read it as a note about who said they made the change, and rely on host access
logs when you need to know who did.

Two things to know before you rely on this:

- **Set `MEMRAIN_TENANT_FAIL_CLOSED=1`** once a real scoped client exists. Without
  it an authenticated public principal that carries NO grant falls back to the
  redacted whole brain instead of to nothing. Every scoping rule above binds
  on the caller's grant, so a grantless principal is the one caller they do
  not constrain — this flag is what removes that hole, not an
  optimisation.
- **Dynamic Client Registration hands every self-registered client the same
  `default` tenant.** If you enable `MEMRAIN_ENABLE_DCR`, every client that
  registers through it writes to and reads that same source. Register
  clients yourself (`memrain auth register-client --source …`), or rescope one
  afterwards with `memrain auth rescope-client <client_id> --source SRC
  --federated-read SRC`.

## 5. Housekeeping, ingest & ops

`memrain serve` runs one housekeeping pass an hour, in process (the first one
five minutes after start). Its steps, in order: `purge` (soft-deleted pages and
documents past their TTL), `mirror_pages` (rebuild missing or stale search
mirrors), `embed_gaps` (embed chunks stored without a vector), `tokens`
(expired OAuth tokens and codes), `reservations` (spend holds a crashed call
never settled) and `retention` (request log, write receipts, pre-Lite chat
history). One process runs it at a time, under the `memrain-cycle` lock a pre-Lite
maintenance cycle took. No model is called; the embed step pays for Titan
embeds under the daily cap. `MEMRAIN_CYCLE=0` or maintenance mode stops it.

The steps that delete or rebuild (`purge`, `mirror_pages`, `embed_gaps`,
`retention`) also obey the off-switches a pre-Lite cycle obeyed, so an install
that had its cycle switched off keeps its rows after the upgrade: a
`MEMRAIN_DAEMONS_DISABLED` list naming `cycle`, a paused `daemon_controls` row
for every daemon or for the cycle, and `MEMRAIN_CYCLE_SKIP_PHASES`. The token
sweep and reservation expiry ignore them.

The rest of this section covers ingest gates, migrations and the database.
The compose-allowlisted knobs carry explicit defaults in
`deploy/docker-compose.yml`; the rest are code-only.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMRAIN_CYCLE_SKIP_PHASES` | none | CSV of pre-Lite cycle phase names. A housekeeping step whose pre-Lite phase is listed is skipped: `purge` (which covers the purge and retention steps), `mirror-pages`, `embed-gaps`. | free |
| `MEMRAIN_EVENT_LOOP_WATCHDOG_MS` | off (unset or blank) | Process event-loop stall threshold in milliseconds. Must be a digits-only safe integer of at least `15000`; invalid values, including `0`, abort startup. Environment-only, read at `serve` startup; restart required. Code-only, not compose-allowlisted. | free |
| `MEMRAIN_EMBED_GAPS` | on | The housekeeping step that embeds chunks stored without a vector (after an outage or a spend refusal). `0` turns it off. A chunk whose embed failed three times for a lasting reason is left to `memrain embed`. Allowlisted. | **paid (Titan)** |
| `MEMRAIN_EMBED_GAPS_MAX_PER_RUN` | `200` | Most chunks that step embeds in one run. A non-positive or malformed value uses the default. Code-only. | **paid (Titan)** |
| `MEMRAIN_MIRROR_PAGES_MAX_PER_RUN` | `200` | Most pages the `mirror_pages` step rebuilds in one run. A non-positive or malformed value uses the default. Code-only. | free |
| `MEMRAIN_DAEMONS_DISABLED` | empty | Lite has no daemons. A CSV that names `cycle` stops the housekeeping steps that delete or rebuild (see above); other names do nothing. Not compose-allowlisted. | free |
| `MEMRAIN_NOTIFY_WEBHOOK_SECRET` | unset | Lite sends no notifications. The name is kept environment-only: `memrain config set` refuses to store it and a stored row is ignored, so a database dump never holds it. `fetch-secrets.sh` still writes it to `.secrets/memrain.env` when the optional secret exists. | free |
| `MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE` | unset | As `MEMRAIN_NOTIFY_WEBHOOK_SECRET`: never stored, otherwise unused. | free |
| `MEMRAIN_MAX_BODY_BYTES` | `1048576` (1 MiB) | HTTP request-body size cap; over-cap requests get 413. | free |
| `MEMRAIN_NO_SANITY` | off (`=1` on) | Kill switch for the content-sanity ingest gate. Set truthy to skip junk/oversize/markup assessment entirely. The gate runs unless this is set. | free |
| `MEMRAIN_SANITY_DISPOSITION` | `quarantine` | How a junk-flagged doc is handled: default quarantines + stamps `content_flag` (still stored, embed-skipped); `reject` hard-rejects it at ingest. | free |
| `MEMRAIN_WRITE_GATE_EXTERNAL` | `flag` | Write gate for documents in outside sources (kinds `mailbox`, `calendar`, `chat`, `meeting`, `webhook`, `github`). A deterministic check, no model call, looks for text that reads as instructions to an AI: directives that try to replace the reader's instructions, chat-template role markers, tool-call shaped text, requests to send data out (including standing rules that route mail or files to an address), directives to the memory itself, standing rules addressed to an agent ("from now on, when asked about X, say Y") and requests to hand over passwords or keys. Hidden Unicode tag characters are read as the text they mirror. `flag` stores it with `content_flag: instruction_like` and reads it back inside a stronger frame; `quarantine` hides it from search and queues it for `memrain write-gate approve\|reject`; `reject` refuses the write; `off` skips the check. A detector error quarantines. A source the owner connected on a pre-Lite brain (it has a connector account and belongs to the owner member) is flagged, never held or refused: there `quarantine` and `reject` act as `flag`. An agent's text that is only shaped like a tool call is flagged, never held. `memrain write-gate scan --documents` counts, without writing anything, what the gate would do to stored documents on their next index. Set with `memrain config set`; not compose-allowlisted. | free |
| `MEMRAIN_WRITE_GATE_AGENT` | `off` | The same write gate for remote (MCP) writes into any other source: `off`, `flag` or `quarantine`. Off by default because agents write notes that quote instructions. A held document keeps its verdict when a re-index sees the same content; a local rewrite clears it. It also caps the row gate for that origin, as `MEMRAIN_WRITE_GATE_EXTERNAL` does for outside rows (see `MEMRAIN_WRITE_GATE_ROWS`). Set with `memrain config set`; not compose-allowlisted. | free |
| `MEMRAIN_WRITE_GATE_ROWS` | `flag` | The write gate on facts, takes and timeline entries. Lite writes none of these, so no new row reaches it. It still sets the mode `memrain write-gate scan` uses on rows a pre-Lite brain stored: the scan writes a receipt to `write_gate_receipts` for a matching row and never holds one, and `off` skips the check. `memrain write-gate rows\|release\|drop` act on rows a pre-Lite gate held in `write_gate_row_holds`. `MEMRAIN_WRITE_GATE_AGENT` and `MEMRAIN_WRITE_GATE_EXTERNAL` set to `off` or `flag` cap the mode for their origin. Set with `memrain config set`; not compose-allowlisted. | free |
| `MEMRAIN_WRITE_GATE_QUARANTINE_SOURCES` | empty | CSV of source ids whose `flag` verdicts become `quarantine` (held for owner approval). Never loosens `reject` or turns on a gate that is `off`. Set with `memrain config set`; not compose-allowlisted. | free |
| `MEMRAIN_CONTENT_SANITY_DISABLE` | empty | CSV of content-sanity pattern names to switch off (e.g. `access_denied,operator_literal_2`), so one pattern that keeps hiding legitimate pages can be silenced without dropping the whole gate. Unknown names are ignored. Each quarantine trip writes an audit row naming the patterns that fired, and `memrain doctor` warns with the count of quarantined pages and the top patterns; disable the culprit, then `memrain quarantine clear`. Allowlisted. | free |
| `MEMRAIN_SANITY_LITERALS_FILE` | unset | Path to an operator literals file (one case-insensitive literal per line, blanks/`#` ignored) so site-specific boilerplate the built-in patterns miss is quarantined. Fail-open. | free |
| `MEMRAIN_PAGE_WARN_BYTES` | `50000` | Byte size above which a page crosses into the markup prose-check window. | free |
| `MEMRAIN_PAGE_BLOCK_BYTES` | `500000` | Byte size above which an oversize page is soft-blocked (no junk match required). | free |
| `MEMRAIN_MAX_MARKUP_RATIO` | `0.85` | Markup-to-prose ratio above which a page is flagged `markup_heavy` (flagged, not hidden). | free |
| `MEMRAIN_SECRET_SCAN_DISPOSITION` | `redact` | What happens to a credential found in content being stored: page writes, indexed files and transcript imports. `redact` (default) replaces each with `[REDACTED:<kind>:<fingerprint>]` before storage or embedding, and keeps the original in the secret store when a key is set (`MEMRAIN_CONNECTOR_KEK`); `flag` stores it unchanged but still records the finding; `reject` refuses the write. Findings are recorded in the ingest log by kind and a 16-hex SHA-256 fingerprint only, never the value. Allowlisted. | free |
| `MEMRAIN_SECRET_SCAN_ALLOW` | empty | CSV of 16-hex fingerprints (as printed in a redaction marker; 12-hex entries are ignored) to leave in place — for a string that matches a credential pattern but is not one. Allowlisted. | free |
| `MEMRAIN_CONNECTORS_ENABLED` | off | Lite has no connectors, and no code path acts on this switch. | free |
| `MEMRAIN_CONNECTOR_KEK` | unset | Base64 of the 32-byte key (AES-256-GCM) that seals the secret store: the original of each credential the secret scan redacts from a page write, so `memrain secrets originals\|reveal\|restore` can act on it later. Unset, a write still redacts but keeps no original, and `memrain doctor` says so. Never stored in the database; each sealed row records only the key's id. Comes in through `.secrets/memrain.env`. Code-only. | free |
| `MEMRAIN_CONNECTOR_KEK_FILE` | unset | Path to a file holding the same base64 key, for self-hosting. Refused unless only its owner can read it (`chmod 0400`). Set this or `MEMRAIN_CONNECTOR_KEK`, not both. Code-only. | free |
| `MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET` | unset | Lite has no connectors. The name is kept environment-only: `memrain config set` refuses to store it and a stored row is ignored. Nothing else reads it. | free |
| `MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET` | unset | Lite has no connectors. The name is kept environment-only: `memrain config set` refuses to store it and a stored row is ignored. Nothing else reads it. | free |
| `MEMRAIN_SLACK_OAUTH_CLIENT_SECRET` | unset | Lite has no connectors. The name is kept environment-only: `memrain config set` refuses to store it and a stored row is ignored. Nothing else reads it. | free |
| `MEMRAIN_MIGRATION_LOCK_TIMEOUT` | `10s` | Per-migration advisory-lock timeout (e.g. `10s`, `500ms`, `5min`). Fail-loud on a malformed value. | free |
| `MEMRAIN_LOCK_STEAL_GRACE_SECONDS` | derived: 2 × (TTL in seconds ÷ 6), min `60` s | Grace before a stale holder of a database lock (the housekeeping lock among them) can be taken over. Auto-derived from TTL when unset. | free |
| `MEMRAIN_EMBED_CONCURRENCY` | `8` | Max in-flight embed calls in the backfill fan-out pool; a full backfill is ~pool-size faster than serial. | free |
| `MEMRAIN_REEMBED_ON_SIGNATURE_CHANGE` | off (`=1` on) | Re-embed a chunk when the embed signature (model/dim/wrapper) changes, not just when its text changes. Opt-in by design — a bare toggle can trigger a large re-embed. | free (Bedrock embed) |
| `MEMRAIN_WIKILINK_CANONICALIZE` | built-in | Canonicalize wikilink slugs to their target pages. | free |
| `MEMRAIN_WIKILINK_TRGM` | built-in | Use trigram similarity to resolve fuzzy wikilink slugs. | free |
| `MEMRAIN_CONFIG_PATH` | built-in | Override path to the on-disk config file. | free |
| `MEMRAIN_AUDIT_DIR` | built-in | Directory for the weekly audit file. | free |
| `MEMRAIN_PAGE_MAX_BYTES` | unset (off) | Upper bound, in UTF-8 bytes, on a page body written through `page_put` / `page_append` / `page_edit`, the CLI and importers. Unset: no limit beyond the HTTP request cap. Set (for example `2097152` for 2 MiB): a write whose resulting body exceeds it fails with `page_too_large`; a page already over the limit can still change its title or truth. A malformed value fails the write rather than running uncapped. | free |
| `MEMRAIN_REQUIRE_WRITE_PRECONDITION` | `off` | What MCP `page_put` does when it would overwrite an existing page without `expected_version` (and without `force`): `off` writes as before, `warn` writes and adds a warning, `refuse` (also `1`/`true`) fails with `precondition_required` and the current version. Creates always pass. With `warn`/`refuse`, a replacement under half of a live body larger than 32 KiB is also refused (`page_shrink_refused`, byte counts); use `page_edit` or explicit `allow_shrink:true`. The existing `force:true` and `off` bypasses remain. Allowlisted. | free |
| `MEMRAIN_SECRET_SCAN_HIGH_ENTROPY` | on | Redacts high-entropy values assigned to secret-looking keys (`password=`, `api_key:` …). `0`, `false`, `off` or `no` disables it. Allowlisted. | free |
| `MEMRAIN_SECRET_SCAN_ECHO` | on | Also redacts bare repeats of a value already caught in the same write. `0`, `false`, `off` or `no` disables it. Allowlisted. | free |
| `MEMRAIN_OUTPUT_REDACTION` | on | Scans what retrieval tools return to non-operator callers and replaces credentials with `[REDACTED:<kind>:<fp>]`; ids, slugs and hashes pass unchanged. Honours `MEMRAIN_SECRET_SCAN_ALLOW`. `0`, `false`, `off` or `no` disables it. Allowlisted. | free |
| `MEMRAIN_TRANSCRIPT_MAX_FILE_BYTES` | `104857600` (100 MiB) | Largest export `memrain transcripts ingest` accepts; a bigger file is refused whole, never truncated. Allowlisted. | free |
| `MEMRAIN_HNSW_ZOMBIE_SWEEP` | off (`=1` on) | Drops invalid (half-built) vector indexes at boot. Postgres only, best-effort. `doctor` reports them either way. Allowlisted. | free |
| `MEMRAIN_PG_POOL_MAX` | `10` | Postgres connection pool size. | free |
| `MEMRAIN_PG_POOL_RESERVE` | off (`=1` on) | Keeps one pool connection free: the embed backfill shares at most `MEMRAIN_PG_POOL_MAX` − 1 slots, so `/health` and lock renewals never queue behind it. A long holder started inside another takes no second slot. | free |
| `MEMRAIN_SEARCH_MAX_CONCURRENT` | unset (unbounded) | Upper bound on searches running at once in one process; further searches wait their turn. A malformed value is ignored. | free |
| `MEMRAIN_PG_APPLICATION_NAME` | unset | `application_name` on every Postgres connection, shown in `pg_stat_activity` (for example `memrain:<tenant>:serve`). Characters outside `A-Z a-z 0-9 : . _ -` are dropped; at most 63. No personal data belongs here. | free |
| `MEMRAIN_PG_POOL_PROCESSES` | `1` | How many processes open a `MEMRAIN_PG_POOL_MAX` pool against this database (serve, other containers). Read only by doctor `db-connection-budget`, which warns when the planned pools or the open connections pass 80% of `max_connections` minus the superuser reserve. | free |
| `MEMRAIN_PG_STATEMENT_TIMEOUT_MS` | `30000` | `statement_timeout` for the engine's sessions. Migrations use their own. Not sent in pooler mode: there the database role's `statement_timeout` applies. | free |
| `MEMRAIN_PG_POOLER` | unset | `pgbouncer` when `MEMRAIN_POSTGRES_URL` points at a PgBouncer in transaction mode (1.21 or newer, `max_prepared_statements` above 0). The engine then sends no session startup parameter except `application_name`, so the role must carry `statement_timeout` and `idle_in_transaction_session_timeout`, and doctor `db-connection-budget` fails when either reads `0` through the pool. A login role is refused. Migrations and DDL (`hnsw sweep|rebuild`, the boot zombie sweep, `apply-migrations`) go over `MEMRAIN_POSTGRES_DIRECT_URL`. Any other value stops the process. Env-only. | free |
| `MEMRAIN_POSTGRES_DIRECT_URL` | unset | The database itself, bypassing the pooler. Read only in pooler mode, where migrations and DDL require it: without it they are refused with `pooler_migration_refused` before any statement is sent, and the server does not start. Env-only. | free |
| `MEMRAIN_PG_PREPARE` | on | `0` turns off postgres-js's named prepared statements. Read only in pooler mode, as a fallback for a pooler that does not track them. | free |
| `MEMRAIN_MIGRATION_STATEMENT_TIMEOUT` | `30min` | Statement timeout for one migration (`600s`, `30min`, milliseconds). Fail-loud on a malformed value. | free |
| `MEMRAIN_MIGRATE_BACKOFF_MS` | unset (5s/15s/45s) | Replaces the migration retry backoff with one fixed delay. For tests. | free |
| `MEMRAIN_BULK_MAX_RETRIES` | built-in | Retries for a transient database error in bulk work. `0` disables retries. | free |
| `MEMRAIN_NO_DB_CONFIG` | off (`=1` on) | Skips the `memrain config set` overlay: stored `MEMRAIN_*` values are normally applied at boot where the real environment leaves a key unset. | free |
| `MEMRAIN_PGLITE_AUTO_ANALYZE` | off (`=1` on) | PGLite only (it has no autovacuum). After each `memrain import --apply`, runs `ANALYZE` on the hot tables (`pages`, `chunks`, `embeddings`, `entity_facts`, `links`) whose live row count has drifted from the planner estimate by more than max(500, 10%). Postgres is left to autovacuum; doctor `planner-stats` reports stale statistics on both engines. | free |
| `MEMRAIN_PGLITE_NO_LOCK` | off (`=1` on) | Skips the lock file that stops two processes opening one PGLite directory. Only for a filesystem that cannot hold it. | free |
| `MEMRAIN_TEST_PGLITE_TEMPLATE` | unset | Test-only. A new PGLite directory starts as a copy of this already-migrated one; `scripts/test-sharded.sh` sets it. Never set it in `.env` or compose. | free |

When the event-loop watchdog is enabled, an independent worker watches a
one-second main-thread heartbeat. Two observed heartbeats arm it; a delay in
the observer itself resets the stall window, so a suspended process does not
immediately trip on resume. An armed, continuous stall prints a fixed
diagnostic and sends the process `SIGTERM`, followed by `SIGKILL` after five
seconds if graceful shutdown has not stopped the observer. Normal shutdown
stops the watchdog first. Asynchronous network waits keep the heartbeat alive;
this setting does not replace a job timeout. It makes no database probes or
lease changes and adds no inference cost. To disable it, unset or blank the
environment variable and restart; `0` is not an off value.

### Maintenance mode

Four switches control the work `serve` starts on its own. They are read from
the environment only: a `runtime_config` row can never set them, so a leftover
row cannot stop housekeeping for good or restart it during maintenance. Two of
them only matter to a pre-Lite install: Lite has no code sweep and no jobs worker,
so it only reports them and counts them in `memrain status --quiescent`. All four are in
the compose allowlist with an empty default.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMRAIN_MAINTENANCE` | off (`=1` on) | Maintenance mode. Forces the three switches below off, whatever they say, so the hourly housekeeping does not start, and skips the boot sweep of expired OAuth tokens: a server in maintenance writes nothing by itself. `/health` then carries `"maintenance":true` and `deploy/deploy.sh` does not start the ingress. | free |
| `MEMRAIN_BOOT_CODE_SWEEP` | on (`=0` off) | Pre-Lite only. Lite has no code sweep; the value shows in the boot line and in `memrain status`, and `--quiescent` counts it as a switch that is on. | free |
| `MEMRAIN_JOBS_WORKER` | on (`=0` off) | Pre-Lite only. Lite has no jobs worker; the value shows in the boot line and in `memrain status`, and `--quiescent` counts it as a switch that is on. | free |
| `MEMRAIN_CYCLE` | on (`=0` off) | Starts the hourly housekeeping. `0` turns it off. | free |

An empty value counts as unset. Any value other than `0` or `1` fails closed:
it turns maintenance on, or turns a switch off, and the boot log names the
invalid switch. When anything is off, `serve` prints one line such as
`[memrain] maintenance=on code_sweep=off jobs_worker=off cycle=off`.

`memrain status` reports a `quiescence` block: the running state of the
switches, plus counts of running and leased pre-Lite jobs and of live cycle
(housekeeping) and worker locks. `memrain status --quiescent` exits 0 only
when maintenance is on (or all three switches are off) and no job, lock or
worker is active; otherwise it exits 3 and prints what failed.

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

### Explicit maintenance previews

These commands default to read-only previews, do not run as deployment steps,
and do not invoke models. The syntax below uses placeholders; review the actual
preview before choosing an apply operation.

```text
memrain purge-leftovers
memrain purge-leftovers --apply --plan-hash HASH64 --export FILE
memrain purge-leftovers restore --from FILE
```

`purge-leftovers` previews what purges on a pre-Lite release that ran before synthesis cleanup
left behind: atoms, atom pages, takes and contradiction rows whose source document
no longer exists (page slugs are left to the page purge, since a rename moves a
page without its takes), the concepts narrated over them (rebuilt or retired as a purge does
now), and live facts written on a page that is gone. Facts that only name a
gone page as their source, with no purge receipt, are listed and kept. The
preview prints every row with its source, action and reason, and `plan_hash`;
`doctor` reports the same counts as `purge-leftovers`. Apply re-plans inside
one transaction, refuses a different hash, writes every row it is about to
change to `FILE` (a new file, mode 0600), and then applies. The synthesis
tables have no soft delete, so that export is the undo: `restore --from FILE`
puts the rows, the pages' earlier text and the retired facts back. It refuses
when a page or concept it touched changed since the apply, and works only
while the pages it hid are still soft-deleted (the 30-day page TTL). Apply and
restore drop the search mirrors of the pages they rewrite and rebuild them
from the new text right after the commit; a page whose mirror could not be
rebuilt is listed under `mirrors.failed`, and the next hourly housekeeping
rebuilds it.

```text
memrain erase forgotten --source SOURCE [--fact-ids ID1,ID2] [--deleted-pages SLUG1,SLUG2]
memrain erase forgotten --source SOURCE [--fact-ids ID1,ID2] [--deleted-pages SLUG1,SLUG2] --apply --plan-hash HASH64
```

Erasure requires one exact source and 1–100 explicit unique fact IDs and/or
deleted page slugs. Facts must already be forgotten or provably withdrawn;
supersession alone is insufficient. Facts with dimension metadata are held
because their reinsertion guard is not supported. Live pages are refused.
Preview reports IDs, slugs, per-table counts and hashes, and blockers without
printing stored content. A blocked preview exits 2. Apply requires the exact
preview hash and rechecks the complete dependency snapshot under locks;
stale, busy or blocked operations delete nothing. Withdrawal guards retain
non-text claim keys to prevent reinserting erased facts.

Run erasure in a planned quiet period with housekeeping stopped (`MEMRAIN_CYCLE=0` or maintenance mode).
Active jobs or worker/cycle locks, replay receipts, unselected references or
copies, unknown dependencies, and unproven ownership block the operation.
The command does not stop workers itself. Its census is capped at 50,000 rows
and 32 MiB of JSON; exceeding either cap refuses erasure. Apply locks the
public-schema tables while checking dependencies and can briefly block other
writers. Lock waits are capped at two seconds; statements at 30 seconds, with
60-second work checks.

Erasure permanently removes selected SQL rows and modeled dependencies,
including selected deleted-page history and mirrors. It does **not** erase
PostgreSQL dead tuples or WAL, backups, external files, exports, client copies,
external logs, paraphrases or unlinked fragments. Reverting the program cannot
restore erased rows. It creates no automatic backup and is never applied
automatically by deployment, housekeeping or an MCP tool.

### CLI exit codes

When a `memrain` command stops on a structured error, the exit code says what
kind of failure it was, so a cron job or CI step can decide whether to retry:

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Any other failure (a refusal, a permission or version conflict, an unexpected error). |
| `2` | Usage error or invalid input (`error_class: invalid_request`). Fix the command before running it again. |
| `75` | Retryable failure (`retryable: true`, such as a busy or timed-out database). The same command may succeed later. |

Commands that document their own codes keep them: `memrain status --quiescent`
exits `3` while maintenance is not quiescent. Argument checks inside a command
return their documented code directly.

---

## 6. Terraform infrastructure variables

Set in `terraform/terraform.tfvars` (generated by `scripts/init.sh`). Full
schema in `terraform/variables.tf`.

| Variable | Default | Description |
|---|---|---|
| `aws_region` | `eu-west-1` | AWS region for the stack. |
| `aws_profile` | `default` | AWS CLI profile (matches `~/.aws/config`). |
| `tfstate_region` | `eu-central-1` | Region of the S3 bucket holding terraform state (often differs from `aws_region`). |
| `domain` | `""` | Public root domain (e.g. `example.com`). Used by the Cloudflare Tunnel and OAuth flows. |
| `subdomain` | `brain` | Subdomain serving the public MCP (e.g. `brain` → `brain.example.com`). |
| `memex_subdomain` | `null` | DEPRECATED alias of `subdomain`; when set it still wins, and a `check` warns. Removed in 0.2.0. |
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
| `bedrock_allowed_regions` | EU family + `us-east-1` | Regions listed for Claude model invocation. Lite calls no Claude model; its IAM allows Titan text embeddings only. |
| `bedrock_model_id` | `amazon.titan-embed-text-v2:0` | Informational: feeds only the `bedrock_model` output, and IAM does not reference it. Lite calls no generative model. |
| `alarm_email` | `""` | Email for the EC2 status-check CloudWatch alarm. Empty skips email (alarm still fires). |
| `ssh_allowed_cidr` | `""` | CIDR allowed inbound SSH. Empty disables SSH — use SSM Session Manager. |
| `enable_vpc_endpoints` | `false` | Enable interface VPC endpoints (Bedrock, SM, SSM, Logs). ~$43/mo — off for personal use. |
| `enable_cloudtrail` | `true` | Enable CloudTrail API auditing (logs in S3, 90-day retention). |
| `repo_url` | `""` | Git URL the EC2 clones at first boot. HTTPS for public repos; SSH form needs `use_ssh_deploy_key = true`. |
| `ingress_mode` | `cloudflare` | How the public MCP endpoint is reached: `cloudflare` (Cloudflare Tunnel sidecar, no inbound ports) or `caddy` (Caddy terminates TLS on the instance, opens inbound 80/443). |
| `caddy_manage_dns` | `true` | `caddy` ingress only: create the `<subdomain>.<domain>` A record in the domain's Route53 hosted zone. Set false when DNS lives elsewhere and create the record to the instance EIP yourself. |
| `efs_backup` | `true` | AWS Backup's daily EFS backups (35-day retention). Set false only if another backup covers the mount. |

> Lite's only model call at runtime is Amazon Titan Text Embeddings v2 through
> Bedrock, and its IAM allows Titan embeddings only.

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

Installs from before the rename to Memrain keep working in 0.1.x without
changes. The old names below are read as a fallback. **All of them are removed
in 0.2.0, which refuses to start while a legacy name is still in use**, so
move to the new names (UPGRADING.md) before taking 0.2.0. Data written by
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
before 0.2.0) and lists shadowed rows as information only.

**Other names.**

| Legacy | New |
|---|---|
| `~/.memex/config.json`, `memex.yml` | `~/.memrain/config.json`, `memrain.yml` (the new one wins; `init` refuses while an unmoved `~/.memex` holds data) |
| `x-memex-*` ingest headers | `x-memrain-*` (both families at once with different values → 400) |
| `<prefix>/memex-*` secrets | `<prefix>/memrain-*`, tried first; an unset `SECRETS_PREFIX` means `memex` |
| the `memex` command | `memrain` |
| the `memex` compose network alias | the `memrain` service name |
| `STACK_MEMEX_SUBDOMAIN`, terraform `memex_subdomain` | `STACK_SUBDOMAIN`, `subdomain` |
