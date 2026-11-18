#!/usr/bin/env bash
# tests/fetch-secrets-tenant.test.sh — deploy/secrets/fetch-secrets.sh
# --tenant <id> and --control on a hosting host.
#
# --tenant writes .secrets/tenants/<id>.env (0400) from
# <prefix>/tenants/<id>/{postgres-url,control-url,internal-token}, or from
# <dir>/<id>/<name> with TENANT_SECRETS_BACKEND=file. --control writes
# .secrets/hosting-control.env from <prefix>/hosting/control-admin-url.
# All-or-nothing like the default run, never prints a value, and never
# touches the single-tenant files.
set -uo pipefail

# shellcheck source=/dev/null
. "$(cd "$(dirname "$0")" && pwd)/lib/secrets-stub.sh"

PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t fetch-secrets-tenant.XXXXXX)"
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "fetch-secrets-tenant.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

# Values are assembled here so no DSN-shaped literal sits in the file.
SCHEME="postgres"
PG_ACME="${SCHEME}://tenant_acme_owner:pw-acme@db.example.test:5432/tenant_acme"
CTL_ACME="${SCHEME}://tenant_acme_ctl:pw-ctl@db.example.test:5432/memrain_control"
TOK_ACME="tok-acme-$(printf 'a%.0s' $(seq 1 40))"
TOK_BETA="tok-beta-$(printf 'b%.0s' $(seq 1 40))"
ADMIN_URL="${SCHEME}://master:pw-master@db.example.test:5432/memrain_control"

N=0
ws_new() {
  N=$((N + 1))
  WS="$TMPROOT/ws$N"
  new_secrets_workspace "$WS"
  export STUB_DIR="$WS/stub"
  printf 'SECRETS_PREFIX=hst\n' >> "$WS/.env"
  TDIR="$WS/deploy/.secrets/tenants"
  OUT="$TDIR/acme.env"
}

seed_acme() {
  stub_secret "hst/tenants/acme/postgres-url" "$PG_ACME"
  stub_secret "hst/tenants/acme/control-url" "$CTL_ACME"
  stub_secret "hst/tenants/acme/internal-token" "$TOK_ACME"
}

# A good earlier file for acme, owner-writable so a stray overwrite would not
# fail on EACCES and pass by accident.
seed_previous() {
  mkdir -p "$TDIR"
  printf 'MEMRAIN_POSTGRES_URL=previous\n' > "$OUT"
  chmod 0600 "$OUT"
  cp "$OUT" "$WS/prev"
}

no_values_in_output() { ! grep -Eq 'pw-acme|pw-ctl|pw-master|tok-acme|tok-beta' "$WS/out.log"; }
# fetch [VAR=value ...] -- [ARG ...] -> runs fetch-secrets.sh with ARGs in a clean
# env holding the VARs, the stub aws first on PATH; output in $WS/out.log.
fetch() {
  local vars=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do vars+=("$1"); shift; done
  shift
  env -i PATH="$WS/stub/bin:/usr/bin:/bin" HOME="$WS" STUB_DIR="$WS/stub" ${vars[@]+"${vars[@]}"} \
    bash "$WS/deploy/secrets/fetch-secrets.sh" "$@" > "$WS/out.log" 2>&1
}
calls() { cat "$WS/stub/calls.log" 2>/dev/null; }
val() { sed -n "s/^$1=//p" "$OUT"; }

echo "== fetch-secrets.sh --tenant (aws) =="

ws_new; seed_acme
if fetch -- --tenant acme; then pass "fetches a tenant's secrets"; else die "tenant fetch failed"; cat "$WS/out.log"; fi
if [ "$(val MEMRAIN_POSTGRES_URL)" = "$PG_ACME" ] && [ "$(val MEMRAIN_CONTROL_URL)" = "$CTL_ACME" ] \
   && [ "$(val MEMRAIN_INTERNAL_TOKEN)" = "$TOK_ACME" ] && [ "$(wc -l < "$OUT" | tr -d ' ')" = 3 ]; then
  pass "acme.env holds exactly its database URL, control URL and internal token"
else
  die "acme.env content wrong"
fi
if [ "$(file_mode "$OUT")" = 400 ] && [ "$(file_mode "$TDIR")" = 700 ]; then pass "file 0400 in a 0700 directory"; else die "modes: file $(file_mode "$OUT") dir $(file_mode "$TDIR")"; fi
if no_values_in_output; then pass "no value printed"; else die "a value reached the output"; fi
if calls | grep -v ' hst/tenants/acme/' | grep -q .; then die "read a secret outside hst/tenants/acme/: $(calls | grep -v ' hst/tenants/acme/' | head -1)"; else pass "reads only hst/tenants/acme/*"; fi
if [ ! -e "$WS/deploy/.secrets/memrain.env" ] && [ ! -e "$WS/deploy/.secrets/cloudflared.env" ]; then
  pass "the single-tenant files are not written"
else
  die "tenant mode wrote memrain.env or cloudflared.env"
fi
if grep -q 'PUBLIC_BEARER' "$OUT"; then die "a public bearer in the tenant file"; else pass "no public bearer in the tenant file"; fi

ws_new; seed_acme; seed_previous
rm -f "$WS/stub/secrets/hst__tenants__acme__internal-token"
if fetch -- --tenant acme; then die "a missing internal token was accepted"; else pass "a missing secret fails the run"; fi
if cmp -s "$OUT" "$WS/prev" && [ -z "$(find "$TDIR" -name '*.tmp.*')" ]; then pass "the previous file is byte-identical, no temp left"; else die "previous file changed or temp left"; fi

