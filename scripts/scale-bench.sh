#!/usr/bin/env bash
#
# Run `memrain bench scale` against its own throwaway Postgres, then remove it.
#
# What it does:
#   1. starts pgvector Postgres in a container with fixed CPU/RAM limits and
#      max_connections=200, on a free loopback port, with a random password;
#   2. when the PgBouncer image is in the tree (deploy/pgbouncer/Dockerfile),
#      builds it and starts it in front of that Postgres on a private network,
#      so the bench's 8-tenant scenario also runs through the pooler;
#   3. runs the bench with --container and --cold, so the cold-start scenario
#      can restart this container (and only this one);
#   4. removes the containers, the network and the temp files on exit, passed
#      or failed.
#
# The bench creates its own uniquely named databases on this server and drops
# them; it refuses the server of any production URL in the environment.
#
# Env:
#   SCALE_BENCH_OUT          report path (default: scale-bench-<UTC stamp>.json in the cwd)
#   SCALE_BENCH_CHUNKS       chunks in the one-brain scenario (default 100000)
#   SCALE_BENCH_TENANTS      parallel brains (default 8)
#   SCALE_BENCH_CONCURRENCY  parallel queries per brain (default 4)
#   SCALE_BENCH_SEED         corpus + query seed (default 1)
#   SCALE_BENCH_QUERIES / SCALE_BENCH_RUNS / SCALE_BENCH_WARMUP  protocol (default 200 / 3 / 50)
#   SCALE_BENCH_CPUS         Postgres container CPUs (default 4)
#   SCALE_BENCH_MEMORY       Postgres container memory (default 4g)
#   SCALE_BENCH_POOLER_URL   use this pooler instead of building one
#   SCALE_BENCH_IMAGE        Postgres image (default pgvector/pgvector:0.8.6-pg16)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$REPO/deploy/memrain"
IMAGE="${SCALE_BENCH_IMAGE:-pgvector/pgvector:0.8.6-pg16}"
CPUS="${SCALE_BENCH_CPUS:-4}"
MEMORY="${SCALE_BENCH_MEMORY:-4g}"
OUT="${SCALE_BENCH_OUT:-scale-bench-$(date -u +%Y%m%dT%H%M%SZ).json}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
PGBOUNCER_DIR="$REPO/deploy/pgbouncer"

TAG="$$-$RANDOM"
PG="memrain-scale-bench-pg-$TAG"
BOUNCER="memrain-scale-bench-bouncer-$TAG"
NET="memrain-scale-bench-$TAG"
TMP=""
STARTED=()

