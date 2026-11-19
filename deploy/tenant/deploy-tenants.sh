#!/usr/bin/env bash
# Deploy every tenant of a hosting host, one at a time. deploy/deploy.sh hands
# over to this script when deploy/tenants/*.yml exists; a host without that
# directory never gets here.
#
# Order:
#   1. preflights (jq, timeout, the compose set parses)
#   2. build the image once, stamped with `git describe`
#   3. migrate the control database. A failure stops the deploy before any
#      tenant is touched.
#   4. list every tenant except deleting/deleted, so a suspended one never
#      falls behind on schema
#   5. per tenant, in id order: migrate its database, recreate its container,
#      wait for healthy, check the stamp, run the isolation smoke (which
#      records the pass in control). Until that record exists the container
#      answers 503 isolation_unverified on everything but /health.
#   6. refresh cloudflared, so it joins any new tenant network
#
# The first failure stops the loop: tenants already done stay on the new
# version, the rest stay on the old one, and nothing is rolled back. The
# report goes to deploy/tenants/.deploy-report and to stdout.
#
# Knobs (shell env):
#   HEALTH_TIMEOUT_S        seconds to wait for a container to report healthy
#                           (default 180)
#   DEPLOY_STATUS_TIMEOUT   seconds one /health read may take (default 60)
set -euo pipefail

# shellcheck source=deploy/tenant/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"
STATUS_TIMEOUT="${DEPLOY_STATUS_TIMEOUT:-60}"
REPORT="${TENANTS_DIR}/.deploy-report"
SMOKE="${DEPLOY_DIR}/../scripts/tenant-isolation-smoke.sh"

command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required (dnf install -y jq)" >&2; exit 1; }
command -v timeout >/dev/null 2>&1 || { echo "FAIL: timeout is required (dnf install -y coreutils)" >&2; exit 1; }
if ! [[ "$HEALTH_TIMEOUT_S" =~ ^[0-9]+$ ]] || ! [[ "$STATUS_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  echo "FAIL: HEALTH_TIMEOUT_S and DEPLOY_STATUS_TIMEOUT must be integers" >&2
  exit 1
fi

hosting_files

REPORT_LINES=()
note() { REPORT_LINES+=("$*"); }
write_report() {
  { printf '# deploy %s at %s\n' "${MEMRAIN_VERSION:-?}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    [ "${#REPORT_LINES[@]}" -eq 0 ] || printf '%s\n' "${REPORT_LINES[@]}"; } > "$REPORT.tmp"
  mv -f "$REPORT.tmp" "$REPORT"
  echo "==> tenant deploy report (${REPORT}):"
  sed 's/^/    /' "$REPORT"
}

# ---- Preflights: nothing is touched until all of them pass -----------------

# A hosting host runs no single-tenant brain: its container would hold the
# instance role and the host's single-tenant secrets next to the tenants.
if [ "$(docker inspect deploy-memrain-1 --format '{{.State.Running}}' 2>/dev/null || true)" = "true" ]; then
  echo "FAIL: the single-tenant brain (deploy-memrain-1) runs on this hosting host; stop it first (docs/HOSTING.md)" >&2
  exit 1
fi

if ! hosting_compose config -q; then
  echo "FAIL: docker compose cannot parse the hosting file set (deploy/tenant/compose.hosting.yml + deploy/tenants/*.yml)" >&2
  exit 1
fi

# ---- Build once, then the control plane ------------------------------------

MEMRAIN_VERSION="$(git describe --tags --match 'v[0-9]*' --always --dirty)"
export MEMRAIN_VERSION
echo "==> building the tenant image stamped ${MEMRAIN_VERSION}"
hosting_compose build tenant-ctl

echo "==> migrating the control database"
if ! hosting_ctl tenant migrate-control; then
  echo "FAIL: control migrations failed; no tenant was touched" >&2
  exit 1
fi

if ! LIST="$(hosting_ctl tenant list --json --status active,suspended,provisioning)" \
   || ! printf '%s' "$LIST" | jq -e '.ok == true and (.tenants | type == "array")' >/dev/null 2>&1; then
  echo "FAIL: cannot read the tenant list from control; no tenant was touched" >&2
  exit 1
fi

# id<TAB>status per tenant, in id order. Every id is checked before the first
# tenant is migrated: a bad row stops the deploy, it is not skipped.
ROWS="$(printf '%s' "$LIST" | jq -r '.tenants | sort_by(.id) | .[] | "\(.id)\t\(.status)"')"
PLAN=()
while IFS=$'\t' read -r id status; do
  [ -n "$id" ] || continue
  if ! valid_tenant_id "$id"; then
    echo "FAIL: control lists a tenant id that is not one: '${id}'; no tenant was touched" >&2
    exit 1
  fi
  case "$status" in
    active|suspended)
      if [ ! -f "${TENANTS_DIR}/${id}.yml" ]; then
        echo "FAIL: tenant ${id} is ${status} but ${TENANTS_DIR}/${id}.yml is missing (scripts/tenant-render.sh); no tenant was touched" >&2
        exit 1
      fi ;;
    provisioning) ;;
    deleting|deleted) note "${id} skipped (${status})"; continue ;;
    *) echo "FAIL: tenant ${id} has unknown status '${status}'; no tenant was touched" >&2; exit 1 ;;
  esac
  PLAN+=("${id}:${status}")