ws_new; seed_acme; seed_previous
stub_denyget "hst/tenants/acme/control-url" AccessDeniedException
if fetch -- --tenant acme; then die "AccessDenied was accepted"; else pass "AccessDenied fails the run"; fi
if cmp -s "$OUT" "$WS/prev"; then pass "AccessDenied leaves the previous file"; else die "AccessDenied changed the file"; fi

before=$FAIL
for bad in A x 'acme/../beta' 'acme;id' '' "$(printf 'a%.0s' $(seq 1 32))"; do
  ws_new; seed_acme
  if fetch -- --tenant "$bad"; then die "accepted tenant id '$bad'"; fi
  if [ -s "$WS/stub/calls.log" ]; then die "called aws for invalid id '$bad'"; fi
done
[ "$FAIL" -eq "$before" ] && pass "invalid tenant ids refused before any AWS call"

ws_new
stub_secret "hst/tenants/acme/postgres-url" "mysql://x"
stub_secret "hst/tenants/acme/control-url" "$CTL_ACME"
stub_secret "hst/tenants/acme/internal-token" "$TOK_ACME"
if fetch -- --tenant acme; then die "a non-Postgres URL was accepted"; else pass "a database URL that is not postgres:// is refused"; fi
ws_new; seed_acme
stub_secret "hst/tenants/acme/internal-token" "short"
if fetch -- --tenant acme; then die "a short internal token was accepted"; else pass "an internal token under 32 characters is refused"; fi

ws_new; seed_acme
mkdir -p "$TDIR"; printf 'MEMRAIN_INTERNAL_TOKEN=%s\n' "$TOK_ACME" > "$TDIR/beta.env"
if fetch -- --tenant acme; then die "a token shared with beta was accepted"; else pass "an internal token another tenant already holds is refused"; fi
if [ ! -e "$OUT" ] && no_values_in_output; then pass "nothing written, the shared token not printed"; else die "written or printed after the shared-token refusal"; fi
printf 'MEMRAIN_INTERNAL_TOKEN=%s\n' "$TOK_BETA" > "$TDIR/beta.env"
if fetch -- --tenant acme; then pass "distinct tokens are fine"; else die "distinct tokens refused"; cat "$WS/out.log"; fi

echo "== fetch-secrets.sh --tenant (file backend) =="

ws_new
SRC="$WS/src"; mkdir -p "$SRC/acme"; chmod 0700 "$SRC" "$SRC/acme"
printf '%s' "$PG_ACME" > "$SRC/acme/postgres-url"
printf '%s\n' "$CTL_ACME" > "$SRC/acme/control-url"
printf '%s' "$TOK_ACME" > "$SRC/acme/internal-token"
chmod 0600 "$SRC/acme/"*
sed -i.bak '/^AWS_REGION=/d' "$WS/.env"
if fetch TENANT_SECRETS_BACKEND=file TENANT_SECRETS_DIR="$SRC" -- --tenant acme; then
  pass "file backend works without AWS_REGION"
else
  die "file backend failed"; cat "$WS/out.log"
fi
if [ "$(val MEMRAIN_CONTROL_URL)" = "$CTL_ACME" ] && [ ! -s "$WS/stub/calls.log" ]; then pass "file backend: trailing newline stripped, no AWS call"; else die "file backend content or AWS call"; fi
chmod 0644 "$SRC/acme/internal-token"
if fetch TENANT_SECRETS_BACKEND=file TENANT_SECRETS_DIR="$SRC" -- --tenant acme; then die "a world-readable source file was accepted"; else pass "a group/world-readable source file is refused"; fi
chmod 0600 "$SRC/acme/internal-token"
mv "$SRC/acme/internal-token" "$SRC/acme/real-token"; ln -s "$SRC/acme/real-token" "$SRC/acme/internal-token"
if fetch TENANT_SECRETS_BACKEND=file TENANT_SECRETS_DIR="$SRC" -- --tenant acme; then die "a symlinked source file was accepted"; else pass "a symlinked source file is refused"; fi
if fetch TENANT_SECRETS_BACKEND=nope -- --tenant acme; then die "unknown backend accepted"; else pass "an unknown backend is refused"; fi

echo "== fetch-secrets.sh --control =="

ws_new
stub_secret "hst/hosting/control-admin-url" "$ADMIN_URL"
if fetch -- --control; then pass "fetches the control admin URL"; else die "--control failed"; cat "$WS/out.log"; fi
C="$WS/deploy/.secrets/hosting-control.env"
if [ "$(sed -n 's/^MEMRAIN_CONTROL_ADMIN_URL=//p' "$C")" = "$ADMIN_URL" ] && [ "$(file_mode "$C")" = 400 ]; then
  pass "hosting-control.env holds MEMRAIN_CONTROL_ADMIN_URL, 0400"
else
  die "hosting-control.env wrong"
fi
if no_values_in_output; then pass "no value printed"; else die "admin URL printed"; fi
ws_new
SRC="$WS/src"; mkdir -p "$SRC/_hosting"; chmod 0700 "$SRC" "$SRC/_hosting"
printf '%s' "$ADMIN_URL" > "$SRC/_hosting/control-admin-url"; chmod 0600 "$SRC/_hosting/control-admin-url"
if fetch TENANT_SECRETS_BACKEND=file TENANT_SECRETS_DIR="$SRC" -- --control && [ -s "$WS/deploy/.secrets/hosting-control.env" ]; then
  pass "--control with the file backend reads <dir>/_hosting/control-admin-url"
else
  die "--control file backend failed"
fi

echo "== arguments =="
ws_new
if fetch -- --bogus; then die "an unknown argument was accepted"; else pass "an unknown argument is refused"; fi
if fetch -- --tenant; then die "--tenant without an id was accepted"; else pass "--tenant needs an id"; fi
if [ ! -s "$WS/stub/calls.log" ]; then pass "a refused argument makes no AWS call"; else die "AWS called after a refused argument"; fi
