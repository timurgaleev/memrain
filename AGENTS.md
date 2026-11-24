# AGENTS.md — Working in this Repo as an AI Agent

> Companion to `llms.txt` (which is the doc map). This file is how to *work*: build, test, deploy, commit. Read `CLAUDE.md` first — it carries the user's irrevocable rules.

## TL;DR

- Always confirm before destructive ops (commit, terraform apply, EC2 recreate).
- TDD where the logic is testable; smoke-test where the network is the test.
- Containers run on a single EC2; deploy = `git pull && docker compose up -d --build` over SSM.
- Memrain Lite is one person's brain: 29 MCP tools over pages, links, tags and hybrid search. Pages live in the database; `memrain export` dumps them to markdown, and the search index is rebuildable from the pages (`memrain reindex`, `memrain embed`).
- Memrain is reached over MCP only (`POST /mcp`, through cloudflared or — with `ingress_mode = "caddy"` — a Caddy sidecar on the instance's own IP). No chat surface, no bot — just MCP clients (Claude Code, Codex, claude.ai, ChatGPT, …).
- Callers authenticate with a personal access token bound to a source (`memrain auth create <name> --source <src>`) or an OAuth client (`memrain auth register-client`). The static public bearer is permanent, tenant-less and read-limited. Credentials bound to a non-owner member or carrying a trust floor are refused. Guides: `docs/clients/`.

## Required workflow — run the skill for every change

No change is "done" until the skills have run. For **every** change —
features, fixes, refactors, docs, infra — in order:

1. **Self-review skill/agent.** Dispatch the review agent whose
   specialty matches what you changed (the table in `CLAUDE.md` →
   "Self-review after each implementation"): `security-engineer` for
   auth / secrets / ingress, `code-reviewer` for logic / refactor,
   `quality-guard` for new tests, `devops-automator` for CI / docker /
   terraform, `ai-engineer` for engine / MCP / retrieval,
   `reality-checker` for "it's live now" claims, `bug-hunter` for
   adversarial sweeps, `technical-writer` for docs. Act on every
   CRITICAL / HIGH finding before declaring done.
2. **Ship workflow.** Follow `CLAUDE.md` → "Ship workflow":
   **test → push → deploy → verify → release**, in that order, every
   time. A change is not shipped until the live EC2 is running it and
   `/health` + the MCP smoke-test pass; user-facing version bumps
   end with a SemVer tag + GitHub release (see "Release" below).

Both are non-negotiable and apply even to one-line fixes — the cost of
one extra skill/agent run is cheaper than a production regression.

## Build & test (Memrain)

```bash
cd deploy/memrain
bun install               # frozenLockfile=true; never commit lock drift
bun run test:sharded      # the full suite — a few minutes, JOBS shards at once
bun run test:changed      # only files affected since origin/main
bun test tests/foo.test.ts  # one file while iterating — seconds
bun run src/cli.ts --help # CLI surface
```

**Never run the whole suite as a bare `bun test`.** Every PGLite instance a
test opens reserves WASM linear memory that is never returned, so one
process running all 324 files dies inside `pg_initdb` with `RangeError: Out
of memory` and reports hundreds of phantom failures that have nothing to do
with your change. `test:sharded` runs fixed-size chunks in fresh processes —
the same script CI runs. A bare `bun test <file>` on one or a few files is
fine and fast.

There is no `bun run build` step for runtime — the daemon starts via `bun run src/cli.ts serve`. The `build` script in `package.json` exists for diagnostic bundling, not deployment.

## CLI commands worth knowing

`bun run src/cli.ts <cmd>` (aka `memrain <cmd>` in the container). `--help` lists them all; the ones you'll reach for most:

```
export [--dir DIR] [--source ID]     # dump every live page to a markdown tree (frontmatter + body,
                                      #   slug dirs); --source scopes to one tenant. Backup / portability
                                      #   escape hatch for the DB-only substrate.
doctor [--json]                      # health of the subsystems this build runs; one line counts the
                                      #   2.x feature rows it leaves unused
transcripts ingest <path>            # import ChatGPT, Claude, Codex or Claude Code history as pages
write-gate … / quarantine …          # work the review queues (there is no admin Approvals page)
secrets audit|originals|reveal|restore|backup  # find stored credentials; work the kept originals
```

## Build & test (full stack — Docker)

The simplest "does my change build" check uses Docker locally (matches the EC2 architecture):

```bash
cd deploy
docker compose build memrain          # ~30s on warm cache
```

Full local up requires the secrets — they're gitignored and only fetched on the EC2. Don't try to bring up the stack on your laptop; smoke-test on EC2.

## Deploy

Always: `git push origin main` → SSH/SSM into EC2 → `cd /opt/<project> && git pull && docker compose --env-file .env -f deploy/docker-compose.yml up -d --build` → wait for `memrain` to report `Up <N> (healthy)` → smoke-test the MCP surface from inside the network:

```bash
docker exec deploy-memrain-1 sh -c '
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"stats\"}}" \
    | wget -qO- --post-file=/dev/stdin --header=Content-Type:application/json http://127.0.0.1:18790/mcp
'
```

Then confirm `brain.<domain>/mcp` answers an MCP client (Claude Code).

Never:
- `terraform taint aws_instance.memrain`
- `terraform apply` without showing plan + getting explicit "yes apply"
- `docker compose down` (it's a no-op for state but cuts traffic; use `restart` instead)

## Release

For a user-facing version bump, after deploy + verify are green:

1. Roll `[Unreleased]` in `CHANGELOG.md` into `## [X.Y.Z] — <date>`
   (SemVer), leaving an empty `[Unreleased]` on top.
2. Tag the shipped commit and push it: `git tag vX.Y.Z && git push
   origin vX.Y.Z`.
3. Publish the release: `gh release create vX.Y.Z --title vX.Y.Z
   --notes "<the changelog section>"`.

The tag must point at a CI-green commit that is already live on the
EC2 — never tag ahead of deploy. `package.json` versions are decoupled
and are not bumped as part of a release.

## Commit etiquette

- One coherent change per commit. Migration in one, command in another, MCP in another, docs in another.
- Conventional-commit prefixes: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
- Never `--no-verify`, never `--amend` to a published commit.
- The user must say "commit it" / "go" / "yes commit" before `git commit`. Same for `git push`.

## Testing patterns we use

| What | How |
|---|---|
| Pure logic (chunker, RRF, fences) | Bun tests, deterministic, ~10ms each |
| Storage + DB shape | tmp PGLite, seeded directly, no Bedrock (PGLite is dev-only; prod runs Postgres) |
| HTTP routes | `Bun.serve` on port 0, real fetch round-trip |
| MCP transport | `Bun.serve` on port 0 + JSON-RPC client via fetch |
| Bedrock-touching paths | Mocked at the embedding boundary; smoke-test live separately |

## Env vars worth knowing

```
AWS_REGION=<your-region>          # required
AWS_PROFILE=default               # required, not optional
SECRETS_PREFIX=memrain            # AWS Secrets Manager namespace
MEMRAIN_VAULT_PATHS=/memory       # paths the `index` tool and `import` may read
MEMRAIN_DAILY_BUDGET_USD=1.00     # brain-wide cap on embedding spend per UTC day
MEMRAIN_CYCLE=0                   # env only: turns the hourly housekeeping off
MEMRAIN_HOST=0.0.0.0              # in the container; loopback off-EC2
BRAIN_PORT=18790
MEMRAIN_PUBLIC_BEARER=<token>     # static public bearer: no tenant, public read
                                  #   subset only; people get PATs or OAuth clients
MEMRAIN_INTERNAL_TOKEN=<token>    # gates MCP write tools on the internal path
TUNNEL_TOKEN=<cloudflared>        # NOT CLOUDFLARE_TUNNEL_TOKEN — that's a different alias
```

## Failure modes to recognise

| Symptom | Likely cause |
|---|---|
| Public `/mcp` returns 401 | The token is unknown or revoked (`memrain auth list`, `memrain auth list-clients`) |
| Public `/mcp` returns 503 `public bearer token not configured` | `MEMRAIN_PUBLIC_BEARER` is missing from `memrain.env`; every credential on public ingress, PATs and OAuth included, fails until it is set |
| Memrain healthcheck flaps `starting → unhealthy` | PGLite cold-init / RDS unreachable; check `docker logs deploy-memrain-1` |
| MCP write tool returns -32001 on internal path | `MEMRAIN_INTERNAL_TOKEN` not configured or not sent |
| Cloudflared retries forever, no traffic | `--protocol http2` not set; SG blocks UDP |
| Memrain `EACCES` reading `/memory` | Container running as uid 1000 (alpine `bun`); needs root or correct EFS chown |
| SSM `ConnectionLost`, healthz down | Likely OOM on too-small instance during a large import or re-embed |
| A client gets `credential_unsupported` | Its credential is bound to a member other than the owner, or carries a trust floor; issue an unbound one (UPGRADING.md "3.0.0") |
| A client gets `unknown tool: <name>` | It calls a 2.x tool this build does not serve; update the client or its plugin |
| MCP tool returns `insufficient_scope` or `permission_denied` | The credential lacks the scope, or the tool is operator-only; `whoami` shows what it carries |

## Compatibility code

Memrain was called memex before 1.0.0, and the code keeps reading the old
names on purpose: the `MEMEX_*` environment fallback, `memex:` fence markers in
pages, `memex_` token and client id prefixes, the `x-memex-*` ingest headers,
the legacy SQL functions (`memex_fact_claim_key` and friends), the
`.memex-lock` PGLite lock, the `memex` command and the `memex` compose network
alias, the `memexResponseVersion` response field, the `memex_admin`,
`memex_return_to` and `memex_approval` cookies and parameters, the `memex-cycle`
and `memex:fact-withdraw` lock ids, the `memex_rds_*` and `memex_postgres_url`
terraform outputs, the `memex` secret prefix used when `SECRETS_PREFIX` is
unset. Existing
installs and stored data depend on them. Do not remove or rename them outside
an announced release (see UPGRADING.md and the CONFIGURATION.md "Legacy names"
section).

## When you don't know what to do

1. Read CLAUDE.md.
2. Read llms.txt for orientation.
3. `git log --oneline | head -20` — what was the last thing done?
4. `CHANGELOG.md` for what shipped, `TODO.md` for what was deliberately
   deferred and why.
5. Ask the user — don't guess on irreversible ops.
