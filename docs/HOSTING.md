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
| `deploy/tenant/ctl.sh` | One control-plane command (`tenant ...`) in `tenant-ctl`, with the deploy's file set |
| `deploy/tenant/purge-deleted.sh` | Purges tenants whose deletion window passed, and what the host holds of them |
| `deploy/tenant/bedrock-credentials.sh` | Rewrites each tenant's Bedrock credentials before they expire (systemd timer) |
| `deploy/.bedrock/<id>/` | A tenant's short-lived Bedrock credentials, the one directory its container mounts |
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
container reads Secrets Manager. The one mount is the tenant's own Bedrock
credentials directory, `deploy/.bedrock/<id>/`, read-only (see below).

The container's control-plane login (`tenant_<id>_ctl`) is its own, and so is
its connection pool: `tenant_self()` and the spend functions recognise the
tenant by `session_user`. Never put a connection pooler between tenant
containers and `memrain_control` that shares server connections across
tenants (PgBouncer in transaction or statement mode). The per-tenant pooler
below pools the tenant's own database only; control connections always go to
the database directly.

Each tenant container sits on one network, `memrain_tenant_<id>`. That is a
plain bridge, so outbound NAT to the database and Bedrock works. The only other
member of that network is `cloudflared`, which proxies HTTP and does not route
between networks. Containers on different user bridges cannot reach each
other, and the isolation smoke proves that on every start (see below).

## Spend ceiling

Every paid model call of every tenant first reserves its worst case in the
control database (`hosting_reserve`) and settles it afterwards
(`hosting_settle`). A reservation counts against two UTC-day windows: the
install's (`tenant cap --usd`, default $10) and the tenant's own
(`plan_limits.maxUsdPerDay`, else `hosting_settings.default_tenant_day_usd`,
default $5). A reservation that passes its lifetime turns into spend at its full
amount; time never frees one.

The control plane takes no tenant's report on trust. Assume a tenant holds its
own control login, which a compromised container does:

- A settlement books at most `overrun_factor` (default 2) times its
  reservation. Anything reported above that becomes a `hosting_settle_anomaly`
  event in `tenant_events`.
- A cost above the reservation switches paid calls off for that tenant only,
  for the rest of the UTC day, and records a `hosting_overrun` event. The
  install-wide switch belongs to the operator (`tenant cap --llm-off`). It also
  goes on by itself, but only when the install's booked total passes its cap.
- A reservation is never of nothing, lives at most `max_ttl_seconds` (default
  900), and a tenant holds at most `max_open_reservations` (default 8) at once.
- Settled reservations older than `reservation_retention_days` (default 30)
  are pruned.

These bound what a lying tenant can book, not what it spends. A tenant's
container calls Bedrock with its own credentials, so the true cost is known
only to Bedrock. Making the control plane the cost authority would take a
metering gateway in front of Bedrock, which this install does not have.
Customers never hold `_ctl` credentials: those exist only in the tenant's
secrets file, read by its own container.

## Setting up a hosting stack

1. Terraform, with the stack's own state and tfvars. Set
   `enable_hosting = true` and `instance_metadata_hop_limit = 1`. With a hop
   limit of 1 no container can take the instance role. That includes
   `tenant-ctl` and the tenant containers, which then have no AWS credentials
   at all. Size the database with `rds_instance_class`, and set
   `db_name = "memrain_control"` so the instance starts with the control
   database. Run `terraform plan`, review it, then apply.

   Two pieces need operator setup that this repo does not apply:
   - **Bedrock for tenants.** The host gives each tenant short-lived,
     Bedrock-only credentials (next section). That needs an IAM role the
     instance role may assume, allowed to invoke Bedrock models and nothing
     else; it is not in terraform yet. Until it exists and
     `MEMRAIN_TENANT_BEDROCK_ROLE_ARN` is set, a tenant has no Bedrock, and its
     paid calls stay off (`MEMRAIN_TENANT_DAILY_BUDGET_USD=0`). The smoke checks
     only that Bedrock's endpoint is reachable, not that a call succeeds.
   - **Writing a tenant's secrets to Secrets Manager.** The instance role may
     write only the public bearer secret, and `tenant-ctl` has no credentials
     under a hop limit of 1. Until a write path exists, provision with the
     `file` secrets backend on the host (below).
2. Put the control admin URL (master role, database `memrain_control`) into
   `<prefix>/hosting/control-admin-url`.
3. On the host, run `bash deploy/secrets/fetch-secrets.sh --control`, and the
   default `fetch-secrets.sh` run for the cloudflared tunnel token.
4. Create the directory provisioning writes secrets to, owned by the image
   user: `install -d -m 0700 -o 1000 -g 1000 deploy/.secrets/provisioned`.
   `tenant-ctl` mounts it at `/provisioned` and names it in
   `MEMRAIN_TENANT_SECRETS_DIR`.
