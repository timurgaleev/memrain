# Memrain — Operations

How to deploy, restart, observe, and recover.

## Deploy

```bash
# from your workstation:
git push origin main

# SSM into the EC2:
aws ssm start-session --target <your-instance-id> \
  --profile <your-profile> --region <your-region>

# inside the EC2 (only needed when using the SSH deploy-key mode;
# the default install clones via HTTPS):
export GIT_SSH_COMMAND="ssh -i /root/.ssh/<project>_deploy_key \
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
# (ssm-user is not in the docker group and the checkout is root-owned: sudo)
cd /opt/<project> && sudo --preserve-env=GIT_SSH_COMMAND git pull --ff-only
sudo bash deploy/deploy.sh   # stamps the image, builds, waits for healthy
sudo docker compose --env-file .env ps memrain
sudo docker compose --env-file .env logs --tail 25 memrain
```

First boot pulls + builds; subsequent rebuilds are ~30 s warm. Coming from
0.25 or earlier, read [UPGRADING.md](../../../UPGRADING.md#0260) before the first deploy.

Migration 146 pins six existing SQL functions to
`search_path = pg_catalog, public, pg_temp`. A missing function or insufficient
ownership produces a NOTICE and leaves that signature unchanged. Record any
such skip and inspect the deployed catalog; a successful migration command
alone does not prove every signature was hardened.

## Health probes

```bash
# operational probe (full route list in API.md):
docker exec deploy-memrain-1 wget -qO- http://127.0.0.1:18790/health
# → {"ok":true,"db":"postgres","version":"<build stamp>","edition":"lite",...}

# MCP smoke (proves tool dispatch over /mcp; add
# --header="Authorization: Bearer $MEMRAIN_INTERNAL_TOKEN" when it is set):
docker exec deploy-memrain-1 sh -c '
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"stats\"}}" \
    | wget -qO- --post-file=/dev/stdin --header=Content-Type:application/json http://127.0.0.1:18790/mcp
'

# self-diagnostics (config, engine, stats, embed coverage, housekeeping, ...):
docker exec deploy-memrain-1 bun run src/cli.ts doctor

# one-shot counts and health:
docker exec deploy-memrain-1 bun run src/cli.ts status
```

## Local dev

```bash
cd deploy/memrain
bun install --frozen-lockfile
bun run test:sharded   # never a bare `bun test`: PGLite runs out of WASM heap
bun run src/cli.ts --help
```

Admin interaction checks use a separate development-only Playwright runner;
see [Admin browser tests](../../../CONTRIBUTING.md#admin-browser-tests).
History View fetches only the selected version through `page_get(version)`;
existing body access and redaction rules still apply.

To run against a fresh local PGLite:

```bash
mkdir -p /tmp/memrain-dev
HOME=/tmp/memrain-dev bun run src/cli.ts init --pglite
HOME=/tmp/memrain-dev bun run src/cli.ts serve --http --host 127.0.0.1 --port 18790
```

## Logs

```bash
docker compose logs --tail 50 memrain
docker compose logs -f memrain | grep -v healthcheck
```

Notable log lines to look for:
- `[memrain] listening on http://0.0.0.0:18790 (...)`
- `[memrain] housekeeping every hour (purge, search mirrors, embed gaps, token sweep, spend reservations, retention)`
- `[memrain] housekeeping {...}` — one line per run with each step's result,
  followed by any step that failed

## Housekeeping

The pass runs once an hour inside `serve`, the first time about five minutes
after boot. A restart does not run it early, and there is no command to run
it by hand. `memrain doctor` reports when it last finished. To fill missing
vectors now, use the embed backfill instead:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts embed --dry-run   # count and price
docker exec deploy-memrain-1 bun run src/cli.ts embed --limit 500
```

`MEMRAIN_CYCLE=0` turns housekeeping off; the other switches are listed in
[UPGRADING.md](../../../UPGRADING.md#0260).

## Re-build the index from scratch

Only the derived search index can be rebuilt from intact source files and
canonical database pages. Preserve the existing database and backup before
repairing it; truncating tables with cascades can remove related data that
file ingestion cannot recreate. Use `doctor` to establish which inputs or
mirrors need work. `reindex --all --vault /memory` re-reads every vault file;
`embed --all` re-embeds the whole embeddable corpus. Neither restores
canonical data that is missing from the database.

## Re-build the index after RDS loss

RDS holds canonical pages, versions, links, tags and credentials that may
have no file copy. Restore that database from PITR or a snapshot first. A
`/memory` sweep or Markdown page import cannot recover those records. Follow
[Backup evidence and page import](../../../docs/DEPLOYMENT.md#backup-evidence-and-page-import)
and the [restore drill](../../../docs/DEPLOYMENT.md#restore-drill-rds). Verify
table counts on the restored target before pointing the service at it. A
documented command or installed release is not evidence that a restore has
run successfully.

## Common failure modes

| Symptom | Cause / fix |
|---|---|
| `there is no unique or exclusion constraint matching the ON CONFLICT specification` | A migration uses `ON CONFLICT (col)` against a composite PK. Fix: `ON CONFLICT DO NOTHING` (bare). |
| `cannot find version 16.X for postgres` | RDS engine version pin in `terraform/rds.tf` not on this account. `aws rds describe-db-engine-versions --engine postgres` to pick a valid one. |
| Container restarting on boot | `docker compose logs memrain --tail 50`. Likely: secret missing, RDS unreachable (SG egress 5432), or `MEMRAIN_POSTGRES_URL` not in env. |
| `UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1` | Code is using inline `BEGIN`/`COMMIT` against postgres-js. Fix: route through `engine.transaction(fn)` instead. |
| `search` answers `budget_exhausted` | The brain's daily cap (`MEMRAIN_DAILY_BUDGET_USD`) or the credential's cap is spent. Raise it, or wait for the UTC day to roll over. |

## Cost watch

The only paid model call is the Bedrock Titan embedding, about $0.02 per
million tokens, under `MEMRAIN_DAILY_BUDGET_USD` and each credential's cap.
The rest of the bill is the infrastructure (EC2, RDS, EFS, Secrets Manager);
see [HOW-IT-WORKS.md](../../../docs/HOW-IT-WORKS.md#3-what-it-costs).
