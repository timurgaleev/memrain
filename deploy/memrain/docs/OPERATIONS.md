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

First boot pulls + builds; subsequent rebuilds are ~30 s warm.

Migration 146 pins six existing SQL functions to
`search_path = pg_catalog, public, pg_temp`. A missing function or insufficient
ownership produces a NOTICE and leaves that signature unchanged. Record any
such skip and inspect the deployed catalog; a successful migration command
alone does not prove every signature was hardened.

## Health probes

```bash
# operational probe (full route list in API.md):
docker exec deploy-memrain-1 wget -qO- http://127.0.0.1:18790/health
# → {"ok":true,"db":"postgres","version":"0.1.0",
#     "stats":{"documents":114,"chunks":244,"embeddings":244}}

# MCP smoke (proves tool dispatch over /mcp):
docker exec deploy-memrain-1 sh -c '
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"stats\"}}" \
    | wget -qO- --post-file=/dev/stdin --header=Content-Type:application/json http://127.0.0.1:18790/mcp
'

# self-diagnostics:
docker exec deploy-memrain-1 bun run src/cli.ts doctor
# → 5/5 checks ok (config / engine / stats / index-spread / vault)

# vault-vs-index drift:
docker exec deploy-memrain-1 bun run src/cli.ts integrity --vault /memory
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
existing body access and redaction rules still apply. Jobs Watch pauses while
the tab is hidden, refreshes on return and aborts on unmount.

To run against a fresh local PGLite (dev only — production uses RDS):

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
- `[memrain] listening on http://0.0.0.0:18790 (MCP enabled)`
- `[code] boot sweep: scanned=N reindexed=M skipped=K parseErrors=0 errors=0`
- `[memrain] starting cycle loop: every Ns, embed-stale at >Md`
- `[cycle] tick status=ok ...` (per-phase `status=ok|warn|FAIL`; `warn` =
  the phase completed but reported non-fatal issues, e.g. a transient embed
  error or a zero-chunk doc)

## Trigger a cycle manually

The cycle ticks automatically every `MEMRAIN_DREAM_INTERVAL_S` (6 h
default). A restart does not fire a tick early. To run one cycle now:

```bash
# one full cycle, or a subset with --phases a,b (shares the daemon's lock):
docker exec deploy-memrain-1 bun run src/cli.ts cycle [--phases a,b]
```

For a one-shot manual run of any single phase, use the corresponding
operational command:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts extract
docker exec deploy-memrain-1 bun run src/cli.ts orphans
docker exec deploy-memrain-1 bun run src/cli.ts reconcile-links
```

## Eval harness

Quality regression check against `tests/eval/qrels.json`:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts eval
# computes recall@5 + MRR; exits 1 if mean recall@5 < 0.6
```

## Re-build the index from scratch

Only the derived search index can be rebuilt from intact source files and
canonical database pages. Preserve the existing database and backup before
repairing it; truncating tables with cascades can remove related data that
file ingestion cannot recreate. Use `integrity` and `doctor` to establish
which inputs or mirrors need work, then review a bounded repair below.
`reindex --rechunk-stale` upgrades existing stale documents; it is not a full
restore and does not discover missing canonical data.

## Re-build the index after RDS loss

