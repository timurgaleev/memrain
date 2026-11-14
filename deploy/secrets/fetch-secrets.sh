#!/bin/bash
# Read AWS Secrets Manager → write .env files under deploy/.secrets/
# Containers read them through compose `env_file` (see docker-compose.yml).
#
# Env contract:
#   AWS_REGION       AWS region to query Secrets Manager in. Required.
#   SECRETS_PREFIX   namespace under Secrets Manager; matches terraform
#                    var.secrets_prefix. Each secret is looked up as
#                    `<SECRETS_PREFIX>/memrain-<name>`, then
#                    `<SECRETS_PREFIX>/memex-<name>`. A name with an empty
#                    value is skipped; both non-empty and different exits 1.
#                    Unset or empty means `memex` (deploy/secrets/lib.sh).
#   POSTGRES_URL_SECRET_NAME, PUBLIC_BEARER_SECRET_NAME,
#   INTERNAL_TOKEN_SECRET_NAME, TUNNEL_TOKEN_SECRET_NAME,
#   CONNECTOR_KEK_SECRET_NAME, NOTIFY_WEBHOOK_SECRET_NAME
#                    optional full secret ids that replace the lookup above.
#   MEMRAIN_REQUIRE_POSTGRES (or MEMEX_REQUIRE_POSTGRES)
#                    1 = a missing Postgres URL is an error, not a PGLite start.
#   MEMRAIN_PUBLIC_WRITE (or MEMEX_PUBLIC_WRITE)
#                    set to 1 in .env to opt in to public MCP write tools.
#
# Two phases, so a failed run never damages what is already on disk: every
# secret is fetched into a temp file first, and only when all of them
# succeeded are the temp files renamed into place. Any error other than a
# genuinely missing secret (AccessDenied, expired credentials, throttling,
# network) exits 1 with every existing file byte-identical.
set -euo pipefail

# Defensive: never leak secret values via shell trace if someone exports DEBUG.
set +x

# Try to source the repo-level .env so this script works both from
# bootstrap.sh (which exports the prefix) and from a manual rerun.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -f "${REPO_ROOT}/.env" ]; then
  # shellcheck source=/dev/null
  . "${REPO_ROOT}/.env"
fi

: "${AWS_REGION:?AWS_REGION must be set (export it or define it in ${REPO_ROOT}/.env)}"

# Resolve to <repo>/deploy/.secrets/ regardless of where this script lives.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SECRETS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)/.secrets"
umask 077
mkdir -p "$SECRETS_DIR"
# 0711: root owns + lists, others may descend into the dir (so non-root
# container UIDs — e.g. the telegram-bridge running as uid 10001 — can
# read named files inside). Non-root host users cannot enumerate the
# dir, which is the actual confidentiality requirement. Individual
# files keep their own per-secret modes set below.
chmod 0711 "$SECRETS_DIR"

# shellcheck source=/dev/null
. "${SCRIPT_DIR}/lib.sh"

validate_secret_name_overrides || exit 1

REQUIRE_POSTGRES="${MEMRAIN_REQUIRE_POSTGRES:-${MEMEX_REQUIRE_POSTGRES:-}}"

# memrain.env is the single env_file the memrain container reads. A
# .secrets/memex.env left by a pre-rename release is never read, written or
# removed here.
APP_ENV="${SECRETS_DIR}/memrain.env"
TUNNEL_ENV="${SECRETS_DIR}/cloudflared.env"
APP_TMP="${SECRETS_DIR}/.memrain.env.tmp.$$"
TUNNEL_TMP="${SECRETS_DIR}/.cloudflared.env.tmp.$$"
VALUE_TMP="${SECRETS_DIR}/.value.tmp.$$"
cleanup() { rm -f "$APP_TMP" "$TUNNEL_TMP" "$VALUE_TMP"; }
trap cleanup EXIT

# fetch_kind KIND [MISSING_IF_NO_VERSION] -> the value lands in $VALUE_TMP.
# 0 fetched, 2 missing, 1 fatal. An existing secret with an empty value
# counts as missing. A secret without an AWSCURRENT version counts as
# missing only when the second argument is 1 (the tunnel token, which
# terraform creates as an empty placeholder); for the others it is fatal.
fetch_kind() {
  local kind="$1" missing_if_no_version="${2:-0}" id rc=0
  id="$(secret_id_for "$kind")" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  secret_value "$id" > "$VALUE_TMP" || rc=$?
  if [ "$rc" -eq 2 ]; then
    if [ "$missing_if_no_version" = "1" ]; then return 2; fi
    secrets_log "ERROR: ${id} exists but has no current value"
    return 1
  fi
  [ "$rc" -eq 0 ] || return "$rc"
  [ -s "$VALUE_TMP" ] || return 2
  return 0
}

# append_env KEY -> appends KEY=<value from $VALUE_TMP> to the app env temp.
append_env() {
  { printf '%s=' "$1"; cat "$VALUE_TMP"; printf '\n'; } >> "$APP_TMP"
}

# ---- Phase 1: fetch everything into temp files; nothing is renamed yet ----
: > "$APP_TMP"

