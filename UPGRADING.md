# Upgrading to Memrain 1.0

This page is only for people who already run a release from before Memrain 1.0,
under the project's old name. It moves that install to 1.0 and keeps your
data. Installing for the first time? You do not need this page: start with
[docs/QUICKSTART.md](./docs/QUICKSTART.md), and read
[docs/HOW-IT-WORKS.md](./docs/HOW-IT-WORKS.md) to see how Memrain works.

Memrain was called memex before 1.0.0. This guide takes an install of a
pre-rename release (tags `memex-v1.x`) to Memrain 1.0.x without losing data.
Clients need no change: the URL, the OAuth issuer, the public bearer, PATs,
OAuth clients and refresh tokens all keep working.

Read the whole guide before you start. Steps 0 to 11 prepare the host with the
app stopped. Steps 12 to 14 are the **upgrade window**: the new release starts
in maintenance mode, you check it, and then you either reopen the service or
roll back. A rollback exists **only inside that window, before the service
reopens**. After you reopen there is no rollback to the old version, only
fixes forward on 1.0.x.

The paths below assume the default project name, so the old layout is
`/opt/memex`, `/mnt/memex-efs` and `/var/log/memex`. Substitute your own names
if you changed them. `example.com` stands for your domain.

## Before you start

- You need shell access to the host (SSM or SSH), the AWS CLI with access to
  the stack's secrets, `terraform` for the stack, `jq` and a `psql` client
  that reaches the database (for example from the `postgres:16` image).
- Plan for downtime: the service is stopped from step 3 until step 14.
- Do not run `memrain config set`, write pages, or create tokens or OAuth
  clients between step 12 and step 14. The window must stay free of writes so
  that a rollback is exact.

## 0. Pin the Terraform names (before pulling the new code)

Memrain 1.0 changes the Terraform defaults (`project_name`, `app_slug`,
`secrets_prefix`, `db_name`, `db_username` and the secret names). Most AWS
names are ForceNew, so an unpinned install would plan to replace its database
secrets and subnet group, and to rename the RDS instance in place. Pin every
name to its current value first. In `terraform/terraform.tfvars`, add the
stack's **current** values (`<p>` is usually `memex`):

- `project_name = "<p>"`, `app_slug = "memex"`, `secrets_prefix = "<p>"`,
  `db_name = "memex"`, `db_username = "memex"`,
  `efs_creation_token = "<p>-data"`;
- all 22 name variables at their current values (`rds_identifier`,
  `db_subnet_group_name`, `db_parameter_group_name`, the four security group
  names, the IAM role, instance profile and policy names, the log group, SNS
  topic, bucket, trail and key pair names, and the five secret names such as
  `postgres_url_secret_name = "<p>/memex-postgres-url"`); see "Resource name
  variables" in [docs/CONFIGURATION.md](docs/CONFIGURATION.md);
- `subdomain = "<your old memex_subdomain>"`, and remove `memex_subdomain`.

Keep the backend key as it is. Check every value against
`terraform state show <address>`.

Then check out the new release in the directory you run Terraform from and
run `terraform plan`. **Gate:** the plan may show only

- `has moved to` lines (resource addresses renamed through `moved` blocks),
- at most one in-place update of `aws_s3_object.bootstrap_script` (its etag),
- exactly one in-place update of the EC2 security group whose only change is
  the description of the Postgres (5432) egress rule,
- output changes.

It must say **0 to add, 0 to destroy**, and nothing may be replaced. Anything
else: stop and fix the pins. Terraform sets `prevent_destroy` on the database,
file system, instance, IP address, secrets and buckets, so a plan that would
destroy one of them fails before apply; an in-place rename such as a changed
`rds_identifier` is not caught that way, which is why you read the plan.

Apply this plan only while the stack is stopped (after step 3): the security
group update revokes and re-authorizes the Postgres egress rule.

The pins are the permanent supported configuration, also after 1.1.0.

- **Secret names cannot be changed by editing tfvars.** A new secret name is a
  replacement, which `prevent_destroy` refuses. Keep legacy-named secrets with
  the pins, plus the four `*_SECRET_NAME` keys in `.env` (step 17).
- **Never rename, re-create or delete a stack secret by hand.** Terraform
  would lose track of it, and the rotation permission in IAM is scoped to the
  pinned bearer name, so a hand-made copy silently breaks rotation.
