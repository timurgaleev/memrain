#!/usr/bin/env bash
# shellcheck disable=SC2016  # jq filters below are single-quoted on purpose
# tests/tenant-compose.test.sh — scripts/tenant-render.sh and the tenant
# container template (deploy/tenant/tenant.yml.tmpl).
#
# The rendered file must carry no secret, give the container exactly one
# network (its own), read only its own secrets file, and switch on the
# hosting env (oauth-only public auth, no internal path, member-only, fail
# closed). With docker installed, the rendered set also goes through
# `docker compose config`, which is what deploy-tenants.sh runs first.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPROOT="$(mktemp -d -t tenant-compose.XXXXXX)"
PASS=0
FAIL=0
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "tenant-compose.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

WS="$TMPROOT/ws"
mkdir -p "$WS/deploy/tenant" "$WS/deploy/.secrets/tenants" "$WS/scripts"
cp "$REPO_ROOT/deploy/tenant/"* "$WS/deploy/tenant/"
cp "$REPO_ROOT/scripts/tenant-render.sh" "$WS/scripts/"
printf 'AWS_REGION=eu-west-1\n' > "$WS/.env"

render() { RC=0; (cd "$WS" && bash scripts/tenant-render.sh "$@") > "$WS/out.log" 2>&1 || RC=$?; }

echo "== tenant-render.sh =="

render acme --host acme.example.test
F="$WS/deploy/tenants/acme.yml"
if [ "$RC" -eq 0 ] && [ -f "$F" ]; then pass "renders deploy/tenants/acme.yml"; else die "render failed (rc=$RC)"; cat "$WS/out.log"; fi
if grep -q '@[A-Z_]*@' "$F"; then die "placeholders left in the rendered file"; else pass "no placeholder left"; fi
if grep -Eiq 'postgres(ql)?://|TOKEN=|BEARER=|PASSWORD' "$F"; then die "a secret-shaped literal in the rendered file"; else pass "no secret literal in the rendered file"; fi
if grep -q 'MEMRAIN_PUBLIC_URL=https://acme.example.test$' "$F"; then pass "public URL from --host"; else die "public URL missing"; fi
if grep -q 'MEMRAIN_PUBLIC_BEARER' "$F"; then die "the template sets a static public bearer"; else pass "no static public bearer"; fi

render acme --host acme.example.test
if [ "$RC" -ne 0 ]; then pass "an existing tenant file is not overwritten"; else die "overwrote an existing tenant file"; fi
render acme --host other.example.test --force
if [ "$RC" -eq 0 ] && grep -q 'https://other.example.test$' "$F"; then pass "--force re-renders"; else die "--force did not re-render"; fi

for bad in 'A' 'x' '9abc' 'a_b' 'acme;rm' '../acme' "$(printf 'a%.0s' $(seq 1 32))"; do
  render "$bad" --host ok.example.test
  if [ "$RC" -eq 0 ]; then die "accepted tenant id '$bad'"; fi
done
[ "$FAIL" -eq 0 ] && pass "invalid tenant ids refused"
for bad in 'http://acme.example.test' 'acme' 'acme.example.test/x' 'acme.example.test"' 'ACME.example.test' 'a b.example.test' '-acme.example.test'; do
  render beta --host "$bad"
  if [ "$RC" -eq 0 ]; then die "accepted host '$bad'"; fi
done
if [ ! -e "$WS/deploy/tenants/beta.yml" ]; then pass "invalid hosts refused, nothing written"; else die "a file was written for an invalid host"; fi

render beta --host beta.example.test
[ "$RC" -eq 0 ] || die "render beta failed"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo "  (docker compose or jq not available — skipping the compose config checks)"
  exit 0
fi

echo "== docker compose config over the hosting file set =="

printf 'MEMRAIN_POSTGRES_URL=postgres://acme_owner:pw@db.example.test:5432/tenant_acme\nMEMRAIN_CONTROL_URL=postgres://acme_ctl:pw@db.example.test:5432/memrain_control\nMEMRAIN_INTERNAL_TOKEN=token-acme-0123456789abcdef0123456789\n' > "$WS/deploy/.secrets/tenants/acme.env"
printf 'MEMRAIN_POSTGRES_URL=postgres://beta_owner:pw@db.example.test:5432/tenant_beta\nMEMRAIN_CONTROL_URL=postgres://beta_ctl:pw@db.example.test:5432/memrain_control\nMEMRAIN_INTERNAL_TOKEN=token-beta-0123456789abcdef01234567890\n' > "$WS/deploy/.secrets/tenants/beta.env"

