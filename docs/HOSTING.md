# Hosting: several brains on one host

A hosting host runs one Memrain brain per tenant. Each tenant has its own
Postgres database, its own role, its own secrets and its own container on its
own Docker network. A small control database (`memrain_control`) holds the
tenant list, status, limits and the shared spend ceiling. A tenant container
reaches it only through three functions that can see that tenant alone.

None of this touches a single-tenant install. Hosting mode is on only in a
container that has `MEMRAIN_TENANT_ID` or `MEMRAIN_CONTROL_URL`
([CONFIGURATION.md](CONFIGURATION.md)). A host runs hosting containers only
when `deploy/tenants/*.yml` exists. Without both, every code path and
`deploy/deploy.sh` behave as before.

A hosting host runs no single-tenant brain. Keep yours on its own stack. The
standard bootstrap starts the single-tenant service, so stop it on a hosting
host (`docker compose --env-file .env stop memrain`). The tenant deploy refuses
to run while `deploy-memrain-1` is running.

## Layout

| Path | What it is |
|---|---|
| `deploy/tenant/compose.hosting.yml` | Base of the hosting compose set: the image, the one-shot `tenant-ctl` CLI container and `cloudflared` |
| `deploy/tenant/tenant.yml.tmpl` | Template of one tenant's container, network and cloudflared attachment |
| `deploy/tenants/<id>.yml` | A tenant's rendered file (not tracked; `scripts/tenant-render.sh`) |
| `deploy/.secrets/tenants/<id>.env` | A tenant's database URL, control URL and internal token, 0400 (`fetch-secrets.sh --tenant`) |
| `deploy/.secrets/hosting-control.env` | The control admin URL, for `tenant-ctl` only (`fetch-secrets.sh --control`) |
| `deploy/.secrets/provisioned/<id>/` | Secrets provisioning wrote with the `file` backend (mounted into `tenant-ctl` only) |
| `deploy/tenant/deploy-tenants.sh` | The per-tenant deploy; `deploy/deploy.sh` hands over to it |
| `scripts/tenant-isolation-smoke.sh` | The isolation smoke for one tenant container |
| `deploy/tenant/smoke-all.sh` | The smoke for every running tenant (after a reboot) |
| `scripts/tenant-rss-bench.sh` | The memory bench behind `MEMRAIN_TENANT_MEM_LIMIT` |

Every compose call on a hosting host goes through these scripts, which load
the base file plus every tenant file. A compose command that names only some
of them would treat the other tenants' containers as orphans.

## What a tenant container gets

The template sets the hosting environment. Nothing in it is a secret:

- `MEMRAIN_TENANT_ID=<id>` and `MEMRAIN_PUBLIC_URL=https://<hostname>`
- `MEMRAIN_PUBLIC_AUTH=oauth`: there is no static public bearer, and a missing
  credential gets 401.
- `MEMRAIN_ASSUME_PUBLIC=1`: every request is treated as public, so a tenant
  host has no internal path at all.
- `MEMRAIN_APP=1`, `MEMRAIN_REQUIRE_MEMBER=1`, `MEMRAIN_TENANT_FAIL_CLOSED=1`,
  `MEMRAIN_REQUIRE_POSTGRES=1`
- `MEMRAIN_PG_POOL_MAX=4` and `MEMRAIN_PG_APPLICATION_NAME=memrain:<id>:serve`
- `MEMRAIN_DAILY_BUDGET_USD` from the host's `MEMRAIN_TENANT_DAILY_BUDGET_USD`
  (default `0`, which refuses every paid call). This is the second rail under
  the control plane's ceiling.
- `MEMRAIN_HOSTING_LLM_OFF` from the host, one switch for every tenant.
- No admin bootstrap. The operator works through the CLI.
- `mem_limit` from `MEMRAIN_TENANT_MEM_LIMIT`; all capabilities dropped; the
  image is never pulled.

The secrets come from the tenant's own `.secrets/tenants/<id>.env`. No
container mounts a secrets directory or AWS configuration, and no tenant
container reads Secrets Manager.

Each tenant container sits on one network, `memrain_tenant_<id>`. That is a
plain bridge, so outbound NAT to the database and Bedrock works. The only other
member of that network is `cloudflared`, which proxies HTTP and does not route
between networks. Containers on different user bridges cannot reach each
other, and the isolation smoke proves that on every start (see below).

## Setting up a hosting stack

1. Terraform, with the stack's own state and tfvars. Set
   `enable_hosting = true` and `instance_metadata_hop_limit = 1`. With a hop
   limit of 1 no container can take the instance role. That includes
   `tenant-ctl` and the tenant containers, which then have no AWS credentials
   at all. Size the database with `rds_instance_class`. Run `terraform plan`,
   review it, then apply.

   Two pieces are not built yet:
   - **Bedrock for tenants.** A tenant container needs its own Bedrock-only
     credential, which the host puts into its secrets file. Until then a
     tenant has no Bedrock, and its paid calls stay off
     (`MEMRAIN_TENANT_DAILY_BUDGET_USD=0`). The smoke checks only that
     Bedrock's endpoint is reachable, not that a call succeeds.
   - **Writing a tenant's secrets to Secrets Manager.** The instance role may
     write only the public bearer secret, and `tenant-ctl` has no credentials
     under a hop limit of 1. Until a write path exists, provision with the
     `file` secrets backend on the host (below).
