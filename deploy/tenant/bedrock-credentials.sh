#!/usr/bin/env bash
# Rewrite each tenant's Bedrock credentials before they expire. Runs on a
# hosting host as root from memrain-tenant-bedrock-credentials.timer (every
# five minutes), from the repo root:
#
#   bash deploy/tenant/bedrock-credentials.sh
#
# A tenant container has no AWS credentials of its own (the instance metadata
# hop limit keeps the instance role out of every container). For each tenant
# with a rendered file (deploy/tenants/<id>.yml) the host assumes
# MEMRAIN_TENANT_BEDROCK_ROLE_ARN in a session of its own
# (memrain-tenant-<id>), narrowed by a session policy to invoking Bedrock
# models, and writes the result to deploy/.bedrock/<id>/credentials.json: 0440,
# renamed into place so a reader never sees half a file. The container mounts
# only its own directory, read-only, and reads the file whenever its SDK
# needs credentials (MEMRAIN_BEDROCK_CREDENTIALS_FILE).
#
# A file is rewritten when it is missing, unreadable, or expires within
# REFRESH_BEFORE_S. A failed assume-role keeps the old file (the container
# then fails its paid calls with a clear "expired" error once it lapses),
# names the tenant, and the script exits non-zero after trying every tenant.
# Without MEMRAIN_TENANT_BEDROCK_ROLE_ARN (shell env or the host .env) it
# changes nothing: Bedrock for tenants is not set up on this host. Prints no
# credential.
#
# Knobs (shell env):
#   REFRESH_BEFORE_S   rewrite when fewer seconds than this remain (default 1200)
#   SESSION_SECONDS    lifetime of a new session (default 3600)
#   TENANT_GID         group the container user reads the file as (default 1000)
set -euo pipefail

# shellcheck source=deploy/tenant/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

REFRESH_BEFORE_S="${REFRESH_BEFORE_S:-1200}"
SESSION_SECONDS="${SESSION_SECONDS:-3600}"
TENANT_GID="${TENANT_GID:-1000}"
BEDROCK_DIR="${DEPLOY_DIR}/.bedrock"

command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required" >&2; exit 1; }

# env_value KEY -> KEY from the shell, else the last KEY= line of $ENV_FILE.
env_value() {
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f "$ENV_FILE" ]; then
    v="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  fi
  printf '%s' "$v"
}

ROLE="$(env_value MEMRAIN_TENANT_BEDROCK_ROLE_ARN)"
REGION="$(env_value AWS_REGION)"
if [ -z "$ROLE" ]; then
  echo "note: MEMRAIN_TENANT_BEDROCK_ROLE_ARN is not set; tenant Bedrock credentials are not managed on this host"
  exit 0
fi

POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],"Resource":["arn:aws:bedrock:*::foundation-model/*","arn:aws:bedrock:*:*:inference-profile/*"]}]}'

# seconds_left FILE -> seconds until the file's Expiration, or -1 when unreadable.
seconds_left() {
  local exp
  exp="$(jq -r '.Expiration // empty | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601' "$1" 2>/dev/null)" || exp=""
  if [ -z "$exp" ]; then echo -1; return; fi
  echo $(( exp - $(date +%s) ))
}

run_aws() {
  if command -v timeout >/dev/null 2>&1; then timeout 60 aws "$@"; else aws "$@"; fi
}

refresh() {
  local id="$1" dir="${BEDROCK_DIR}/$1" file out tmp
  file="${dir}/credentials.json"
  if [ -f "$file" ] && [ "$(seconds_left "$file")" -gt "$REFRESH_BEFORE_S" ]; then return 0; fi
  if ! out="$(run_aws sts assume-role --role-arn "$ROLE" --role-session-name "memrain-tenant-${id}" \
                --duration-seconds "$SESSION_SECONDS" --policy "$POLICY" ${REGION:+--region "$REGION"} --output json)"; then
    echo "FAIL ${id}: assume-role failed; the old credentials stay" >&2
    return 1
  fi
  mkdir -p "$dir"
  chmod 0750 "$dir"
  tmp="$(mktemp "${dir}/.credentials.XXXXXX")"
  if ! jq -e '.Credentials | {Version: 1, AccessKeyId, SecretAccessKey, SessionToken, Expiration}
              | select(.AccessKeyId and .SecretAccessKey and .SessionToken and .Expiration)' <<< "$out" > "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    echo "FAIL ${id}: assume-role answered without credentials; the old ones stay" >&2
    return 1
  fi
  chmod 0440 "$tmp"
  if [ "$(id -u)" = 0 ]; then chown "root:${TENANT_GID}" "$dir" "$tmp"; fi
  mv -f "$tmp" "$file"
  echo "ok ${id}: credentials rewritten"
}

FAILED=()
for f in "${TENANTS_DIR}"/*.yml; do
  [ -e "$f" ] || continue
  id="$(basename "$f" .yml)"
  valid_tenant_id "$id" || { echo "FAIL: '${id}' is not a tenant id" >&2; FAILED+=("$id"); continue; }
  refresh "$id" || FAILED+=("$id")
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "FAIL: Bedrock credentials not refreshed for: ${FAILED[*]}" >&2
  exit 1
fi
