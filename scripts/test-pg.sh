#!/usr/bin/env bash
#
# Run the Postgres-only part of the memrain suite against a real Postgres 16
# with pgvector. PGLite serializes transactions, so races and driver-specific
# binding behaviour only show up here.
#
# What it runs, in order:
#   1. every migration, applied to an empty database;
#   2. the migration set applied a second time — it must apply nothing;
#   3. every test file under deploy/memrain/tests that reads
#      MEMRAIN_TEST_POSTGRES_URL (found by grep, so a new *_pg test is picked
#      up without touching this script).
#
# Database:
#   - default: a throwaway pgvector/pgvector:pg16 container on a free
#     loopback port, removed on exit whether the run passed or failed.
#   - MEMRAIN_TEST_POSTGRES_URL already set: use that database instead and
#     start no container (CI passes a service container this way). It MUST
#     be a scratch database — migrations and tests write to it. The legacy
#     MEMEX_TEST_POSTGRES_URL is accepted when the new name is unset.
#
# Env:
#   TEST_PG_IMAGE    image for the throwaway container
#                    (default pgvector/pgvector:pg16)
#   TEST_PG_TIMEOUT  seconds to wait for readiness (default 60)
#   TEST_TIMEOUT     per-test timeout in ms passed to bun (default 30000)
#   TEST_PG_CHUNK    test files per bun process (default 25)
#
# Pooler mode (TEST_PG_POOLER=1) runs the same suite through PgBouncer in
# transaction mode, the image hosting runs (deploy/pgbouncer). It starts
# Postgres and the pooler on one private network; migrations go to Postgres
# directly, and so must a migration through the pooler fail. Every test file
# then gets MEMRAIN_TEST_POSTGRES_URL pointing at the pooler, except those
# listed in deploy/memrain/tests/pooler-direct-only.txt (one per line, with
# a category and its reason), which get the database directly: control-plane
# files (never pooled by design) and at most 10 files needing a session. Engines a test builds come
# from tests/helpers/pg-test-engine.ts, which puts them in pooler mode. The
# run prints how many files it found, pooled and ran directly; the two must
# add up to the first. Files that read MEMRAIN_TEST_PGBOUNCER_URL run only in
# this mode (the transaction-mode hazards).
#   TEST_PG_PREPARE      1 (default) keeps postgres-js's named prepared
#                        statements, 0 turns them off (MEMRAIN_PG_PREPARE=0)
#   TEST_PG_POOL_SIZE    server connections per database (default 20)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$REPO/deploy/memrain"
IMAGE="${TEST_PG_IMAGE:-pgvector/pgvector:pg16}"
READY_TIMEOUT="${TEST_PG_TIMEOUT:-60}"
TEST_TIMEOUT="${TEST_TIMEOUT:-30000}"
POOLER="${TEST_PG_POOLER:-}"
PREPARE="${TEST_PG_PREPARE:-1}"
DIRECT_ONLY="$PKG/tests/pooler-direct-only.txt"
# Files that need their own server session; more than this means the brain
# is not pooler-compatible, whatever the run says.
DIRECT_ONLY_MAX=10

CONTAINER=""
BOUNCER=""
NETWORK=""
OUT=""