- Flipping the other names later is optional. Before you flip
  `db_parameter_group_name` (which replaces the parameter group), compare
  `aws rds describe-db-parameters --db-parameter-group-name <current> --source user`
  with the `parameter` blocks in `terraform/rds.tf`, and move every extra
  parameter into code first. After the flip, the same command on the new group
  must list the same name/value pairs.

## 1. Back up

These backups are a disaster net. No planned step restores from them.

- A database snapshot or dump.
- A tar of `$EFS_MOUNT/memex`, the config directory the app mounts
  (`EFS_MOUNT` as set in the old `.env`), plus any `caddy-*` directories.
- `.env`, `deploy/.secrets/` (the old release reads `.secrets/memex.env`;
  1.0.x never writes that file), `/etc/stack-env`, `/etc/fstab`,
  `/etc/systemd/system/memex-*` and `/etc/<project>/`.

A tar of a running PGLite directory is not consistent. A PGLite install takes
its exact copy in step 12, after the stop.

## 2. Record the baseline

```bash
docker exec deploy-memex-1 bun run src/cli.ts status        # note stats.pages
systemctl list-unit-files 'memex-*.timer'     # note which timers are enabled
```

**PGLite install:** skip the `status` call. `serve` holds the PGLite data
directory, so `status` cannot open it next to the running server, and
`deploy.sh` has no page gate on PGLite.

## 3. Stop everything with the OLD checkout

Run these from the old checkout, with the old compose file:

```bash
sudo systemctl disable --now memex-eval-probe.timer memex-rotate-bearer.timer
docker compose --env-file .env stop
docker compose --env-file .env rm -f
docker ps          # must show no deploy-* container
```

Compose finds the files through the `COMPOSE_FILE` line in `.env`; an install
bootstrapped before that line existed needs `-f deploy/docker-compose.yml`
(plus its ingress overlay, if any). Do not use `down -v` or
`--remove-orphans`. Apply the step 0 plan now if you have not done so.

## 4. Move the mount point

```bash
sudo umount /mnt/memex-efs
sudo mkdir -p /mnt/memrain-efs
sudo sed -i 's#/mnt/memex-efs #/mnt/memrain-efs #' /etc/fstab
sudo systemctl daemon-reload
sudo mount -a -t efs
mountpoint -q /mnt/memrain-efs && echo mounted
```

The mount unit is now `mnt-memrain\x2defs.mount`.

## 5. Move the directories (same filesystem only)

Every move is a `mv` inside one filesystem, so nothing is copied and nothing
can be half-written. Check that each target does not exist yet before you
move:

```bash
cd /mnt/memrain-efs
test ! -e memrain && sudo mv memex memrain                    # the data dir
test ! -e memrain/memrain && sudo mv memrain/memex memrain/memrain   # the config dir the app mounts
test ! -e memrain-repo && sudo mv memex-repo memrain-repo     # the code-index clone
test ! -e /opt/memrain && sudo mv /opt/memex /opt/memrain
test ! -e /var/log/memrain && sudo mv /var/log/memex /var/log/memrain
test ! -e /etc/memrain && sudo mv /etc/memex /etc/memrain     # caddy installs only
```

Then confirm the operator config arrived intact:
`test -f /mnt/memrain-efs/memrain/memrain/config.json` and `cmp` it against the
step 1 backup.

The new compose file binds every host directory with
`create_host_path: false`. A directory that was not moved makes the start fail
instead of mounting a fresh empty directory where your data was expected.

## 6. `/etc/stack-env`

Set `STACK_PROJECT=memrain`. Add `STACK_SUBDOMAIN=<the value of
STACK_MEMEX_SUBDOMAIN>` and keep the old key. Leave `STACK_SECRETS_PREFIX`
unchanged.

## 7. `.env`, in this order

1. Rename `MEMEX_SUBDOMAIN` to `SUBDOMAIN` and `MEMEX_HOST` to `PUBLIC_HOST`.
   Do this first: `MEMRAIN_HOST` is the address the server binds to inside the
   container, not the public host.
2. `sed -i 's/^MEMEX_/MEMRAIN_/' .env` (the values stay).
3. Update the path keys (`EFS_MOUNT`, `EFS_REPO`, `REPO_DIR`) and
   `COMPOSE_FILE` to the new paths.
4. On a Postgres install, add `MEMRAIN_REQUIRE_POSTGRES=1`.
5. Leave `SECRETS_PREFIX`, `AWS_*` and `DOMAIN` unchanged.

