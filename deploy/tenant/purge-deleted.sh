#!/usr/bin/env bash
# Purge every tenant whose deletion window has passed, on a hosting host, from
# the repo root:
#
#   bash deploy/tenant/purge-deleted.sh [--secrets file|aws]
#
# `tenant purge-deleted` (in tenant-ctl) drops the database and roles of each
# tenant with a good receipt under its current fence, removes its secrets
# through the secret writer and every export copy under /provisioned. This
# script then removes what only the host holds, for each purged id exactly:
# the container memrain-<id>, deploy/tenants/<id>.yml and <id>.*,
# deploy/.secrets/tenants/<id>.env, deploy/.bedrock/<id>/, and
# deploy/.secrets/provisioned/<id>/ and <id>.invite; then it refreshes
# cloudflared without the tenant's network and removes the network. Take each
# export off the host before its window ends: `tenant delete` printed its path
# and SHA-256.
set -euo pipefail

# shellcheck source=deploy/tenant/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required" >&2; exit 1; }

hosting_files
if ! OUT="$(hosting_ctl tenant purge-deleted "$@")" \
   || ! printf '%s' "$OUT" | jq -e '.ok == true and (.purged | type == "array")' >/dev/null 2>&1; then
  echo "FAIL: tenant purge-deleted did not answer as expected; nothing on the host was removed" >&2
  exit 1
fi
IDS="$(printf '%s' "$OUT" | jq -r '.purged[]')"

# Every id is checked before anything is removed.
PURGED=()
while IFS= read -r id; do
  [ -n "$id" ] || continue
  valid_tenant_id "$id" || { echo "FAIL: control names a purged tenant id that is not one: '${id}'; nothing on the host was removed" >&2; exit 1; }
  PURGED+=("$id")
done <<< "$IDS"

SECRETS_DIR="${DEPLOY_DIR}/.secrets"
for id in ${PURGED[@]+"${PURGED[@]}"}; do
  docker rm -f "memrain-${id}" >/dev/null 2>&1 || true
  rm -f "${TENANTS_DIR}/${id}.yml" "${TENANTS_DIR}/${id}".*
  rm -f "${SECRETS_DIR}/tenants/${id}.env" "${SECRETS_DIR}/provisioned/${id}.invite"
  rm -rf "${DEPLOY_DIR}/.bedrock/${id}" "${SECRETS_DIR}/provisioned/${id}"
  echo "ok ${id}: purged; container, files and secrets removed from the host"
done

if [ "${#PURGED[@]}" -gt 0 ]; then
  # cloudflared still sits on the purged networks; recreate it from the
  # remaining file set, then the networks can go.
  hosting_files
  hosting_compose up -d --no-build --no-deps cloudflared || echo "warning: cloudflared was not refreshed; remove the networks by hand after it is" >&2
  for id in "${PURGED[@]}"; do docker network rm "memrain_tenant_${id}" >/dev/null 2>&1 || true; done
fi
printf '%s\n' "$OUT" | jq '{purged, skipped, removedExports}'