cleanup() {
  local status=$?
  [ -z "$OUT" ] || rm -f "$OUT"
  if [ -n "$BOUNCER" ]; then
    docker rm -f "$BOUNCER" >/dev/null 2>&1 || true
    echo "[test-pg] removed container $BOUNCER"
  fi
  if [ -n "$CONTAINER" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "[test-pg] removed container $CONTAINER"
  fi
  if [ -n "$NETWORK" ]; then
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT
# A signal only sets the status; the EXIT trap cleans up once, with it.
trap 'exit 130' INT
trap 'exit 143' TERM

log() { echo "[test-pg] $*"; }
die() { echo "[test-pg] $*" >&2; exit 1; }

start_container() {
  command -v docker >/dev/null 2>&1 || die "docker not found (or set MEMRAIN_TEST_POSTGRES_URL to a scratch database)"
  local password net=()
  password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  PG_PASSWORD="$password"
  CONTAINER="memrain-test-pg-$$-$RANDOM"
  if [ "$POOLER" = 1 ]; then
    NETWORK="${CONTAINER}-net"
    docker network create "$NETWORK" >/dev/null
    net=(--network "$NETWORK" --network-alias pg)
  fi
  # Port 0 on the host side: Docker picks a free port, so parallel runs and a
  # developer's own Postgres on 5432 never collide.
  docker run -d --name "$CONTAINER" ${net[@]+"${net[@]}"} \
    -e POSTGRES_USER=memrain \
    -e POSTGRES_PASSWORD="$password" \
    -e POSTGRES_DB=memrain_test \
    -p 127.0.0.1::5432 \
    "$IMAGE" >/dev/null
  local port
  port="$(docker port "$CONTAINER" 5432/tcp | head -n1 | sed 's/.*://')"
  [ -n "$port" ] || die "could not read the published port of $CONTAINER"
  log "container $CONTAINER ($IMAGE) on 127.0.0.1:$port"

  # The image's entrypoint runs a temporary server during initdb that listens
  # on the unix socket only, then restarts. Probing TCP inside the container
  # waits for the real server rather than the init one.
  local waited=0
  until docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 -U memrain -d memrain_test >/dev/null 2>&1; do
    [ "$waited" -lt "$READY_TIMEOUT" ] || { docker logs "$CONTAINER" >&2 || true; die "Postgres not ready after ${READY_TIMEOUT}s"; }
    sleep 1
    waited=$((waited + 1))
  done
  log "ready after ${waited}s"
  export MEMRAIN_TEST_POSTGRES_URL="postgres://memrain:${password}@127.0.0.1:${port}/memrain_test?sslmode=disable"
}

# The hosting pooler image, on the database's network, published on a free
# loopback port. Exports POOLED_URL; MEMRAIN_TEST_POSTGRES_URL stays direct
# until the tests run.
start_bouncer() {
  local tag="memrain-pgbouncer:test" port waited=0
  # Through the pooler the engine sends no timeout at connect; the role
  # carries them, as a provisioned tenant owner does (control/provision.ts).
  docker exec "$CONTAINER" psql -q -U memrain -d memrain_test \
    -c "ALTER ROLE memrain SET statement_timeout = '60s'" \
    -c "ALTER ROLE memrain SET idle_in_transaction_session_timeout = '60s'" >/dev/null
  log "building the pooler image (deploy/pgbouncer)"
  docker build -q -t "$tag" "$REPO/deploy/pgbouncer" >/dev/null
  BOUNCER="${CONTAINER}-bouncer"
  docker run -d --name "$BOUNCER" --network "$NETWORK" \
    --read-only --tmpfs /run/pgbouncer:uid=10070,gid=10070,mode=0700 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    -e PGBOUNCER_UPSTREAM_URL="postgres://memrain:${PG_PASSWORD}@pg:5432/memrain_test" \
    -e PGBOUNCER_SERVER_TLS_SSLMODE=disable \
    -e PGBOUNCER_DEFAULT_POOL_SIZE="${TEST_PG_POOL_SIZE:-20}" \
    -e PGBOUNCER_ANY_DATABASE=1 \
    -p 127.0.0.1::6432 \
    "$tag" >/dev/null
  port="$(docker port "$BOUNCER" 6432/tcp | head -n1 | sed 's/.*://')"
  [ -n "$port" ] || die "could not read the published port of $BOUNCER"
  until docker exec "$CONTAINER" pg_isready -q -h "$BOUNCER" -p 6432 -U memrain -d memrain_test >/dev/null 2>&1; do
    [ "$waited" -lt "$READY_TIMEOUT" ] || { docker logs "$BOUNCER" >&2 || true; die "pooler not ready after ${READY_TIMEOUT}s"; }
    sleep 1
    waited=$((waited + 1))
  done
  log "pooler $BOUNCER ($(docker exec "$BOUNCER" pgbouncer --version | head -n1)) on 127.0.0.1:$port, prepare=${PREPARE}"
  POOLED_URL="postgres://memrain:${PG_PASSWORD}@127.0.0.1:${port}/memrain_test?sslmode=disable"
}

# A migration through the pooler must be refused before it sends anything.
assert_pooled_migration_refused() {
  # shellcheck disable=SC2016 # the TypeScript is meant to reach bun unexpanded
  (cd "$PKG" && POOLED_URL="$POOLED_URL" bun -e '
    import { PostgresEngine } from "./src/core/engine/postgres.ts";
    import { runMigrations } from "./src/core/migrate.ts";
    import { PoolerMigrationRefusedError } from "./src/core/engine/direct.ts";
    const engine = new PostgresEngine({ url: process.env.POOLED_URL!, max: 1, pooler: "pgbouncer" });
    try {
      const err = await runMigrations(engine).then(() => null, (e: unknown) => e);
      if (!(err instanceof PoolerMigrationRefusedError)) throw new Error(`a migration through the pooler was not refused: ${String(err)}`);
      console.log("[test-pg] a migration through the pooler is refused (pooler_migration_refused)");
    } finally {
      await engine.close();
    }
  ')
}

apply_migrations_twice() {
  # Inline so the check runs the same runMigrations the daemon boots with,
  # against the same engine, without loading any daemon config.
  # shellcheck disable=SC2016 # the TypeScript is meant to reach bun unexpanded
  (cd "$PKG" && bun -e '
    import { PostgresEngine } from "./src/core/engine/postgres.ts";
    import { runMigrations, discoverMigrations } from "./src/core/migrate.ts";
    const engine = new PostgresEngine({ url: process.env.MEMRAIN_TEST_POSTGRES_URL!, max: 2 });
    try {
      await engine.ready();
      const total = discoverMigrations().length;
      const first = await runMigrations(engine);
      console.log(`[test-pg] first apply: ${first.applied.length} applied, ${first.skipped} skipped, ${total} on disk`);
      if (first.applied.length + first.skipped !== total) throw new Error("first apply did not account for every migration");
      const second = await runMigrations(engine);
      console.log(`[test-pg] second apply: ${second.applied.length} applied, ${second.skipped} skipped`);
      if (second.applied.length !== 0 || second.skipped !== total) {
        throw new Error(`second apply was not a no-op: ${JSON.stringify(second.applied)}`);
      }
    } finally {
      await engine.close();
    }
  ')
}

# run_chunks LABEL FILE... -> bun test over FILE... in chunks, output to $OUT.
run_chunks() {
  local label="$1"; shift
  local files=("$@")
  # One bun process for every file stalls once the suite passes ~200 files
  # (each file passes alone), so run them in chunks of TEST_PG_CHUNK files.
  local chunk="${TEST_PG_CHUNK:-25}" i
  for ((i = 0; i < ${#files[@]}; i += chunk)); do
    log "${label} chunk $((i / chunk + 1)): files $((i + 1))-$((i + chunk < ${#files[@]} ? i + chunk : ${#files[@]}))"
    # pipefail (set above) keeps bun's exit status through tee.
    (cd "$PKG" && bun test --timeout "$TEST_TIMEOUT" "${files[@]:i:chunk}") 2>&1 | tee -a "$OUT"
  done
}

# read_direct_only FOUND_FILE... -> fills DIRECT_FILES, DIRECT_SESSION and
# DIRECT_CONTROL from $DIRECT_ONLY (`<file>.test.ts <category> <reason>` per
# line, # comments). Every entry must name a found file, a category and a
# reason. `control`: the file tests the control plane, whose connections never
# go through a pooler by design. `session`: brain code under test needs its own
# server session; at most DIRECT_ONLY_MAX of those.
read_direct_only() {
  local found=" $* " name category reason
  DIRECT_FILES=()
  DIRECT_SESSION=0
  DIRECT_CONTROL=0
  [ -f "$DIRECT_ONLY" ] || die "$DIRECT_ONLY is missing"
  while read -r name category reason || [ -n "$name" ]; do
    case "$name" in ''|'#'*) continue ;; esac
    [ -n "$reason" ] || die "pooler-direct-only.txt: ${name} gives no reason"
    case "$category" in
      session) DIRECT_SESSION=$((DIRECT_SESSION + 1)) ;;
      control) DIRECT_CONTROL=$((DIRECT_CONTROL + 1)) ;;
      *) die "pooler-direct-only.txt: ${name}: category must be session or control, got '${category}'" ;;
    esac
    [[ "$found" == *" tests/${name} "* ]] || die "pooler-direct-only.txt: ${name} is not a Postgres test file"
    DIRECT_FILES+=("tests/${name}")
  done < "$DIRECT_ONLY"
  [ "$DIRECT_SESSION" -le "$DIRECT_ONLY_MAX" ] \
    || die "pooler-direct-only.txt lists ${DIRECT_SESSION} session files; more than ${DIRECT_ONLY_MAX} means the suite is not pooler-compatible"
}

run_pg_tests() {
  local files=()
  local f pattern=MEMRAIN_TEST_POSTGRES_URL
  # The transaction-mode hazards only mean something through the pooler.
  [ "$POOLER" = 1 ] && pattern='MEMRAIN_TEST_POSTGRES_URL\|MEMRAIN_TEST_PGBOUNCER_URL'
  while IFS= read -r f; do
    files+=("tests/$(basename "$f")")
  done < <(grep -l "$pattern" "$PKG"/tests/*.test.ts | sort)
  [ "${#files[@]}" -gt 0 ] || die "no test file reads MEMRAIN_TEST_POSTGRES_URL"
  OUT="$(mktemp -t test-pg-out.XXXXXX)"
  if [ "$POOLER" != 1 ]; then
    log "running ${#files[@]} test file(s): ${files[*]}"
    run_chunks direct "${files[@]}"
    assert_no_skips "$OUT"
    return
  fi

  local pooled=() direct=" " d
  read_direct_only "${files[@]}"
  for d in ${DIRECT_FILES[@]+"${DIRECT_FILES[@]}"}; do direct+="$d "; done
  for f in "${files[@]}"; do
    [[ "$direct" == *" $f "* ]] || pooled+=("$f")
  done
  log "found ${#files[@]} file(s): ${#pooled[@]} through the pooler, ${#DIRECT_FILES[@]} direct (pooler-direct-only.txt: ${DIRECT_SESSION} session, ${DIRECT_CONTROL} control plane)"
  [ $((${#pooled[@]} + ${#DIRECT_FILES[@]})) -eq "${#files[@]}" ] || die "pooled + direct != found"

  (
    export MEMRAIN_TEST_POSTGRES_URL="$POOLED_URL" MEMRAIN_TEST_PGBOUNCER_URL="$POOLED_URL"
    export MEMRAIN_TEST_POSTGRES_DIRECT_URL="$DIRECT_URL" MEMRAIN_TEST_PG_POOLER=pgbouncer MEMRAIN_TEST_PG_PREPARE="$PREPARE"
    run_chunks pooled "${pooled[@]}"
  )
  if [ "${#DIRECT_FILES[@]}" -gt 0 ]; then
    (
      export MEMRAIN_TEST_POSTGRES_URL="$DIRECT_URL"
      unset MEMRAIN_TEST_PGBOUNCER_URL MEMRAIN_TEST_POSTGRES_DIRECT_URL MEMRAIN_TEST_PG_POOLER MEMRAIN_TEST_PG_PREPARE
      run_chunks direct "${DIRECT_FILES[@]}"
    )
  fi
  assert_no_skips "$OUT"
  log "pooler run: ${#files[@]} found = ${#pooled[@]} pooled + ${#DIRECT_FILES[@]} direct (${DIRECT_SESSION} session, ${DIRECT_CONTROL} control plane), prepare=${PREPARE}, 0 skipped"
}

# With a Postgres URL set nothing in these files has a reason to skip, so a
# skip is a case that silently did not run.
assert_no_skips() {
  local skipped
  # bun colors the summary when FORCE_COLOR is set; strip ANSI codes first.
  # A todo test never runs either, so it counts as a skip.
  skipped="$(sed $'s/\x1b\\[[0-9;]*m//g' "$1" | awk '/^ *[0-9]+ (skip|todo)/{n += $1} END{print n + 0}')"
  [ "$skipped" -eq 0 ] || die "$skipped test(s) skipped — a Postgres run must skip nothing"
}

# Sourced by tests/test-pg-summary.test.sh for its functions only.
if [ -n "${TEST_PG_SOURCE_ONLY:-}" ]; then return 0; fi

command -v bun >/dev/null 2>&1 || die "bun not found"

if [ -z "${MEMRAIN_TEST_POSTGRES_URL:-}" ] && [ -n "${MEMEX_TEST_POSTGRES_URL:-}" ]; then
  export MEMRAIN_TEST_POSTGRES_URL="$MEMEX_TEST_POSTGRES_URL"
fi
case "$POOLER" in ''|0) POOLER="" ;; 1) ;; *) die "TEST_PG_POOLER must be 1 or unset" ;; esac
case "$PREPARE" in 0|1) ;; *) die "TEST_PG_PREPARE must be 0 or 1" ;; esac
if [ "$POOLER" = 1 ] && [ -n "${MEMRAIN_TEST_POSTGRES_URL:-}" ]; then
  die "TEST_PG_POOLER=1 starts its own Postgres and pooler; unset MEMRAIN_TEST_POSTGRES_URL"
fi
if [ -n "${MEMRAIN_TEST_POSTGRES_URL:-}" ]; then
  log "using MEMRAIN_TEST_POSTGRES_URL from the environment (no container)"
else
  start_container
fi
DIRECT_URL="$MEMRAIN_TEST_POSTGRES_URL"

apply_migrations_twice
if [ "$POOLER" = 1 ]; then
  start_bouncer
  assert_pooled_migration_refused
fi
run_pg_tests
log "ok"
