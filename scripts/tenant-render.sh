#!/usr/bin/env bash
# Render deploy/tenants/<id>.yml, a tenant's container definition, from
# deploy/tenant/tenant.yml.tmpl. Run on the hosting host from the repo root,
# after `memrain tenant create <id> --host <hostname>`.
#
#   bash scripts/tenant-render.sh <id> --host <hostname> [--force]
#
# The file holds no secret and is not tracked (deploy/tenants/ is ignored).
# An existing file is kept unless --force is given.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${REPO_ROOT}/deploy/tenant/tenant.yml.tmpl"
OUT_DIR="${REPO_ROOT}/deploy/tenants"

usage() { echo "usage: $0 <tenant-id> --host <hostname> [--force]" >&2; exit 2; }

[ $# -ge 3 ] || usage
ID="$1"; shift
HOST="" FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) [ $# -ge 2 ] || usage; HOST="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) usage ;;
  esac
done

# Both values land in YAML and in container, network and database names, so
# only the plain alphabets pass.
if ! [[ "$ID" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; then
  echo "FAIL: '${ID}' is not a tenant id (^[a-z][a-z0-9-]{1,30}\$)" >&2
  exit 1
fi
label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
if [ "${#HOST}" -gt 253 ] || ! [[ "$HOST" =~ ^${label}(\.${label})+$ ]]; then
  echo "FAIL: '${HOST}' is not a lowercase hostname" >&2
  exit 1
fi

OUT="${OUT_DIR}/${ID}.yml"
if [ -e "$OUT" ] && [ "$FORCE" != 1 ]; then
  echo "FAIL: ${OUT} exists (--force to re-render)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
TMP="${OUT}.tmp.$$"
trap 'rm -f "$TMP"' EXIT
sed -e "s/@TENANT_ID@/${ID}/g" -e "s#@PUBLIC_URL@#https://${HOST}#g" "$TEMPLATE" > "$TMP"
if grep -q '@[A-Z_]*@' "$TMP"; then
  echo "FAIL: the template has a placeholder this script does not fill" >&2
  exit 1
fi
chmod 0644 "$TMP"
mv -f "$TMP" "$OUT"
echo "rendered ${OUT} (public URL https://${HOST})"
echo "next: bash deploy/secrets/fetch-secrets.sh --tenant ${ID}, then bash deploy/deploy.sh"
