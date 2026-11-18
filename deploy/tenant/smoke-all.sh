#!/usr/bin/env bash
# Run the isolation smoke for every tenant with a running container. Run it
# by hand after a host reboot, a `docker restart` or a Docker update: until
# its smoke passes again, each restarted tenant answers 503
# isolation_unverified. One failure does not stop the others; the exit code
# is non-zero when any tenant failed.
#
#   bash deploy/tenant/smoke-all.sh
set -uo pipefail

# shellcheck source=deploy/tenant/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
SMOKE="${DEPLOY_DIR}/../scripts/tenant-isolation-smoke.sh"

passed=() failed=() idle=()
for f in "${TENANTS_DIR}"/*.yml; do
  [ -e "$f" ] || continue
  id="$(basename "$f" .yml)"
  valid_tenant_id "$id" || { failed+=("$id (not a tenant id)"); continue; }
  if [ "$(docker inspect "memrain-${id}" --format '{{.State.Running}}' 2>/dev/null)" != "true" ]; then
    idle+=("$id")
    continue
  fi
  if bash "$SMOKE" "$id"; then passed+=("$id"); else failed+=("$id"); fi
done

echo "== smoke-all =="
echo "passed:      ${passed[*]:-none}"
echo "not running: ${idle[*]:-none}"
echo "FAILED:      ${failed[*]:-none}"
[ "${#failed[@]}" -eq 0 ]
