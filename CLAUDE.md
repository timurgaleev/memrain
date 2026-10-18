# CLAUDE.md — Rules for AI agents working in this repo

This file is auto-loaded by Claude Code (and other AI coding agents that
honor the convention). It defines the safety and scope rules every agent
must follow when editing this codebase.

## What you are allowed to do
- Read files and understand the codebase.
- Edit config, scripts, and docs when explicitly asked.
- Run `terraform plan` and `make audit` to show what would change.
- Run AWS CLI read-only commands (`describe`, `list`, `get`).
- Commit and push ONLY when explicitly asked.

## What you are NOT allowed to do without explicit confirmation

### Destructive infrastructure changes
- NEVER run `terraform apply` without showing the plan first AND getting
  explicit "yes, apply".
- NEVER destroy or replace running EC2 instances without explicit
  confirmation.
- NEVER change availability zones, instance types, or subnet
  configurations without warning.
- If a terraform plan shows ANY resource being destroyed or replaced — STOP and ask first.

### File and git operations
- NEVER run `git reset --hard` or any destructive git command.
- NEVER commit files that were not explicitly included in the request.
- NEVER stage and commit deleted files unless explicitly asked to remove them.
- Disk files and git files are DIFFERENT — do not confuse them.

### Scope of work
- Do ONLY what was asked. If asked to fix a config file, fix that file
  only.
- Do NOT remove integrations, features, or code that was not mentioned.
- Do NOT "clean up" things that look unused — ask first.
- Do NOT add, remove, or modify terraform resources beyond what was asked.
- Do NOT add monitoring, alarms, notifications, health checks, dashboards,
  or any new AWS infrastructure that the user did not explicitly request,
  even if it would "improve reliability" or "catch the next failure".
  Discuss the idea in plain text first, agree on the approach, and only
  then build.

### Compatibility code
Memrain was called memex before 1.0.0, and the code keeps reading the old
names on purpose: the `MEMEX_*` environment fallback, `memex:` fence markers in
pages, `memex_` token and client id prefixes, the `x-memex-*` ingest headers,
the legacy SQL functions (`memex_fact_claim_key` and friends), the
`.memex-lock` PGLite lock, the `memex` command and the `memex` compose network
alias, the `memexResponseVersion` response field, the `memex_admin`,
`memex_return_to` and `memex_approval` cookies and parameters, the `memex-cycle`
and `memex:fact-withdraw` lock ids, the `memex_rds_*` and `memex_postgres_url`
terraform outputs, the `memex` secret prefix used when `SECRETS_PREFIX` is
unset, and the "set up memex" / "update memex" skill triggers. Existing
installs and stored data depend on them. Do not remove or rename them outside
an announced release (see UPGRADING.md and the CONFIGURATION.md "Legacy names"
section).

## Key principle

**Ask before acting on anything irreversible.** The cost of one
confirmation message is zero. The cost of a destroyed EC2 instance or
lost disk data is high.

## Project context
- The single EC2 instance is a running service — treat it like production.
- Disk state on the instance ≠ git state — they are separate.
- Terraform changes can destroy live infrastructure — always plan first,
  apply second.

## Conventions

### AWS model selection
- Memrain uses Bedrock for embeddings (Amazon Titan Text Embeddings v2)
  and the Bedrock Claude Haiku calls behind intent classification / query
  expansion / friction-propose. Answer *synthesis* is the MCP client's
  job (Claude Code etc.) — Memrain is a retrieval brain, not a chat agent.
- `var.bedrock_model_id` surfaces a configured default in
  `terraform output bedrock_model`.
- Switching to a new model family requires widening the Bedrock invoke
  permissions in `terraform/iam.tf` (region- and model-scoped).

### Secret naming
- Every secret is prefixed by `var.secrets_prefix` (default: `memrain`,
  override via `scripts/init.sh` for a new install).
- The pattern is `<prefix>/<name>` — e.g. `memrain/memrain-public-bearer`.

### Audit gate
- `make audit` reads `scripts/lib/pii-patterns.txt` and fails on any
  maintainer-private identifier (account IDs, domains, emails, instance
  IDs) found in a tracked file. The CI workflow runs this on every push.

## Repo-specific operational notes

Anything maintainer-specific (live instance IDs, account-specific incident
notes, AWS account-specific lessons) lives in `OPERATIONS_NOTES.md`, which
is `.gitignored` and never leaves the maintainer's machine. New operational
findings — especially incident retros — go there, not here.

## Ship workflow (non-negotiable)

A change is not "shipped" until the live EC2 is running it. The full
loop is: **test → push → deploy → verify → release**, in that order,
every time.

**ALWAYS invoke the `/ship` skill when shipping** — never push, tag, or
release by hand. `/ship` is the single entry point for every change that
leaves the working tree. This repo overrides the generic skill's defaults
to match the rules below, and where they conflict the repo rules win:
- **Ships to `main` directly** (push to `origin main`) — NOT a feature
  branch + PR. Do not create a `VERSION` file or `package.json` bump;
  versioning is git **tags** `vX.Y.Z` (3-digit SemVer) + a `gh release`.