CFG="$TMPROOT/config.json"
if (cd "$WS" && docker compose --env-file .env -f deploy/tenant/compose.hosting.yml \
      -f deploy/tenants/acme.yml -f deploy/tenants/beta.yml config --format json) > "$CFG" 2> "$TMPROOT/config.err"; then
  pass "the hosting file set passes docker compose config"
else
  die "docker compose config failed:"; sed 's/^/      /' "$TMPROOT/config.err"; exit 1
fi

# svc SERVICE FILTER -> jq FILTER with $s bound to SERVICE (single-quoted on
# purpose at every call site).
svc() { jq -r --arg s "$1" "$2" "$CFG"; }

nets="$(svc memrain-acme '.services[$s].networks | keys | join(",")')"
if [ "$nets" = "tenant-acme" ] && [ "$(jq -r '.networks["tenant-acme"].name' "$CFG")" = "memrain_tenant_acme" ]; then
  pass "memrain-acme is on exactly one network: memrain_tenant_acme"
else
  die "memrain-acme networks: '$nets'"
fi
if [ "$(jq -r '.networks["tenant-acme"].internal // false' "$CFG")" = "false" ] && [ "$(jq -r '.networks["tenant-acme"].driver' "$CFG")" = "bridge" ]; then
  pass "the tenant network is a plain bridge (outbound NAT to RDS and Bedrock stays)"
else
  die "tenant network is not a plain bridge"
fi
cf="$(svc cloudflared '.services[$s].networks | keys | sort | join(",")')"
if [ "$cf" = "egress,tenant-acme,tenant-beta" ]; then pass "cloudflared joins every tenant network"; else die "cloudflared networks: '$cf'"; fi
if [ "$(svc memrain-acme '.services[$s].container_name')" = "memrain-acme" ]; then pass "container is named memrain-<id>"; else die "container name wrong"; fi

env_of() { jq -r --arg s "$1" --arg k "$2" '.services[$s].environment[$k] // empty' "$CFG"; }
ok=1
for kv in MEMRAIN_TENANT_ID=acme MEMRAIN_PUBLIC_AUTH=oauth MEMRAIN_ASSUME_PUBLIC=1 MEMRAIN_APP=1 \
          MEMRAIN_REQUIRE_MEMBER=1 MEMRAIN_TENANT_FAIL_CLOSED=1 MEMRAIN_REQUIRE_POSTGRES=1 \
          MEMRAIN_PG_POOL_MAX=4 MEMRAIN_PG_APPLICATION_NAME=memrain:acme:serve; do
  [ "$(env_of memrain-acme "${kv%%=*}")" = "${kv#*=}" ] || { ok=0; echo "      ${kv%%=*}='$(env_of memrain-acme "${kv%%=*}")', want '${kv#*=}'"; }
done
if [ "$ok" = 1 ]; then pass "hosting env: tenant id, oauth-only, no internal path, member-only, fail closed, pool 4"; else die "hosting env wrong"; fi
if [ -z "$(env_of memrain-acme MEMRAIN_PUBLIC_BEARER)" ] && [ -z "$(env_of memrain-acme MEMRAIN_ADMIN_TOKEN)" ]; then
  pass "no public bearer and no admin bootstrap reach the tenant"
else
  die "public bearer or admin token reaches the tenant"
fi
ta="$(env_of memrain-acme MEMRAIN_INTERNAL_TOKEN)"; tb="$(env_of memrain-beta MEMRAIN_INTERNAL_TOKEN)"
if [ -n "$ta" ] && [ -n "$tb" ] && [ "$ta" != "$tb" ]; then pass "each tenant gets its own internal token from its own file"; else die "internal tokens missing or shared"; fi
case "$(env_of memrain-acme MEMRAIN_POSTGRES_URL)" in
  *tenant_acme) pass "memrain-acme gets only its own database URL" ;;
  *) die "memrain-acme database URL is not its own" ;;
esac
mounts="$(svc memrain-acme '[.services[$s].volumes[]?.source] | join(",")')"
if printf '%s' "$mounts" | grep -Eq '\.secrets|\.aws'; then die "a secrets or AWS directory is mounted: $mounts"; else pass "no secrets or AWS config is mounted into the tenant"; fi
if [ "$(svc memrain-acme '.services[$s].cap_drop | join(",")')" = "ALL" ] \
   && [ "$(svc memrain-acme '.services[$s].pull_policy')" = "never" ] \
   && [ "$(svc memrain-acme '.services[$s].mem_limit // empty')" != "" ]; then
  pass "caps dropped, image never pulled, memory capped"
else
  die "hardening missing"
fi
if [ "$(svc memrain-acme '.services[$s].ports // [] | length')" = "0" ]; then pass "no published port"; else die "memrain-acme publishes a port"; fi