done <<< "$ROWS"

# ---- One tenant at a time --------------------------------------------------

# fail_at ID STEP MESSAGE -> report the failure and every tenant not reached.
fail_at() {
  local id="$1" step="$2" i reached=0
  shift 2
  echo "FAIL: tenant ${id}: $*" >&2
  note "${id} FAILED ${step}"
  for i in "${PLAN[@]}"; do
    if [ "$reached" = 1 ]; then note "${i%%:*} not reached"; fi
    [ "${i%%:*}" = "$id" ] && reached=1
  done
  write_report
  exit 1
}

deploy_one() {
  local id="$1" status="$2" container="memrain-$1" deadline health running
  echo "==> tenant ${id} (${status}): migrating"
  hosting_ctl tenant migrate "$id" || fail_at "$id" migrate "brain migrations failed"
  if [ ! -f "${TENANTS_DIR}/${id}.yml" ]; then
    note "${id} migrated (no container yet)"
    return 0
  fi

  if hosting_pooler; then
    # The tenant's own pooler (profile pooler; naming it starts it). Built on
    # first use from deploy/pgbouncer, left alone when nothing changed.
    echo "==> tenant ${id}: starting pgbouncer-${id}"
    hosting_compose up -d --no-deps "pgbouncer-${id}" \
      || fail_at "$id" pooler "docker compose could not start pgbouncer-${id}"
  fi

  echo "==> tenant ${id}: recreating ${container}"
  hosting_compose up -d --no-build --no-deps --force-recreate "$container" \
    || fail_at "$id" recreate "docker compose could not start ${container}"

  deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  while true; do
    health="$(docker inspect "$container" --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)"
    [ "$health" = "healthy" ] && break
    if [ "$SECONDS" -ge "$deadline" ]; then
      docker logs --tail 40 "$container" >&2 || true
      fail_at "$id" health "${container} is '${health}' after ${HEALTH_TIMEOUT_S}s"
    fi
    sleep 5
  done

  running="$(timeout "$STATUS_TIMEOUT" docker exec "$container" wget -qO- http://localhost:18790/health 2>/dev/null | jq -r '.version // empty' || true)"
  [ "$running" = "$MEMRAIN_VERSION" ] \
    || fail_at "$id" stamp "built ${MEMRAIN_VERSION} but ${container} serves '${running}'"

  echo "==> tenant ${id}: isolation smoke"
  bash "$SMOKE" "$id" || fail_at "$id" smoke "isolation smoke failed; ${container} keeps answering 503 isolation_unverified"
  note "${id} ok ${MEMRAIN_VERSION}"
}

for entry in ${PLAN[@]+"${PLAN[@]}"}; do
  deploy_one "${entry%%:*}" "${entry#*:}"
done

# cloudflared carries every tenant network; recreating it is how it joins a
# network added since its last start. Compose leaves it alone when nothing in
# its definition changed.
echo "==> refreshing the ingress"
hosting_compose up -d --no-build --no-deps cloudflared || { note "ingress refresh FAILED"; write_report; exit 1; }

write_report
echo "OK: ${#PLAN[@]} tenant(s) deployed on ${MEMRAIN_VERSION}"
