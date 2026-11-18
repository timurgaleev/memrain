# shellcheck shell=bash
# Shared by the hosting scripts (deploy-tenants.sh, smoke-all.sh,
# scripts/tenant-isolation-smoke.sh). Sourced, never executed.
#
# A hosting host runs one container per tenant from deploy/tenants/<id>.yml,
# on top of deploy/tenant/compose.hosting.yml (the image, the one-shot
# `tenant-ctl` CLI container and cloudflared). Every compose call names that
# whole file set, so no tenant's container or network ever looks like an
# orphan and cloudflared always carries every tenant network.

HOSTING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${HOSTING_DIR}/.." && pwd)"
TENANTS_DIR="${DEPLOY_DIR}/tenants"
ENV_FILE="${ENV_FILE:-.env}"

# Same pattern as the control plane's TENANT_ID_RE: the id is part of
# container, network, database and role names.
TENANT_ID_RE='^[a-z][a-z0-9-]{1,30}$'

valid_tenant_id() { [[ "$1" =~ $TENANT_ID_RE ]]; }

# hosting_files -> fills HOSTING_COMPOSE_ARGS with -f for the base file and
# every tenant file, in name order.
hosting_files() {
  local f
  HOSTING_COMPOSE_ARGS=(-f "${HOSTING_DIR}/compose.hosting.yml")
  for f in "${TENANTS_DIR}"/*.yml; do
    [ -e "$f" ] && HOSTING_COMPOSE_ARGS+=(-f "$f")
  done
}

hosting_compose() { docker compose --env-file "$ENV_FILE" "${HOSTING_COMPOSE_ARGS[@]}" "$@"; }

# hosting_ctl ARGS... -> `memrain ARGS...` in a one-shot container that holds
# the control-plane admin URL. Nothing else gets that URL.
hosting_ctl() { hosting_compose run --rm --no-deps -T tenant-ctl "$@"; }