2. Put the control admin URL (master role, database `memrain_control`) into
   `<prefix>/hosting/control-admin-url`.
3. On the host, run `bash deploy/secrets/fetch-secrets.sh --control`, and the
   default `fetch-secrets.sh` run for the cloudflared tunnel token.

## Adding a tenant

1. Add the id to `hosting_tenants`, then plan and apply. This creates the three
   empty secrets under `<prefix>/tenants/<id>/`.
2. `memrain tenant create <id> --host <hostname>`, from the `tenant-ctl`
   container. It creates the database, roles and secrets, migrates and creates
   the owner's invitation. Until there is a write path to Secrets Manager (see
   above), it writes the secrets with the `file` backend.
   `tenant-ctl` mounts `deploy/.secrets/provisioned` at `/provisioned` and
   names that directory in `MEMRAIN_TENANT_SECRETS_DIR`. Before the first
   tenant, create it for the image user:
   `install -d -m 0700 -o 1000 -g 1000 deploy/.secrets/provisioned`. Step 4
   then runs with `TENANT_SECRETS_BACKEND=file
   TENANT_SECRETS_DIR=deploy/.secrets/provisioned`.
3. `bash scripts/tenant-render.sh <id> --host <hostname>` writes
   `deploy/tenants/<id>.yml`.
4. `bash deploy/secrets/fetch-secrets.sh --tenant <id>`. It refuses a missing
   secret and an internal token that another tenant already holds. It also
   refuses a URL that is not this tenant's: the database URL must use the
   role `tenant_<id>_owner` on the database `tenant_<id>`, and the control URL
   the role `tenant_<id>_ctl` on `memrain_control`. A hyphen in the id may
   appear as an underscore, and percent-encoded names are decoded first.
5. Route `<hostname>` in the tunnel to `http://memrain-<id>:18790`.
6. `bash deploy/deploy.sh`.

On a stack without Secrets Manager, set `TENANT_SECRETS_BACKEND=file` and
`TENANT_SECRETS_DIR=<dir>`. `fetch-secrets.sh` then reads
`<dir>/<id>/{postgres-url,control-url,internal-token}` and
`<dir>/_hosting/control-admin-url`. Each must be a regular file that only its
owner can read.

## Deploying

`bash deploy/deploy.sh` from the repo root, after `git pull --ff-only`. On a
hosting host it:

1. Checks that the compose set parses.
2. Builds the image once, stamped with `git describe`.
3. Migrates the control database. If that fails, no tenant is touched.
4. Lists every tenant except `deleting` and `deleted`. Suspended tenants are
   included, so their schema never falls behind.
5. Handles one tenant at a time, in id order: migrate its database, recreate
   its container, wait for healthy, check the stamp, run the isolation smoke
   and record it. A `provisioning` tenant without a rendered file is migrated
   only.
6. Recreates `cloudflared` if a new tenant network appeared.

The first failure stops the loop. Tenants already done stay on the new
version, the rest stay on the old one, and nothing is rolled back. The report
is printed and kept in `deploy/tenants/.deploy-report`. Fix the cause and run
the deploy again.

## Isolation smoke

A tenant container answers `503 isolation_unverified` to everything but
`/health` until the control plane holds a smoke pass newer than the
container's start, from the same host boot and image. A skipped or failed
smoke therefore leaves the tenant closed, not open.

`bash scripts/tenant-isolation-smoke.sh <id>` checks:

- **On the host:** the container runs, sits on its own network only, and has
  nothing from `.secrets` or `.aws` mounted.
- **Inside the container:** its database and
  `bedrock-runtime.<region>.amazonaws.com:443` answer. No other tenant
  container answers, by name or by IP. The instance metadata service does not
  answer. Reading any other tenant's three secrets, or the control admin URL,
  fails, either because there are no credentials or with `AccessDenied`.

A pass is recorded with `memrain tenant smoke-record <id>`. `--no-record`
checks without recording.

The deploy runs the smoke after each tenant. After a host reboot,
`docker restart` or a Docker upgrade, run `bash deploy/tenant/smoke-all.sh`.
It smokes every running tenant and lists the failures.

## Memory

`bash scripts/tenant-rss-bench.sh --image memrain-hosting:<tag>` starts three
brains, each on its own throwaway database. Each brain gets 2000 pages of five
sections, then five minutes of mixed load (search, page_get, page_put). The
script prints p50, p95 and maximum RSS per brain, the suggested
`MEMRAIN_TENANT_MEM_LIMIT` (1.5 × the worst p95) and how many tenants fit the
host. The bench runs keyword-only, without Bedrock. Run it again after a
release that changes memory use.

A run on Docker Desktop (three brains at the server's limit of about 10
requests a second each, no errors) measured a steady-state p95 RSS of 85–91 MiB
per brain and 12 Postgres connections in total. That points to a 192m limit.
The template keeps 1024m anyway: the bench never runs the maintenance cycle or
embeddings, and a cycle phase has reached several GB on a single-tenant brain.
Lower `MEMRAIN_TENANT_MEM_LIMIT` only after a bench on the hosting instance
that includes a cycle.
