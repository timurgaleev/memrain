#!/usr/bin/env bash
# tests/pgbouncer-render.test.sh — deploy/pgbouncer/render.sh and the image.
#
# render.sh turns one upstream URL into pgbouncer.ini and its userlist. The
# pooler must run in transaction mode with prepared-statement tracking, take
# server_tls_sslmode from the environment (disable for a local container,
# require for RDS), serve only the upstream's own database, keep the userlist
# at 0600 and refuse input it would have to quote. The Dockerfile must pin its
# base image by digest and the PgBouncer package by version.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RENDER="$REPO_ROOT/deploy/pgbouncer/render.sh"
DOCKERFILE="$REPO_ROOT/deploy/pgbouncer/Dockerfile"
TMPROOT="$(mktemp -d -t pgbouncer-render.XXXXXX)"
PASS=0
FAIL=0
trap 'rc=$?; rm -rf "$TMPROOT"; echo; echo "pgbouncer-render.test.sh: PASS=$PASS FAIL=$FAIL"; if [ "$FAIL" -ne 0 ]; then exit 1; fi; exit "$rc"' EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

URL='postgres://tenant_acme_owner:fakepw0123@db.example.test:5432/tenant_acme?sslmode=require'

# render DIR ENV... -> runs render.sh into DIR with only ENV set; RC holds its status.
render() {
  local dir="$1"; shift
  mkdir -p "$dir"
  RC=0
  env -i PATH="$PATH" PGBOUNCER_RUN_DIR="$dir" "$@" sh "$RENDER" > "$dir.log" 2>&1 || RC=$?
}
ini_value() { sed -n "s/^$2 = //p" "$1/pgbouncer.ini" | tail -1; }

echo "== render.sh =="

D="$TMPROOT/rds"
render "$D" PGBOUNCER_UPSTREAM_URL="$URL" PGBOUNCER_SERVER_TLS_SSLMODE=require
if [ "$RC" -eq 0 ] && [ -f "$D/pgbouncer.ini" ] && [ -f "$D/userlist.txt" ]; then pass "renders pgbouncer.ini and userlist.txt"; else die "render failed (rc=$RC)"; cat "$D.log"; fi
[ "$(ini_value "$D" pool_mode)" = transaction ] && pass "pool_mode = transaction" || die "pool_mode: '$(ini_value "$D" pool_mode)'"
mps="$(ini_value "$D" max_prepared_statements)"
if [[ "$mps" =~ ^[1-9][0-9]*$ ]]; then pass "max_prepared_statements > 0 ($mps)"; else die "max_prepared_statements: '$mps'"; fi
[ "$(ini_value "$D" auth_type)" = scram-sha-256 ] && pass "auth_type = scram-sha-256" || die "auth_type: '$(ini_value "$D" auth_type)'"
[ "$(ini_value "$D" server_tls_sslmode)" = require ] && pass "server_tls_sslmode = require for RDS" || die "server_tls_sslmode: '$(ini_value "$D" server_tls_sslmode)'"
[ "$(ini_value "$D" ignore_startup_parameters)" = extra_float_digits ] && pass "ignores only extra_float_digits at startup" || die "ignore_startup_parameters: '$(ini_value "$D" ignore_startup_parameters)'"
dbs="$(sed -n '/^\[databases\]/,/^\[/p' "$D/pgbouncer.ini" | grep -v '^\[' | grep -v '^$' | grep -v '^;')"
if [ "$dbs" = "tenant_acme = host=db.example.test port=5432 dbname=tenant_acme" ]; then
  pass "serves only the upstream's own database (no wildcard)"
else
  die "[databases]: '$dbs'"
fi
if grep -q 'fakepw0123' "$D/pgbouncer.ini"; then die "the password is in pgbouncer.ini"; else pass "no password in pgbouncer.ini"; fi
if [ "$(cat "$D/userlist.txt")" = '"tenant_acme_owner" "fakepw0123"' ]; then pass "userlist holds the upstream login"; else die "userlist: $(cat "$D/userlist.txt")"; fi
mode="$(stat -c '%a' "$D/userlist.txt" 2>/dev/null || stat -f '%Lp' "$D/userlist.txt")"
[ "$mode" = 600 ] && pass "userlist is 0600" || die "userlist mode $mode"
if grep -q 'fakepw0123' "$D.log"; then die "render printed the password"; else pass "render prints no password"; fi