cleanup() {
  local status=$?
  local c
  for c in "${STARTED[@]+"${STARTED[@]}"}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$NET" >/dev/null 2>&1 || true
  [ -z "$TMP" ] || rm -rf "$TMP"
  echo "[scale-bench] cleaned up"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log() { echo "[scale-bench] $*"; }
die() { echo "[scale-bench] $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found"
command -v bun >/dev/null 2>&1 || die "bun not found"

wait_ready() {
  local waited=0
  until docker exec "$PG" pg_isready -q -h 127.0.0.1 -U memrain -d postgres >/dev/null 2>&1; do
    [ "$waited" -lt 90 ] || { docker logs "$PG" >&2 || true; die "Postgres not ready after 90s"; }
    sleep 1
    waited=$((waited + 1))
  done
}

TMP="$(mktemp -d -t scale-bench.XXXXXX)"
PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
docker network create "$NET" >/dev/null

# The cold scenario restarts this container, and Docker hands an ephemeral
# host port out afresh on restart: pick a free one now and publish it fixed.
# shellcheck disable=SC2016 # the TypeScript is meant to reach bun unexpanded
PORT="$(bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop(true);')"
[ -n "$PORT" ] || die "could not find a free loopback port"

# Fixed limits and settings: they are part of the measurement, and the report
# records what the server actually ran with. A parallel HNSW build puts
# maintenance_work_mem in shared memory, far past Docker's 64 MB /dev/shm.
docker run -d --name "$PG" --network "$NET" \
  --cpus "$CPUS" --memory "$MEMORY" --shm-size 1536m \
  -e POSTGRES_USER=memrain -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=postgres \
  -p "127.0.0.1:$PORT:5432" \
  "$IMAGE" \
  -c max_connections=200 -c shared_buffers=1GB -c effective_cache_size=3GB \
  -c maintenance_work_mem=1GB -c max_parallel_maintenance_workers=3 >/dev/null
STARTED+=("$PG")
wait_ready
log "postgres $IMAGE on 127.0.0.1:$PORT (cpus=$CPUS memory=$MEMORY)"
ADMIN_URL="postgres://memrain:${PASSWORD}@127.0.0.1:${PORT}/postgres?sslmode=disable"

POOLER_URL="${SCALE_BENCH_POOLER_URL:-}"
if [ -z "$POOLER_URL" ] && [ -f "$PGBOUNCER_DIR/Dockerfile" ]; then
  log "building the PgBouncer image from deploy/pgbouncer"
  docker build -q -t "memrain-scale-bench-pgbouncer:$TAG" "$PGBOUNCER_DIR" >/dev/null
  # A bench-only config: every bench database routed to the Postgres above,
  # transaction pooling, a tenant container's pool size per database. The
  # timeouts the engine sends at startup are accepted and dropped, as they are
  # set on the role in a hosted install.
  cat >"$TMP/pgbouncer.ini" <<EOF
[databases]
* = host=$PG port=5432

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = 4
max_client_conn = 500
max_db_connections = 0
max_prepared_statements = 200
server_tls_sslmode = disable
ignore_startup_parameters = extra_float_digits,statement_timeout,idle_in_transaction_session_timeout
EOF
  printf '"memrain" "%s"\n' "$PASSWORD" >"$TMP/userlist.txt"
  chmod 0644 "$TMP/pgbouncer.ini" "$TMP/userlist.txt"
  docker run -d --name "$BOUNCER" --network "$NET" --cpus 1 --memory 256m \
    -v "$TMP/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro" \
    -v "$TMP/userlist.txt:/etc/pgbouncer/userlist.txt:ro" \
    -p 127.0.0.1::6432 \
    --entrypoint pgbouncer "memrain-scale-bench-pgbouncer:$TAG" /etc/pgbouncer/pgbouncer.ini >/dev/null
  STARTED+=("$BOUNCER")
  BPORT="$(docker port "$BOUNCER" 6432/tcp | head -n1 | sed 's/.*://')"
  [ -n "$BPORT" ] || die "could not read the published port of $BOUNCER"
  POOLER_URL="postgres://memrain:${PASSWORD}@127.0.0.1:${BPORT}/postgres?sslmode=disable"
  log "pgbouncer on 127.0.0.1:$BPORT"
elif [ -z "$POOLER_URL" ]; then
  log "no deploy/pgbouncer/Dockerfile in this tree: the pooler scenario is skipped (the report says so)"
fi

ARGS=(bench scale --admin-url "$ADMIN_URL" --scratch --container "$PG" --cold --out "$OUT"
  --chunks "${SCALE_BENCH_CHUNKS:-100000}" --tenants "${SCALE_BENCH_TENANTS:-8}"
  --concurrency "${SCALE_BENCH_CONCURRENCY:-4}" --seed "${SCALE_BENCH_SEED:-1}"
  --queries "${SCALE_BENCH_QUERIES:-200}" --runs "${SCALE_BENCH_RUNS:-3}" --warmup "${SCALE_BENCH_WARMUP:-50}")
[ -z "$POOLER_URL" ] || ARGS+=(--pooler-url "$POOLER_URL")

(cd "$PKG" && bun src/cli.ts "${ARGS[@]}")
log "report: $OUT"