- **Commits carry the operator only** — NEVER add a `Co-Authored-By:
  Claude` trailer (see the no-coauthor rule).
- **Deploy is via SSM** to the live EC2, not platform CI. **Local tests
  are the ship gate** (step 1); GitHub CI never blocks the ship.
- Terraform/infra changes go through `terraform plan`/`apply` against the
  S3 state (step 4) — the skill's test/PR machinery does not apply to
  infra; the live `apply` + verify is the gate.

The numbered loop below is the authoritative procedure `/ship` follows
for this repo:

1. **Test locally** (everything that applies to the change):
   - `make audit` — exit 0
   - `make scrub-audit` — HIGH:0
   - `make typecheck` — exit 0, when any `.ts` changed. Covers `src/` and
     `tests/` alike.
   - `make test` — bash unit tests pass
   - `python3 -m pytest tests/ -q` — all green
   - `make test-pg` — when a migration or Postgres-backed store code changed
     (needs docker; runs the Postgres-only tests and applies migrations twice)
   - `terraform -chdir=terraform fmt -check && terraform -chdir=terraform validate` — when `terraform/` changed
   - `docker compose --env-file .env -f deploy/docker-compose.yml config` — when compose changed (an explicit `-f` is right HERE: this validates the file in the checkout, not the host's resolved set)
   - When Memrain source changed, run the **full Bun suite locally**
     (`env -C deploy/memrain bun run test:sharded`) — not just the touched
     file. The local suite is the authoritative gate (operator decision:
     local is faster and is what we trust; see below). It MUST go through
     `test:sharded`: a bare `bun test` over all 324 files exhausts the
     PGLite WASM heaps mid-run and reports hundreds of phantom failures.
     `test:changed` (files affected since `origin/main`) is for the edit
     loop only; it does not replace this run.
2. **Push** to the `origin` remote on `main`. **Local tests are the
   gate — do NOT block deploy on GitHub CI.** Push so CI runs for the
   record, but proceed to deploy as soon as the local gates in step 1
   are green. Rationale (operator, 2026-06-05): the local run is
   faster and authoritative; waiting on remote CI only adds latency.
   Still glance at `gh run list --limit 1` later and fix any red, but
   it never gates the ship.
3. **Deploy** to the live EC2 via SSM:
   - `git pull --ff-only` in `/opt/memrain/`
   - `bash deploy/deploy.sh` — stamps the image with `git describe`, builds,
     waits for healthy, and FAILS if the running container reports a different
     stamp than the one just built. Do not hand-run the bare `docker compose
     up -d --build` for the memrain service: it leaves `MEMRAIN_VERSION` unset, the
     image is stamped `dev`, and `/health` can no longer tell a fresh container
     from a stale one.
   - For a service other than `memrain`: `docker compose --env-file .env up -d
     --build <service>` from `/opt/memrain/`. Do NOT hand-pass `-f
     deploy/docker-compose.yml`: an explicit `-f` overrides the `COMPOSE_FILE`
     line bootstrap writes into `.env`, and on a caddy install that drops the
     ingress overlay from the resolved set — `--remove-orphans` then deletes
     the only route into the box, and a bare `up -d` starts the parked
     cloudflared with an empty token. An install bootstrapped before
     `COMPOSE_FILE` existed has no such line; add it rather than reaching for
     `-f`.
   - For systemd unit changes: `install -m 644 deploy/systemd/*.{service,timer} /etc/systemd/system/ && systemctl daemon-reload && systemctl restart <unit>`
4. **Verify on the live host**:
   - Containers healthy (`docker inspect <name> --format '{{.State.Health.Status}}'`)
   - `/health` endpoints return `ok:true`
   - For MCP changes: a `tools/call` against `deploy-memrain-1` (or `brain.<domain>/mcp` with the bearer) returns real data
   - From the operator machine: `memrain auth doctor https://<host> --token-file <0600 file> --expect-version <stamp> --expect-operator`
     (run as `bun run src/cli.ts auth doctor ...` in `deploy/memrain`) exits 0 — /health stamp, OAuth discovery, MCP and whoami scope in one report
   - For new timer units: `sudo systemctl start <unit>` succeeds, then `systemctl is-active` reports OK
   - For terraform / infrastructure changes: the **S3-backed terraform
     state is the single source of truth and the ONLY path to change
     infrastructure.** Run `terraform plan` (show it) then `terraform
     apply` against that state, from the ops working dir that holds the
     filled `backend.hcl` + `terraform.tfvars`. **NEVER mutate a
     terraform-managed resource out-of-band** with the AWS CLI or console
     (`revoke-security-group-egress`, `delete-secret`, `modify-*`, etc.)
     — that silently diverges live from state, and the next `apply`
     fights the hand change. If a `plan` would destroy-and-recreate
     something risky, STOP and surface it to the operator; do not reach
     for a CLI shortcut. If live and state ever drift, reconcile through
     terraform (`apply` / `import` / `terraform state` ops), never by
     hand. This public-repo checkout is NOT the ops dir — it lacks the
     gitignored `backend.hcl`/`terraform.tfvars`, so terraform is run
     from the operator's private working dir, not from here.
5. **Release** (for any user-facing version bump):
   - Move the `[Unreleased]` CHANGELOG entries under a new
     `## [X.Y.Z] — <date>` heading (SemVer), leaving an empty
     `[Unreleased]` on top.
   - Tag the shipped commit and push the tag:
     `git tag vX.Y.Z && git push origin vX.Y.Z`.
   - Publish the GitHub release from that changelog section:
     `gh release create vX.Y.Z --title vX.Y.Z --notes "<changelog section>"`.
   - The tag MUST point at a commit whose CI is green and that is
     already live on the EC2 — never tag ahead of deploy. `package.json`
     versions are decoupled and not bumped here.
   - Versions restart at `v1.0.0` with the rename to Memrain. The
     `memex-v*` tags are read-only archives of the releases before it:
     never move, delete or reuse them, and match release tags with
     `--match 'v[0-9]*'`.

Skipping deploy because "the change is just docs" is fine; skipping
verify is not. If a change touches anything other than `*.md`,
`tests/*`, `.github/*`, or `terraform/*.tfvars.example`, plan a deploy
and verify the live result.

## Self-review after each implementation (non-negotiable)

After every meaningful batch of changes (security fix, refactor, new
feature surface, infra change, helper rewrite), dispatch at least one
review agent before declaring the work done — pick the one whose
specialty matches what changed:

| Change kind | Reviewer to dispatch |
|---|---|
| Security-sensitive code (auth, secrets, ingress) | `security-engineer` |
| Logic / refactor / general correctness | `code-reviewer` |
| New tests or coverage claims | `quality-guard` |
| CI / docker / terraform hygiene | `devops-automator` |
| AI / MCP / retrieval / engine code | `ai-engineer` |
| Live deployment claims ("X is now working") | `reality-checker` |
| Adversarial / "did I miss a bypass" | `bug-hunter` |
| Docs accuracy | `technical-writer` |

Operating rules:

- Use `run_in_background: true` so multiple reviewers can sweep
  different facets in parallel. Don't block on a single one.
- Brief the agent with the **exact file:line changes** under review,
  not a hand-wavy "look at my diff". The Agent tool's prompt is the
  agent's only context — make it self-contained.
- Cap the prompt's response length explicitly ("under 350 words")
  so review output stays scannable.
- Act on every CRITICAL / HIGH finding before declaring done. MEDIUM
  acts during the same session if the fix is one-touch. LOW goes to
  `TODO.md` as a follow-up.
- Never silently dismiss a review finding. If a finding is wrong,
  reply (via SendMessage) and resolve the disagreement explicitly.

This rule fires even for small commits — a one-line fix to a
secret-handling path still warrants a quick `security-engineer`
pass. The cost of one extra agent call is cheaper than the cost of
a regression discovered in production.

## Public-OSS-only rule (non-negotiable)

This repository is the **single source of truth** for the project and is
**public open source**. Treat every commit as if it were already on the
internet — because it is.

- Never commit sensitive values: real AWS account IDs, real domains,
  real email addresses, real EC2 instance IDs, real IP addresses, real
  Telegram chat IDs, real client names, real city names, real maintainer
  PII. The `make audit` and `make scrub-audit` gates exist to catch these
  — if either fires, do not commit; investigate.
- Never echo a fetched secret value into a doc, a test fixture, a commit
  message, or a comment. Refer to secrets by their `<secrets_prefix>/<name>`
  pointer only.
- **No file may be `git add`-ed if its content originated from any
  non-public source** (private repo, vault, ops-notes, mirror,
  scratchpad), regardless of how it arrived in the working tree —
  agent-sync, manual `cp`, copy-paste, anything. The audit gates are
  the safety net, not the policy. The policy is: content provenance
  from a public source only.
- Terraform state belongs in the S3 backend (see `backend.hcl.example`),
  never in a private working copy. A local working dir that holds the
  filled-in `backend.hcl` + `terraform.tfvars` is fine for running
  `terraform plan`/`apply`; those files are gitignored. **That S3 state
  is the single source of truth for ALL infrastructure: every infra
  change goes through `terraform plan`/`apply` against it. Do NOT change
  terraform-managed AWS resources with ad-hoc CLI/console calls — they
  diverge live from state and the next `apply` will fight the drift.**
- The `*.local.txt` pattern overlays under `scripts/lib/` (gitignored)
  exist for the operator's actual identifiers — extend them locally,
  never commit them.
- If an agent or sub-process needs to operate on the live AWS account,
  do that via SSM / AWS CLI calls scoped to read-only or explicitly
  authorized operations. Do **not** check any live config snapshot back
  into the repo.
- Same rule for the maintainer's private notes vault: durable notes go to
  that vault (outside this repo), never to this repo's tracked files.