5. Build the image and migrate the control database:
   `bash deploy/tenant/ctl.sh --build tenant migrate-control`.

`deploy/tenant/ctl.sh` runs one control-plane command in the one-shot
`tenant-ctl` container, with the same file set as the deploy. It runs the
image the tenant containers run. Until a tenant runs there is none to take,
so add `--build`: it builds the image stamped with `git describe`, as a deploy
does.

## Bedrock credentials for tenants

A tenant container cannot use the instance role, so the host hands each one
credentials of its own. `deploy/tenant/bedrock-credentials.sh`, run as root
every five minutes by `memrain-tenant-bedrock-credentials.timer`, goes through
`deploy/tenants/*.yml`. For each tenant whose file is missing or expires within
20 minutes, it assumes `MEMRAIN_TENANT_BEDROCK_ROLE_ARN` (host `.env`) in a
session named `memrain-tenant-<id>`. A session policy narrows that session to
invoking Bedrock models. The script writes the result to
`deploy/.bedrock/<id>/credentials.json` (0440, group 1000, renamed into place).

The container mounts only `deploy/.bedrock/<id>/`, read-only, at
`/run/memrain-bedrock`, and `MEMRAIN_BEDROCK_CREDENTIALS_FILE` names the file.
The SDK reads it again whenever the credentials it holds are within five
minutes of expiring, so a rewrite needs no restart. When the refresher fails,
it keeps the old file and exits non-zero. Once that file expires, the tenant's
paid calls fail at once with an error naming the file; nothing hangs. The
isolation smoke fails a container that mounts any other tenant's directory.

Install the units once on the host:

```
install -m 644 deploy/tenant/memrain-tenant-bedrock-credentials.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now memrain-tenant-bedrock-credentials.timer
```

## Adding a tenant

1. Add the id to `hosting_tenants`, then plan and apply. This creates the three
   empty secrets under `<prefix>/tenants/<id>/`.
2. `bash deploy/tenant/ctl.sh tenant create <id> --host <hostname>
   --invite-out /provisioned/<id>.invite` (add `--build` before `tenant` for
   the first tenant). It creates the database, roles and secrets, migrates and
   creates the owner's invitation. The one-time invite link lands in
   `deploy/.secrets/provisioned/<id>.invite`, mode 0600. Until there is a write
   path to Secrets Manager (see above), it writes the secrets with the `file`
   backend into `deploy/.secrets/provisioned/<id>/`, so step 4 runs with
   `TENANT_SECRETS_BACKEND=file TENANT_SECRETS_DIR=deploy/.secrets/provisioned`.
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

## Deleting a tenant

1. `bash deploy/tenant/ctl.sh tenant delete <id> --confirm <id> --out
   /provisioned/exports/<id>`. It closes the tenant's database to every
   writer at the database itself, exports it under that fence, checks the copy
   table by table, and records the receipt and a seven-day window in one
   transaction. It prints the export's path (on the host,
   `deploy/.secrets/provisioned/exports/<id>`) and its SHA-256.
2. Copy the export off the host within the window and check its SHA-256. It
   is the customer's data; the host keeps it only until the purge. Copy it,
   do not move or open it in place: the purge checks the host copy against its
   receipt and skips a tenant whose export is missing or changed.
3. If the delete stopped half-way, run it again with `--resume`. It finishes
   under the fence it already holds; on a scheduled delete it checks the
   receipt against the files again.
4. `tenant resume <id>` within the window cancels the delete. The fence id
   changes, so the old receipt no longer counts.
5. After the window, `bash deploy/tenant/purge-deleted.sh`. It drops the
   database and roles and removes the tenant's secrets and every export copy
   on the host. It then removes the container, the rendered file, the secrets
   file, the Bedrock credentials and the network of every tenant whose purge
   has completed, so a run that stopped half-way is finished by the next. With `--secrets aws` the
   secrets get a tombstone value instead, and the output reminds you to drop
   the id from `hosting_tenants` and apply, which deletes the secrets.

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

## Connection pooler (off)

Each tenant container holds up to `MEMRAIN_PG_POOL_MAX` (4) connections to its
database, idle ones included. With many tenants on a small database, a
PgBouncer per tenant lets those idle connections go: `pgbouncer-<id>` runs in
transaction mode on the tenant's own network, serves that tenant's database
only, and publishes no port. The image is `deploy/pgbouncer` (PgBouncer
1.24.0, built locally; the build fails below 1.21).

It is off. To turn it on for every tenant, set in the host `.env`:

```
MEMRAIN_TENANT_PG_POOLER=pgbouncer
COMPOSE_PROFILES=pooler
```