Do not re-run bootstrap over a `.env` you edited by hand. On 1.0.x renaming the
keys is optional, because the old names are still read. It is **mandatory
before 1.1.0** (step 17).

## 8. Check out the new release

List your local-only tags first (the prune deletes them), then:

```bash
git fetch --prune --prune-tags --force origin
git checkout <release>          # e.g. v1.0.0
```

Do this in `/opt/memrain` **and** in the code-index clone
(`/mnt/memrain-efs/memrain-repo`). The releases before the rename are kept as
`memex-v1.x` tags.

## 9. Caddy installs only

Edit `/etc/memrain/compose.caddy.yml`: update the paths, and change
`memex:` to `memrain:` under `depends_on`. `deploy.sh` refuses an overlay that
still names the old service and prints the `sed` to fix it. The Caddyfile's
`memex:18790` keeps working in 1.0.x through the network alias.

## 10. Fetch the secrets

```bash
bash deploy/secrets/fetch-secrets.sh
grep -c '^MEMRAIN_POSTGRES_URL=postgres' deploy/.secrets/memrain.env   # must print 1
```

On a tunnel install, `deploy/.secrets/cloudflared.env` must be non-empty. A
non-zero exit leaves every file in `deploy/.secrets/` as it was: fix the cause
(usually IAM) and run it again. If your secrets keep names other than
`<prefix>/memrain-*` or `<prefix>/memex-*`, set the matching `*_SECRET_NAME`
keys in `.env` first (full secret ids; see "Secret names" in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md)).

## 11. systemd units

Install the `memrain-*` units from `deploy/systemd/`, remove the `memex-*`
units, and run `systemctl daemon-reload`. Do not enable any timer yet: the
eval probe writes to the database and the bearer rotation changes a secret,
and the window must stay free of both. Step 14.A enables them after the
reopen.

## 12. Start the new release in maintenance (the window opens)

1. **Baseline.** With the stack still stopped, take the baseline `B` of the
   untouched database:

   ```bash
   psql "$URL" -X -A -t -q -v ON_ERROR_STOP=1 \
     -f deploy/memrain/scripts/sql/data-manifest.sql > B.txt
   ```

   The script is read-only and never runs migrations; `$URL` is the Postgres
   URL from `deploy/.secrets/memrain.env`. **PGLite install:** psql cannot
   read a PGLite directory. Instead, `cp -a` the stopped data directory to a
   sibling path. That cold copy is the baseline and the rollback source.
2. Set `MEMRAIN_MAINTENANCE=1` in `.env`. The server then starts no background
   work (code sweep, jobs worker, cycle, token sweep). `deploy.sh` stops the
   ingress before the new app starts and does not start it again.
3. Deploy:

   ```bash
   DEPLOY_MIN_PAGES=<stats.pages from step 2> bash deploy/deploy.sh
   ```

   It must pass every gate and end with `HELD: maintenance on; ingress not
   started`. `deploy.sh` requires `db=postgres` and at least
   `DEPLOY_MIN_PAGES` pages, and stops the app otherwise. With no ingress,
   nothing outside can write.

   **PGLite install:** run `DEPLOY_ALLOW_PGLITE=1 bash deploy/deploy.sh`,
   without `DEPLOY_MIN_PAGES`. `status` cannot run next to `serve` on PGLite,
   so `deploy.sh` skips the page and OAuth gates there and refuses a page
   floor it cannot check.

## 13. Check inside the window

1. `docker exec deploy-memrain-1 bun run src/cli.ts status --quiescent` exits 0.
2. Take `P`, the same script against the running database
   (`> P.txt`), and compare. The filtered diff must exit 0:

   ```bash
   X=$'^(table\tmigrations\t|function\tmemrain_fact_|trigger\tentity_facts\\.entity_facts_withdrawn_on_insert\t)'
   diff <(grep -Ev "$X" B.txt) <(grep -Ev "$X" P.txt)
   ```

   The plain `diff B.txt P.txt` shows only migration 120's lines: the
   `migrations` table line, the two added `memrain_fact_*` functions and the
   changed `entity_facts_withdrawn_on_insert` trigger.
3. A failed `deploy.sh` gate or check → roll back (step 14.B). **Any other
   difference in the manifest diff → stop and investigate before you do
   anything else.** Something wrote during the window, and a rollback would
   no longer restore the baseline exactly.

