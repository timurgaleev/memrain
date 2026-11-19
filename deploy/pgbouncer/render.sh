#!/bin/sh
# Render pgbouncer.ini and its userlist from one upstream URL. The image's
# entrypoint runs it, then execs pgbouncer; tests/pgbouncer-render.test.sh
# runs it on its own. Prints no secret.
#
# Env:
#   PGBOUNCER_UPSTREAM_URL       postgres://user:password@host[:port]/database
#                                (required). The pooler serves that database
#                                only, logging in as that user.
#   PGBOUNCER_SERVER_TLS_SSLMODE TLS to the upstream: require (default, RDS),
#                                disable (a local container), or any other
#                                libpq sslmode.
#   PGBOUNCER_DEFAULT_POOL_SIZE  server connections per database/user pair
#                                (default 3).
#   PGBOUNCER_ANY_DATABASE       1 also serves every other database on the
#                                upstream. For scripts/test-pg.sh only, which
#                                creates a database per test file.
#   PGBOUNCER_RUN_DIR            where both files go (default /run/pgbouncer).
set -eu

TEMPLATE="$(dirname "$0")/pgbouncer.ini.tmpl"
RUN_DIR="${PGBOUNCER_RUN_DIR:-/run/pgbouncer}"
URL="${PGBOUNCER_UPSTREAM_URL:-}"
SSLMODE="${PGBOUNCER_SERVER_TLS_SSLMODE:-require}"
POOL="${PGBOUNCER_DEFAULT_POOL_SIZE:-3}"

die() { echo "[pgbouncer] FATAL: $*" >&2; exit 78; }

case "$URL" in
  postgres://*|postgresql://*) ;;
  *) die "PGBOUNCER_UPSTREAM_URL is not a postgres:// URL" ;;
esac
rest="${URL#*://}"
rest="${rest%%\?*}"
case "$rest" in *@*/*) ;; *) die "PGBOUNCER_UPSTREAM_URL needs user:password@host/database" ;; esac
creds="${rest%%@*}"
hostpart="${rest#*@}"
user="${creds%%:*}"
[ "$user" != "$creds" ] || die "PGBOUNCER_UPSTREAM_URL has no password"
password="${creds#*:}"
db="${hostpart#*/}"
host="${hostpart%%/*}"
port=5432
case "$host" in *:*) port="${host##*:}"; host="${host%:*}" ;; esac

# Every value lands unquoted in the ini or inside double quotes in the
# userlist, so only characters that need no quoting or decoding pass.
safe() { printf '%s' "$2" | grep -Eq "^$3\$" || die "PGBOUNCER_UPSTREAM_URL: the $1 holds a character this pooler config cannot carry"; }
safe user "$user" '[A-Za-z0-9_.-]+'
safe password "$password" '[A-Za-z0-9_.~-]+'
safe host "$host" '[A-Za-z0-9.-]+'
safe port "$port" '[0-9]{1,5}'
safe database "$db" '[A-Za-z0-9_-]+'

case "$SSLMODE" in
  disable|allow|prefer|require|verify-ca|verify-full) ;;
  *) die "PGBOUNCER_SERVER_TLS_SSLMODE must be a libpq sslmode, got '${SSLMODE}'" ;;
esac
printf '%s' "$POOL" | grep -Eq '^[1-9][0-9]{0,2}$' || die "PGBOUNCER_DEFAULT_POOL_SIZE must be 1-999"

own="${db} = host=${host} port=${port} dbname=${db}"
any=""
if [ "${PGBOUNCER_ANY_DATABASE:-}" = 1 ]; then any="* = host=${host} port=${port}"; fi

mkdir -p "$RUN_DIR"
umask 077
awk -v own="$own" -v any="$any" -v mode="$SSLMODE" -v pool="$POOL" -v auth="$RUN_DIR/userlist.txt" '
  $0 == "@DATABASES@" { print own; if (any != "") print any; next }
  { gsub(/@SERVER_TLS_SSLMODE@/, mode); gsub(/@DEFAULT_POOL_SIZE@/, pool); gsub(/@AUTH_FILE@/, auth); print }
' "$TEMPLATE" > "$RUN_DIR/pgbouncer.ini.tmp"
mv -f "$RUN_DIR/pgbouncer.ini.tmp" "$RUN_DIR/pgbouncer.ini"
printf '"%s" "%s"\n' "$user" "$password" > "$RUN_DIR/userlist.txt.tmp"
chmod 0600 "$RUN_DIR/userlist.txt.tmp"
mv -f "$RUN_DIR/userlist.txt.tmp" "$RUN_DIR/userlist.txt"
echo "[pgbouncer] serving ${db} from ${host}:${port} (server_tls_sslmode ${SSLMODE}, pool ${POOL})"