RDS holds canonical pages, facts, versions and other history that may have no
file copy. Restore that database from PITR/snapshots or a complete verified
database copy first. A `/memory` sweep or Markdown page import cannot recover
those records. Follow [Backup evidence and page import](../../../docs/DEPLOYMENT.md#backup-evidence-and-page-import)
and the [database copy and verification workflow](#migrate-to-a-fresh-rds-in-another-account).
Verify table counts and content hashes on the restored target before resuming
workers. A documented command or installed release is not evidence that a
restore has run successfully.

## Bounded chunker upgrade

On the operator host, preview the exact scope and budget:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts reindex --rechunk-stale \
  --source all --vault /memory --paths /repo-source --limit 10 --max-cost-usd 1 --dry-run
# Replace <reviewed-hash> with plan_hash from that preview; keep other options identical:
docker exec deploy-memrain-1 bun run src/cli.ts reindex --rechunk-stale \
  --source all --vault /memory --paths /repo-source --limit 10 --max-cost-usd 1 \
  --plan-hash <reviewed-hash>
```

Without a hash this command only previews, even if `--dry-run` is omitted.
Preview does not run migrations, write database rows or call models. The
default document limit is 25 (maximum 1000), and the default dollar ceiling
is zero. `vault` includes only files; `code` uses configured code roots;
`all` also includes canonical `page://` and `page-truth://` mirrors. Held
candidates and `truncated` must be reviewed; a completed batch is not a claim
that the whole corpus was upgraded. The census stops at 10000 stale rows.

The hash pins selected inputs, ownership, stored chunks/vectors, options,
versions and relevant model/configuration/pricing. Changed input refuses an
old hash before work starts. Each target is checked again before its write;
an incomplete code parse, embedding failure or concurrent change retains
that target's old chunks. A later failure can leave earlier targets completed: inspect the
`completed`, `skipped`, `remaining` and `held` fields before previewing again.
Keep the receipt with the before/after data manifest.

Markdown work reserves its upper-bound embedding cost before each call;
unknown embedding prices refuse the plan, and failed calls retain their
reservation. This bounded path allows one SDK attempt per call, so hidden
retries cannot multiply the ceiling. Code-only work is graph-only and accepts
`--max-cost-usd 0`. With `MEMRAIN_CONTEXTUAL_LLM=1`, bounded Markdown rechunk
refuses the plan; the paid contextual tier has its separate
`reindex --contextual` workflow. Deterministic contextual prefixes are priced
within the rechunk ceiling.

Do not combine rechunk with `--all`, `--force`, `--contextual` or deletion
reconciliation. Ordinary incremental reindex rejects `--dry-run`/`--limit`;
those options require rechunk or contextual mode.

Markdown version 3 prefers complete lines at hard cuts and preserves Unicode
surrogate pairs. Manual stale counts compare against version 3, but automatic
file/body/truth maintenance retains upgrade floor 2. Unchanged version-2
documents do not incur a corpus re-embedding merely because this release was
deployed. New or changed content uses version 3.

## Repair unowned page mirrors

```bash
docker exec deploy-memrain-1 bun run src/cli.ts mirror-adopt --source <source-id> --limit 100
docker exec deploy-memrain-1 bun run src/cli.ts mirror-adopt --source <source-id> --limit 100 \
  --apply --plan-hash <reviewed-hash>
```

The source must exist. Preview is the default; the limit defaults to 100 and
cannot exceed 200. Only a uniquely owned, current canonical body/truth mirror
with proven chunk content can be adopted. Ambiguous, stale, retired or
foreign-owned candidates are held. Apply revalidates the hash under locks,
then changes only previously NULL source ownership and cache generations;
content, IDs, embeddings, canonical pages and history remain intact. No model
is called. The receipt includes old/new ownership and generations, plus
content fingerprints.

The normal mirror reconciler uses the same proof. For an upgrade whose data
delta is being audited, keep workers paused through deployment, record the
separate pinned adoption and its before/after manifest, then resume them.
Installing this command does not establish that any production mirror has
been adopted or validated.

## Migrate to a fresh RDS in another account

Use `migrate-engine` to ferry data via a temporary local PGLite:

```bash
# 1) Old account: dump RDS into a local PGLite file
docker exec deploy-memrain-1 bun run src/cli.ts \
  migrate-engine --from postgres --to pglite \
  --pglite-path /tmp/brain-snapshot.pglite

# 2) Copy the file off the EC2 (scp or via S3)

# 3) New account: provision RDS via terraform/rds.tf, then
docker exec -e MEMRAIN_POSTGRES_URL='<new-url>' deploy-memrain-1 \
  bun run src/cli.ts migrate-engine --from pglite --to postgres \
  --pglite-path /tmp/brain-snapshot.pglite
```

The command applies migrations on the destination, then copies **every
public table** the two catalogs share, in foreign-key order. Generated
columns are skipped (the destination recomputes them), and columns are the
intersection of both sides. Values travel as text, and each batch runs with
`session_replication_role = replica`, so triggers and FK checks stay off and
no insert rewrites a copied row. The destination role therefore needs
superuser (`rds_superuser` on RDS); the run refuses up front otherwise.
Keyed tables upsert, so a re-run resumes an interrupted copy and makes rows
seeded by the destination's migrations equal to the source. Sequences are
advanced to the later of the copied maximum and the source sequence, so an id
the source handed out and then deleted is never reissued. The source is only
read, through one `REPEATABLE READ READ ONLY` snapshot that covers both the
copy and the check, so a source the service keeps writing to is copied as one
point in time. On Postgres that snapshot is one transaction held open for the
whole run.

Every table is then checked by row count and a content hash. The command
prints one JSON summary (`ok`, per-table `src`/`dst`/`srcHash`/`dstHash`/
`match`, `missing`, `failures`) on stdout and exits 1 on any mismatch,
missing table, failed table, or source column the destination lacks (its
data would be dropped).

| Flag | Meaning |
|---|---|
| `--dry-run` | catalogs and row counts only, no writes |
| `--verify-only` | skip the copy; compare two existing databases (against a live source it also reports every row written since the copy) |
| `--allow-dropped-columns` | accept source columns the destination lacks, e.g. a rollback onto an older schema; their data is not copied |
| `--tables a,b` | restrict the copy and the check to these tables |
| `--to-pglite-path P` | destination path for a pglite→pglite copy (`--pglite-path` is the source) |

### Rollback rehearsal

Before a risky schema change, prove the way back on a scratch copy. The
live database is only read:

```bash
# Postgres -> PGLite (rehearsal copy); the run checks itself against the
# same source snapshot it copied, so it passes while the service writes
docker exec deploy-memrain-1 bun run src/cli.ts migrate-engine \
  --from postgres --to pglite --pglite-path /tmp/rt-rehearsal.pglite

# PGLite -> PGLite (a second hop that must match the first)
docker exec deploy-memrain-1 bun run src/cli.ts migrate-engine \
  --from pglite --to pglite --pglite-path /tmp/rt-rehearsal.pglite \
  --to-pglite-path /tmp/rt-hop2.pglite

docker exec deploy-memrain-1 rm -rf /tmp/rt-rehearsal.pglite /tmp/rt-hop2.pglite
```

A PGLite copy holds the whole brain in the process's WASM heap next to the
live server; watch free memory, and run it from a laptop through the SSM
tunnel if it is tight.

## Common failure modes

| Symptom | Cause / fix |
|---|---|
| `there is no unique or exclusion constraint matching the ON CONFLICT specification` | A migration / migrate-engine SQL uses `ON CONFLICT (col)` against a composite PK. Fix: `ON CONFLICT DO NOTHING` (bare). |
| `cannot find version 16.X for postgres` | RDS engine version pin in `terraform/rds.tf` not on this account. `aws rds describe-db-engine-versions --engine postgres` to pick a valid one. |
| Container restarting on boot | `docker compose logs memrain --tail 50`. Likely: secret missing, RDS unreachable (SG egress 5432), or `MEMRAIN_POSTGRES_URL` not in env. |
| `UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1` | Code is using inline `BEGIN`/`COMMIT` against postgres-js. Fix: route through `engine.transaction(fn)` instead. |
| Sweep OOM kills SSM agent | Instance too small. Production is t4g.medium; if you ever scale down, throttle via `MEMRAIN_SWEEP_DELAY_MS=200` and `MEMRAIN_SWEEP_MAX_FILES=200`. |

## Cost watch

| Item | Cost |
|---|---|
| t4g.medium on-demand | ~$13/mo |
| db.t4g.micro RDS Postgres + 20 GiB gp3 + 7-day backup | ~$15/mo |
| Bedrock Titan v2 embeddings | credit-eligible (≈ $0/mo for our volume) |
| Bedrock Claude Haiku (intent / expansion) | paid (per-query; heuristic cache skips most) |
| Cloudflare Tunnel | free (Zero Trust free tier) |
| Total stack | **~$28/mo** at light personal use |