then run `bash deploy/secrets/fetch-secrets.sh --tenant <id>` for each tenant
and `bash deploy/deploy.sh`. The tenant env file then points
`MEMRAIN_POSTGRES_URL` at `pgbouncer-<id>:6432` and adds
`MEMRAIN_POSTGRES_DIRECT_URL` (migrations and DDL, and the pooler's own
upstream) and `MEMRAIN_PG_POOLER=pgbouncer`; the control URL is unchanged.
The deploy starts each pooler before its tenant container, and the isolation
smoke probes every neighbour's pooler as well. `MEMRAIN_PGBOUNCER_SERVER_SSLMODE`
(default `require`) and `MEMRAIN_PGBOUNCER_POOL_SIZE` (default 3 server
connections per tenant) tune it.

In pooler mode the brain sends no session settings at connect, so the
tenant's `statement_timeout` and `idle_in_transaction_session_timeout` come
from its database role (provisioning sets both); `memrain doctor` fails
`db-connection-budget` when either reads 0 through the pool. Session-scoped
SQL (session advisory locks, `LISTEN`, a bare `SET`, temp tables without
`ON COMMIT DROP`, `WITH HOLD` cursors, `DISCARD`) is refused by `make audit`.
`TEST_PG_POOLER=1 make test-pg` runs the Postgres suite through the same
image, with `TEST_PG_PREPARE=0|1` for both prepared-statement modes; the few
files that need their own session are listed with reasons in
`deploy/memrain/tests/pooler-direct-only.txt`.

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

The deploy runs the smoke after each tenant. Every other start of a tenant
container needs one too, and nothing runs it automatically. That covers a host
reboot, `docker restart` and a Docker upgrade. It also covers a crash or an
out-of-memory kill at `MEMRAIN_TENANT_MEM_LIMIT`: Docker restarts the container
(`restart: unless-stopped`), and the tenant then answers 503
`isolation_unverified` until a smoke passes. After any of these, run
`bash deploy/tenant/smoke-all.sh`. It smokes every running tenant and lists the
failures. A tenant that answers 503 `isolation_unverified` while its container
is up has restarted since its last smoke: check
`docker inspect memrain-<id> --format '{{.State.StartedAt}} {{.RestartCount}} {{.State.OOMKilled}}'`.

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

## Scale

`bash scripts/scale-bench.sh` starts its own Postgres (`pgvector/pgvector:0.8.6-pg16`,
4 CPUs, 4 GiB, `max_connections=200`) and runs `memrain bench scale` against it. The
bench builds synthetic brains from a seed (the same seed always gives the same chunks
and vectors). It spends nothing on models, and it writes the JSON report named by
`SCALE_BENCH_OUT`. The report holds the seed, the parameters, the hardware, the peak
Postgres connections and every percentile. It measures three scenarios:

- one brain at 100k chunks: keyword and hybrid p95 at 4 parallel queries, against
  the targets 300 ms and 800 ms;
- the same brain right after a Postgres restart: the first 20 queries against the
  same 20 once warm;
- 8 brains of 12.5k chunks, each with a tenant container's pool of 4, all queried at
  once: it passes only with no connection error and no search missing an arm. The
  script runs this scenario a second time through the hosting PgBouncer image
  (`deploy/pgbouncer`, its own entrypoint and config) with the engines in pooler
  mode, as a hosted tenant connects.

Each mode runs a fixed query mix, 50 warmup queries and then 3 runs of 200. p95 is
nearest-rank over the 600 samples, and the report keeps each run's p95 so the run
spread is visible. The bench writes only into `memrain_bench_<random>` databases it
created and marked with a nonce, and it drops them at the end. It refuses the server
of any production URL in its environment, even with `--scratch`.

One run on Docker Desktop on an arm64 laptop (seed 1):

| Scenario | Result |
|---|---|
| 100k chunks, keyword | p50 46 ms, p95 123 ms (runs 126 / 121 / 121), p99 163 ms: under 300 ms |
| 100k chunks, hybrid | p50 519 ms, p95 713 ms (runs 799 / 605 / 598), p99 809 ms: under 800 ms, with little margin |
| Cold start (one query at a time) | p95 241 ms cold against 222 ms warm (1.1×); first query 577 ms |
| 8 brains at once, direct | 0 connection errors, 0 failed arms, 42 connections at peak; hybrid p95 1.11 s |
| 8 brains at once, through PgBouncer | 0 connection errors, 0 failed arms, 39 connections at peak; hybrid p95 1.12 s |
| Load | 100k chunks in 39 s, HNSW index in 50 s |

Other runs on the same laptop gave hybrid p95 659–779 ms and a cold/warm ratio of
1.1–1.6, and one run of 200 queries reached 799 ms on its own, so expect 15–25%
between runs. The cold ratio stays under 2×, so HNSW prewarm is not worth building.
With 8 brains at once, 32 hybrid queries share 4 CPUs. The latency shown there comes
from CPU saturation, not connections, and the pooler adds none that shows.

These are laptop numbers. Docker Desktop has a faster disk and more memory than a
small RDS instance. Run the bench once on the hosting stack before quoting a number
to a customer.
