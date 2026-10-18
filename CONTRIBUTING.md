# Contributing

Solo-maintained project — contributions land slowly. PRs welcome anyway.

## Development setup

Prerequisites:
- Bash 3.2+ (macOS default works)
- Bun 1.3.10+ (the Bun and Postgres tests, typecheck)
- Docker Compose v2
- Terraform 1.6+
- `aws` CLI (for AWS Secrets Manager / Bedrock / S3)
- An AWS account with admin-equivalent permissions (you'll create
  resources, not just read them)

Local-only checks need no AWS account:

```bash
git clone https://github.com/<your-fork>/memrain.git
cd memrain

make test    # bash unit tests (init.sh + audit.sh)
make audit   # PII gate
make lint    # shellcheck if installed
```

### Bun tests

```bash
cd deploy/memrain
bun install --frozen-lockfile # once per checkout, before any Bun command
bun run test:sharded          # the whole suite; the ship gate
bun run test:changed          # only files affected since origin/main
bun test tests/foo.test.ts    # one file while iterating
```

Never run the whole suite as one bare `bun test`: every PGLite instance
keeps its WASM memory, and one process running every file runs out of it.
`test:sharded` runs fixed-size chunks (`SHARD_SIZE`, default 20) in fresh
processes, `JOBS` of them at a time (default half the CPUs, at most 4;
each needs about 1.6 GB). Before the first shard it builds one migrated
database under `$TMPDIR` and points `MEMRAIN_TEST_PGLITE_TEMPLATE` at it, so a
test's new database is a copy instead of a run of every migration. A test
that has to watch migrations run clears that variable for its file (see
`tests/migrate.test.ts`); `TEST_TEMPLATE=0` turns the template off for a
whole run. `test:changed` is for the edit loop only.

CI splits the suite across three runners by the per-file seconds in
`deploy/memrain/tests/.timings.tsv`. A new file counts as the median until it
is listed; refresh the file when the groups drift apart.

### Postgres tests

The Bun suite runs on PGLite, which serializes transactions. Races and
driver-specific behaviour only show up on a real Postgres, so a few tests
read `MEMRAIN_TEST_POSTGRES_URL` and skip without it. To run them:

```bash
make test-pg   # needs docker, bun and `bun install` in deploy/memrain
```

It starts a throwaway `pgvector/pgvector:pg16` container on a free
loopback port, applies every migration to the empty database, applies
them again (the second pass must apply nothing), runs every test file
under `deploy/memrain/tests` that reads `MEMRAIN_TEST_POSTGRES_URL`, and
removes the container whether the run passed or failed.

With `MEMRAIN_TEST_POSTGRES_URL` already set, it uses that database and
starts no container. Point it only at a scratch database: migrations and
tests write to it. A new Postgres-only test needs no registration — read
`MEMRAIN_TEST_POSTGRES_URL` in the file (`describe.skipIf(!url)`) and
`make test-pg` picks it up.

CI runs the same target in the `Postgres tests` job against a service
container; a red run fails the workflow.

## Coding conventions

### Bash

- `#!/usr/bin/env bash` for new scripts.
- `set -euo pipefail` at the top of every script.
- POSIX `[ ... ]` and `[[ ... ]]` are both fine; pick one per file.
- Long-flag form (`--foo`) preferred for readability.
- Atomic writes for state files: `mktemp` → write → `mv -f`.

### Terraform

- Match existing patterns. `var.project_name`, `var.secrets_prefix`,
  conditional `count = var.X != "" ? 1 : 0` — copy, don't invent.
- `lifecycle.ignore_changes = [ami, user_data]` on every EC2 resource —
  protects against accidental replacement.
- Backend stays partial (`backend "s3" {}`) — concrete values go in
  `terraform/backend.hcl` from `make init`.

### Docs

- ASCII diagrams beat Mermaid for source-of-truth files. They render
  in every terminal and never fall behind the code.
- Update `ARCHITECTURE.md` and `CHANGELOG.md` in the same commit as the
  behavior change, not later.
- The `make audit` gate refuses commits with maintainer-private
  identifiers (see `scripts/lib/pii-patterns.txt` for the regex set).
  Local-only matches go in `scripts/lib/pii-patterns.local.txt`
  (gitignored, auto-loaded by the audit script).
- The companion `make scrub-audit` runs a broader pre-publication
  sweep — categorised report, fails on HIGH-severity hits.

## Test policy

- Every new bash script gets a `tests/<name>.test.sh` with at least
  happy-path + one edge case + one error path.
- Terraform changes: `terraform fmt -check`, `terraform validate`, and
  reviewed `terraform plan` output.
- Container changes: `docker compose --env-file .env -f
  deploy/docker-compose.yml config` MUST parse without error.

## Commit conventions

```
<type>: <short summary>

<body, optional>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

Examples:
- `feat(memrain): add code chunkers for TS / Python`
- `fix(bootstrap): retry git clone on transient DNS failure`
- `docs(architecture): document EFS layout`

## Pull request flow

1. Branch from `main`. Naming: `feature/<short>`, `fix/<short>`, etc.
2. Run `make audit && make scrub-audit && make test && terraform -chdir=terraform validate`.
3. Open the PR using the template — describe what changed and why,
   include a `Test plan` checklist.
4. Wait for the maintainer review. No SLA, but no PR is rejected
   without an explanation.

## Required workflow for AI agents

If you are an AI coding agent working in this repo, two steps are
mandatory for **every** change — not just features:

1. **Run the matching review skill/agent** before declaring work done.
   Pick the reviewer by what changed (full table in `CLAUDE.md` →
   "Self-review after each implementation"): e.g. `security-engineer`
   for secrets/auth, `code-reviewer` for logic, `devops-automator` for
   CI/docker/terraform, `technical-writer` for docs. Act on every
   CRITICAL / HIGH finding.
2. **Follow the ship workflow** in `CLAUDE.md` —
   **test → push → deploy → verify**. A change is not shipped until the
   live EC2 runs it and the `/health` + MCP smoke checks pass.

Human contributors run the local gate in step 2 of the PR flow above;
the maintainer runs the agent review on incoming PRs.

## Release process

Releases follow SemVer + Keep a Changelog and ship only after the
change is live and verified:

1. Roll the `[Unreleased]` changelog entries into a dated
   `## [X.Y.Z] — <date>` section, leaving an empty `[Unreleased]`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` — the tag must point at a
   CI-green commit that is already deployed to the EC2.
3. `gh release create vX.Y.Z --title vX.Y.Z --notes "<changelog
   section>"`.

`package.json` versions are intentionally decoupled from the release
tag and are not bumped here.

## Things that will NOT be accepted

- Changes that add unrequested monitoring, dashboards, alarms, or
  notifications (see `CLAUDE.md`).
- Changes that hardcode maintainer-private values (the audit gate
  catches these mechanically).
- Refactors of code that isn't changing — match existing style instead.
- Force-pushes to `main`.