D="$TMPROOT/local"
render "$D" PGBOUNCER_UPSTREAM_URL="${URL%%\?*}?sslmode=disable" PGBOUNCER_SERVER_TLS_SSLMODE=disable
[ "$RC" -eq 0 ] && [ "$(ini_value "$D" server_tls_sslmode)" = disable ] && pass "server_tls_sslmode = disable for a local container" || die "disable: rc=$RC '$(ini_value "$D" server_tls_sslmode)'"

D="$TMPROOT/default"
render "$D" PGBOUNCER_UPSTREAM_URL="$URL"
[ "$RC" -eq 0 ] && [ "$(ini_value "$D" server_tls_sslmode)" = require ] && pass "server_tls_sslmode defaults to require" || die "default sslmode: rc=$RC '$(ini_value "$D" server_tls_sslmode)'"

D="$TMPROOT/any"
render "$D" PGBOUNCER_UPSTREAM_URL="$URL" PGBOUNCER_ANY_DATABASE=1
if [ "$RC" -eq 0 ] && grep -q '^\* = host=db.example.test port=5432$' "$D/pgbouncer.ini"; then pass "PGBOUNCER_ANY_DATABASE=1 adds the wildcard (test runs only)"; else die "wildcard missing (rc=$RC)"; fi

D="$TMPROOT/tenantenv"
render "$D" MEMRAIN_POSTGRES_DIRECT_URL="$URL"
[ "$RC" -eq 0 ] && grep -q '^tenant_acme = host=db.example.test ' "$D/pgbouncer.ini" && pass "falls back to the tenant's MEMRAIN_POSTGRES_DIRECT_URL" || die "no fallback to MEMRAIN_POSTGRES_DIRECT_URL (rc=$RC)"

D="$TMPROOT/port"
render "$D" PGBOUNCER_UPSTREAM_URL='postgres://u:p@db.example.test/brain'
[ "$RC" -eq 0 ] && grep -q '^brain = host=db.example.test port=5432 dbname=brain$' "$D/pgbouncer.ini" && pass "port defaults to 5432" || die "default port (rc=$RC)"

before=$FAIL
for bad in \
    "PGBOUNCER_UPSTREAM_URL=" \
    "PGBOUNCER_UPSTREAM_URL=mysql://u:p@h/db" \
    "PGBOUNCER_UPSTREAM_URL=postgres://u@h/db" \
    "PGBOUNCER_UPSTREAM_URL=postgres://u:p@h" \
    "PGBOUNCER_UPSTREAM_URL=postgres://u:p%22x@h/db" \
    'PGBOUNCER_UPSTREAM_URL=postgres://u:p"x@h/db' \
    "PGBOUNCER_UPSTREAM_URL=postgres://u:p@h/db name" \
    "PGBOUNCER_UPSTREAM_URL=postgres://u:p@[::1]/db" \
    "PGBOUNCER_UPSTREAM_URL=postgres://u:p@h:port/db"; do
  D="$TMPROOT/bad$RANDOM"
  render "$D" "$bad"
  if [ "$RC" -eq 0 ]; then die "accepted $bad"; fi
  if [ -e "$D/userlist.txt" ]; then die "wrote a userlist for $bad"; fi
done
D="$TMPROOT/badmode"
render "$D" PGBOUNCER_UPSTREAM_URL="$URL" PGBOUNCER_SERVER_TLS_SSLMODE=sometimes
[ "$RC" -ne 0 ] || die "accepted server_tls_sslmode=sometimes"
D="$TMPROOT/badpool"
render "$D" PGBOUNCER_UPSTREAM_URL="$URL" PGBOUNCER_DEFAULT_POOL_SIZE=0
[ "$RC" -ne 0 ] || die "accepted default_pool_size 0"
[ "$FAIL" -eq "$before" ] && pass "refuses a missing or unquotable URL, an unknown sslmode and a zero pool"

echo "== Dockerfile =="
from="$(grep -m1 '^FROM ' "$DOCKERFILE")"
if [[ "$from" =~ ^FROM\ alpine:[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64}$ ]]; then pass "base image pinned by version and digest"; else die "FROM: '$from'"; fi
if grep -Eq 'apk add --no-cache pgbouncer=[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+' "$DOCKERFILE"; then pass "pgbouncer package pinned by version"; else die "pgbouncer package not pinned"; fi
if grep -q '1\.21' "$DOCKERFILE" && grep -q 'pgbouncer --version' "$DOCKERFILE"; then pass "the build checks the version is at least 1.21"; else die "no build-time version gate"; fi
if grep -Eq '^USER [a-z]' "$DOCKERFILE" && ! grep -Eq '^USER root' "$DOCKERFILE"; then pass "runs as a non-root user"; else die "no non-root USER"; fi