rc=0; fetch_kind postgres-url || rc=$?
case "$rc" in
  0) append_env MEMRAIN_POSTGRES_URL
     echo "[secrets] memrain Postgres URL fetched" ;;
  2) if [ "$REQUIRE_POSTGRES" = "1" ]; then
       echo "[secrets] ERROR: MEMRAIN_REQUIRE_POSTGRES=1 but no Postgres URL secret is provisioned; nothing written" >&2
       exit 1
     fi
     echo "[secrets] WARN: memrain Postgres URL not provisioned — daemon will start on local PGLite (dev fallback)" ;;
  *) echo "[secrets] ERROR: Postgres URL lookup failed; nothing written" >&2; exit 1 ;;
esac

rc=0; fetch_kind public-bearer || rc=$?
case "$rc" in
  0) append_env MEMRAIN_PUBLIC_BEARER
     echo "[secrets] memrain public bearer fetched" ;;
  2) echo "[secrets] memrain public bearer not yet provisioned (public ingress disabled)" ;;
  *) echo "[secrets] ERROR: public bearer lookup failed; nothing written" >&2; exit 1 ;;
esac

# Internal-route shared token. Defends POST /index and POST /friction
# on the docker-internal bridge from a compromised sibling container.
# The memrain container reads this from MEMRAIN_INTERNAL_TOKEN
# at startup; absence falls through to legacy "open internal" behaviour
# with a startup warning (so existing single-node installs upgrade
# cleanly even before the operator creates the secret).
rc=0; fetch_kind internal-token || rc=$?
case "$rc" in
  0) append_env MEMRAIN_INTERNAL_TOKEN
     echo "[secrets] memrain internal token fetched" ;;
  2) echo "[secrets] memrain internal token not yet provisioned — internal routes stay open (legacy fallthrough)" ;;
  *) echo "[secrets] ERROR: internal token lookup failed; nothing written" >&2; exit 1 ;;
esac

# Connector key (KEK): seals every connector token and bring-your-own OAuth
# client secret. Optional — without it connectors stay closed and doctor says
# why. terraform creates it as an empty placeholder (no version) only when
# enable_connector_kek_secret is true; the operator puts the value in by hand
# (docs/connectors/KEY.md), so it never sits in terraform state.
rc=0; fetch_kind connector-kek 1 || rc=$?
case "$rc" in
  0) append_env MEMRAIN_CONNECTOR_KEK
     echo "[secrets] connector key fetched" ;;
  2) echo "[secrets] connector key not provisioned (connectors stay closed)" ;;
  *) echo "[secrets] ERROR: connector key lookup failed; nothing written" >&2; exit 1 ;;
esac

# HMAC secret that signs outgoing notification webhooks. Optional, same
# placeholder rule as the connector key.
rc=0; fetch_kind notify-webhook 1 || rc=$?
case "$rc" in
  0) append_env MEMRAIN_NOTIFY_WEBHOOK_SECRET
     echo "[secrets] notification webhook secret fetched" ;;
  2) echo "[secrets] notification webhook secret not provisioned (webhook delivery off)" ;;
  *) echo "[secrets] ERROR: notification webhook secret lookup failed; nothing written" >&2; exit 1 ;;
esac

PUBLIC_WRITE="${MEMRAIN_PUBLIC_WRITE:-${MEMEX_PUBLIC_WRITE:-0}}"
printf 'MEMRAIN_PUBLIC_WRITE=%s\n' "$PUBLIC_WRITE" >> "$APP_TMP"
if [ "$PUBLIC_WRITE" = "1" ]; then
  echo "[secrets] memrain public write ENABLED (opted in via MEMRAIN_PUBLIC_WRITE=1)"
else
  echo "[secrets] memrain public write DISABLED (default — read-only MCP)"
fi

# Cloudflared tunnel token → .env format for compose env_file. terraform
# creates this secret as an EMPTY placeholder (no version), so "missing" is
# a normal state on a fresh install and must not abort the bootstrap.
rc=0; fetch_kind tunnel-token 1 || rc=$?
case "$rc" in
  0) { printf 'TUNNEL_TOKEN='; cat "$VALUE_TMP"; printf '\n'
       printf 'CLOUDFLARE_TUNNEL_TOKEN='; cat "$VALUE_TMP"; printf '\n'; } > "$TUNNEL_TMP"
     TUNNEL_STATE=fetched ;;
  2) TUNNEL_STATE=missing ;;
  *) echo "[secrets] ERROR: tunnel token lookup failed; nothing written" >&2; exit 1 ;;
esac
rm -f "$VALUE_TMP"

# ---- Phase 2: publish. Same-directory renames, atomic per file ----
chmod 0400 "$APP_TMP"
mv -f "$APP_TMP" "$APP_ENV"

if [ "$TUNNEL_STATE" = "fetched" ]; then
  chmod 0400 "$TUNNEL_TMP"
  mv -f "$TUNNEL_TMP" "$TUNNEL_ENV"
  echo "[secrets] cloudflared tunnel token fetched"
else
  # The empty placeholder keeps compose's env_file happy on a fresh install;
  # an existing file (possibly holding a good token) is never replaced by it.
  if [ ! -e "$TUNNEL_ENV" ]; then
    : > "$TUNNEL_TMP"
    chmod 0400 "$TUNNEL_TMP"
    mv -f "$TUNNEL_TMP" "$TUNNEL_ENV"
  fi
  echo "[secrets] WARN: cloudflared tunnel token has no value yet — the tunnel container will loop until <prefix>/cloudflared-tunnel-token is filled (see docs/DEPLOYMENT.md step 5)"
fi

echo "[secrets] fetched secrets to ${SECRETS_DIR} (prefix: ${SECRETS_PREFIX:-memex})"
