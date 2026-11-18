#!/usr/bin/env bash
# Isolation smoke for one tenant container on a hosting host. A tenant's
# container serves nothing but /health until this passes after its start
# (it answers 503 isolation_unverified), so run it after every start:
# deploy-tenants.sh does, and deploy/tenant/smoke-all.sh does for all of them
# after a reboot or a Docker update.
#
#   bash scripts/tenant-isolation-smoke.sh <id> [--no-record]
#
# Checks, from inside memrain-<id> unless noted:
#   host     the container runs, sits on exactly one network
#            (memrain_tenant_<id>) and has no secrets or AWS config mounted
#   rds      its own database host answers on TCP
#   bedrock  bedrock-runtime.<region>.amazonaws.com:443 answers
#   neighbour  every other tenant container, by name and by IP, does not
#   imds     the instance metadata service does not answer
#   secrets  another tenant's secret cannot be read (no credentials, or
#            AccessDenied)
# On a pass it records the result in control (`memrain tenant smoke-record`),
# unless --no-record. Prints no secret.
#
# Debug and test knobs (shell env; never set them on a live host):
#   SMOKE_BEDROCK_ADDR, SMOKE_IMDS_ADDR (host:port), SMOKE_SERVICE_PORT
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/tenant/lib.sh
. "${REPO_ROOT}/deploy/tenant/lib.sh"

usage() { echo "usage: $0 <tenant-id> [--no-record]" >&2; exit 2; }
[ $# -ge 1 ] && [ $# -le 2 ] || usage
ID="$1"
RECORD=1
if [ $# -eq 2 ]; then [ "$2" = "--no-record" ] || usage; RECORD=0; fi
valid_tenant_id "$ID" || { echo "FAIL: '${ID}' is not a tenant id" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required" >&2; exit 1; }

C="memrain-${ID}"
PORT="${SMOKE_SERVICE_PORT:-18790}"

# env_value KEY -> KEY from the shell, else the last KEY= line of $ENV_FILE.
env_value() {
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f "$ENV_FILE" ]; then
    v="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  fi
  printf '%s' "$v"
}
REGION="$(env_value AWS_REGION)"
PREFIX="$(env_value SECRETS_PREFIX)"
PREFIX="${PREFIX:-memex}"

fail() { echo "FAIL $*"; echo "isolation smoke for ${ID}: FAILED (not recorded)"; exit 1; }

echo "== isolation smoke: ${C} =="

# ---- From the host: the container's own shape ------------------------------
INFO="$(docker inspect "$C" 2>/dev/null)" || fail "host: ${C} does not exist"
[ "$(jq -r '.[0].State.Running' <<< "$INFO")" = "true" ] || fail "host: ${C} is not running"
NETS="$(jq -r '.[0].NetworkSettings.Networks | keys | join(",")' <<< "$INFO")"
[ "$NETS" = "memrain_tenant_${ID}" ] || fail "host: ${C} is on '${NETS}', not only memrain_tenant_${ID}"
BAD_MOUNT="$(jq -r '.[0].Mounts // [] | .[].Source | select(test("/\\.secrets(/|$)|/\\.aws(/|$)"))' <<< "$INFO" | head -1)"
[ -z "$BAD_MOUNT" ] || fail "host: ${C} mounts ${BAD_MOUNT}"
echo "ok host (one network, no secrets mounted)"

# ---- Neighbours: every other tenant with a running container ---------------
NEIGHBOURS=() FIRST_NEIGHBOUR=""
for f in "${TENANTS_DIR}"/*.yml; do
  [ -e "$f" ] || continue
  other="$(basename "$f" .yml)"
  if [ "$other" = "$ID" ] || ! valid_tenant_id "$other"; then continue; fi
  [ -n "$FIRST_NEIGHBOUR" ] || FIRST_NEIGHBOUR="$other"
  oinfo="$(docker inspect "memrain-${other}" 2>/dev/null)" || { echo "note: memrain-${other} has no container; skipped"; continue; }
  [ "$(jq -r '.[0].State.Running' <<< "$oinfo")" = "true" ] || { echo "note: memrain-${other} is not running; skipped"; continue; }
  NEIGHBOURS+=("memrain-${other}:${PORT}")
  while IFS= read -r ip; do
    [ -n "$ip" ] && NEIGHBOURS+=("${ip}:${PORT}")
  done < <(jq -r '.[0].NetworkSettings.Networks[]?.IPAddress // empty' <<< "$oinfo")
done
FOREIGN="${PREFIX}/tenants/${FIRST_NEIGHBOUR:-smoke-probe}/postgres-url"

# ---- From inside the container ---------------------------------------------
PROBE="$(cat "${HOSTING_DIR}/isolation-probe.js")"
NEIGHBOUR_LIST="$(IFS=,; printf '%s' "${NEIGHBOURS[*]+"${NEIGHBOURS[*]}"}")"
if ! docker exec \
    -e PROBE_BEDROCK="${SMOKE_BEDROCK_ADDR:-bedrock-runtime.${REGION:-eu-west-1}.amazonaws.com:443}" \
    -e PROBE_NEIGHBOURS="$NEIGHBOUR_LIST" \
    -e PROBE_IMDS="${SMOKE_IMDS_ADDR:-169.254.169.254:80}" \
    -e PROBE_FOREIGN_SECRET="$FOREIGN" \
    "$C" bun -e "$PROBE"; then
  echo "isolation smoke for ${ID}: FAILED (not recorded)"
  exit 1
fi

if [ "$RECORD" = 1 ]; then
  hosting_files
  hosting_ctl tenant smoke-record "$ID" || { echo "FAIL record: tenant smoke-record ${ID} failed"; exit 1; }
  echo "isolation smoke for ${ID}: passed and recorded"
else
  echo "isolation smoke for ${ID}: passed (not recorded)"
fi