**PGLite install:** skip 1 and 2. `status` cannot open the data directory
while `serve` holds it, and psql cannot read PGLite, so a PGLite install has
no in-window data check: the health and stamp gates of step 12 decide. A
rollback restores the step 12 cold copy, which is exact whatever happened in
the window.

## 14. Reopen or roll back

Decide once, inside the window.

**A. Reopen** (every gate green):

1. Remove `MEMRAIN_MAINTENANCE` from `.env` and run `bash deploy/deploy.sh`
   again (with `DEPLOY_ALLOW_PGLITE=1` on a PGLite install). It must end
   `OK: … db=<engine>, pages=N, ingress up` (`db=postgres` on a Postgres
   install; `pages=n/a` on PGLite).
2. Verify: `/health`; the OAuth discovery issuer is unchanged; an MCP call
   with an existing token and one with an existing PAT work; an OAuth refresh
   works.
3. Re-enable only the timers that were enabled in step 2, under their
   `memrain-*` names, and **never** a rotation timer that was disabled.
4. `docker rm deploy-memex-1` if it still exists (keep its image).

From here on there is **no rollback to the old version**. Problems are fixed
forward on 1.0.x; the step 1 backups are for a disaster restore only.

**B. Roll back** (a gate is red and the manifest diff is clean; only before A):

1. Stop the app and confirm that no other client session is open on the
   database.
2. Run the down migration from a one-off container of the new image:

   ```bash
   docker compose --env-file .env run --rm --no-deps --entrypoint bun memrain \
     run src/cli.ts apply-migrations --down 120 --yes
   ```

   If the new image also applied migration 121 (eval snapshot status), run
   `apply-migrations --down 121 --yes` first: each down only reverts the
   latest migration.

   `memrain eval gate` now scores distinct pages and keeps queries with no
   expected paths out of the averages. A baseline written before that is not
   judged against: the gate reports `scoring_changed` and asks for a new one
   (`memrain eval gate --write-baseline`).

   (or apply
   `deploy/memrain/src/core/migrations-down/120_memrain_rename.down.sql` with
   `psql -1 -f`). It refuses, and changes nothing, if 120 is not the latest
   migration, another session is open, or a page already carries a `memrain:`
   fence. **PGLite install:** skip 2 and 3; with the app stopped, put the
   step 12 copy of the data directory back in place of the current one.
3. Take `A`, the same script now. `diff B.txt A.txt` must exit 0 with no
   difference at all: the database is byte-identical to the baseline.
4. Stop the stack, reverse steps 5 and 4, restore the step 1 configuration
   backups **including `deploy/.secrets/`** and the `memex-*` units (never the
   data tar), remove the `memrain-*` units, run `systemctl daemon-reload`,
   check out the previous release (its `memex-v…` tag) and run its
   `deploy.sh`. Then re-enable the timers that were enabled in step 2.

## 15. What never changes

The URL and OAuth issuer, the public bearer, PATs, OAuth clients and refresh
tokens, `memex:` fence markers stored in pages, fact ids and embeddings, the
database master user, and existing `MEMEX_*` rows in `runtime_config`.

## 16. Clients

Nothing is required. Renaming a connector's display name is optional.

## 17. Before taking 1.1.0

1.1.0 removes the old configuration names and **refuses to start** while any
of them is still in use; it never ignores one. Upgrading straight from a
pre-rename release to 1.1.0 is not supported: pass through 1.0.x. On 1.0.x,
`memrain doctor` must show no legacy-name warning, which means:

- `.env` uses `MEMRAIN_*` keys only;
- no legacy-only `runtime_config` row: `memrain doctor` names each `MEMEX_*`
  row that has no `MEMRAIN_*` row; run `memrain config set <KEY> <value>` for
  it, which stores the `MEMRAIN_` name;
- the config directory is `~/.memrain`, and `config.json` embeds no
  `/home/bun/.memex/` paths;
- ingest clients send `x-memrain-*` headers;
- the secrets exist under `<prefix>/memrain-*`, **or** the four `.env` keys
  `POSTGRES_URL_SECRET_NAME`, `PUBLIC_BEARER_SECRET_NAME`,
  `INTERNAL_TOKEN_SECRET_NAME` and `TUNNEL_TOKEN_SECRET_NAME` name the ids you
  keep (these keys stay supported in 1.1.0);
- tunnel and proxy origins point at `memrain:18790`;
- scripts call `memrain`, not `memex`;
- `/etc/stack-env` has `STACK_SUBDOMAIN`, and Terraform uses `subdomain`
  and the new output names.
