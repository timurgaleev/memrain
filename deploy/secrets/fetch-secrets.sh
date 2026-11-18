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
# Hosting host (docs/HOSTING.md), one mode per run:
#   --tenant <id>    writes .secrets/tenants/<id>.env (MEMRAIN_POSTGRES_URL,
#                    MEMRAIN_CONTROL_URL, MEMRAIN_INTERNAL_TOKEN) from
#                    <SECRETS_PREFIX>/tenants/<id>/{postgres-url,control-url,
#                    internal-token}. All three are required.
#   --control        writes .secrets/hosting-control.env
#                    (MEMRAIN_CONTROL_ADMIN_URL) from
#                    <SECRETS_PREFIX>/hosting/control-admin-url, for the
#                    one-shot tenant-ctl container only.
#   TENANT_SECRETS_BACKEND=file with TENANT_SECRETS_DIR=<dir> reads
#                    <dir>/<id>/<name> (and <dir>/_hosting/control-admin-url)
#                    instead: no AWS, for a local stack. Source files must be
#                    regular files readable by their owner only.
#   Neither mode touches memrain.env or cloudflared.env.
#
# Two phases, so a failed run never damages what is already on disk: every
# secret is fetched into a temp file first, and only when all of them
# succeeded are the temp files renamed into place. Any error other than a
# genuinely missing secret (AccessDenied, expired credentials, throttling,
# network) exits 1 with every existing file byte-identical.
set -euo pipefail

# Defensive: never leak secret values via shell trace if someone exports DEBUG.
set +x

HOSTING_MODE="" TENANT_ID=""
case "$#:${1:-}" in
  0:) ;;
  2:--tenant) HOSTING_MODE=tenant; TENANT_ID="$2" ;;
  1:--control) HOSTING_MODE=control ;;
  *) echo "usage: $0 [--tenant <id> | --control]" >&2; exit 2 ;;
esac
if [ "$HOSTING_MODE" = tenant ] && ! [[ "$TENANT_ID" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; then
  echo "[secrets] ERROR: '${TENANT_ID}' is not a tenant id" >&2
  exit 2
fi

# Try to source the repo-level .env so this script works both from
# bootstrap.sh (which exports the prefix) and from a manual rerun.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -f "${REPO_ROOT}/.env" ]; then
  # shellcheck source=/dev/null
  . "${REPO_ROOT}/.env"
fi

# ---- Hosting modes: one tenant's file, or the control admin URL -------------
if [ -n "$HOSTING_MODE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  SECRETS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)/.secrets"
  # shellcheck source=/dev/null
  . "${SCRIPT_DIR}/lib.sh"
  BACKEND="${TENANT_SECRETS_BACKEND:-aws}"
  case "$BACKEND" in
    aws) : "${AWS_REGION:?AWS_REGION must be set (export it or define it in ${REPO_ROOT}/.env)}" ;;
    file) [ -n "${TENANT_SECRETS_DIR:-}" ] && [ -d "${TENANT_SECRETS_DIR}" ] \
            || { echo "[secrets] ERROR: TENANT_SECRETS_BACKEND=file needs TENANT_SECRETS_DIR (a directory)" >&2; exit 1; } ;;
    *) echo "[secrets] ERROR: TENANT_SECRETS_BACKEND must be aws or file, got '${BACKEND}'" >&2; exit 1 ;;
  esac

  umask 077
  mkdir -p "$SECRETS_DIR"
  chmod 0711 "$SECRETS_DIR"
  if [ "$HOSTING_MODE" = tenant ]; then
    OUT_DIR="${SECRETS_DIR}/tenants"
    OUT="${OUT_DIR}/${TENANT_ID}.env"
    SCOPE="tenants/${TENANT_ID}" FILE_SCOPE="${TENANT_ID}"
    mkdir -p "$OUT_DIR"
    # Compose reads env files as root; no container user needs the directory.
    chmod 0700 "$OUT_DIR"
  else
    OUT_DIR="$SECRETS_DIR"
    OUT="${SECRETS_DIR}/hosting-control.env"
    SCOPE="hosting" FILE_SCOPE="_hosting"
  fi
  OUT_TMP="${OUT_DIR}/.$(basename "$OUT").tmp.$$"
  trap 'rm -f "$OUT_TMP"' EXIT

  # hosting_value NAME -> the value on stdout; exits on any failure. A
  # missing secret is fatal here: a tenant without its URL or token does not
  # start (MEMRAIN_REQUIRE_POSTGRES, hosting-mode token check).
  hosting_value() {
    local name="$1" id src mode rc=0 value
    if [ "$BACKEND" = aws ]; then
      id="${SECRETS_PREFIX:-memex}/${SCOPE}/${name}"
      value="$(secret_value "$id")" || rc=$?
      case "$rc" in
        0) ;;
        2) echo "[secrets] ERROR: ${id} is missing or has no value; nothing written" >&2; exit 1 ;;
        *) echo "[secrets] ERROR: reading ${id} failed; nothing written" >&2; exit 1 ;;
      esac
    else
      src="${TENANT_SECRETS_DIR}/${FILE_SCOPE}/${name}"
      if [ -L "$src" ] || [ ! -f "$src" ]; then
        echo "[secrets] ERROR: ${src} is not a regular file; nothing written" >&2; exit 1
      fi
      mode="$(stat -c '%a' "$src" 2>/dev/null || stat -f '%Lp' "$src")"
      if [ $((8#$mode & 8#077)) -ne 0 ]; then
        echo "[secrets] ERROR: ${src} is readable beyond its owner (mode ${mode}); nothing written" >&2; exit 1
      fi
      value="$(cat "$src")"
      value="${value//$'\n'/}"
      value="${value//$'\r'/}"
    fi
    # Compose interpolates env-file values and cuts them at ' #'; a value it
    # would rewrite is refused rather than passed on altered.
    if [ -z "$value" ] || [[ "$value" =~ [[:space:]\'\"\`\\\$#] ]]; then
      echo "[secrets] ERROR: ${SCOPE}/${name} is empty or holds a character an env file cannot carry; nothing written" >&2
      exit 1
    fi
    printf '%s' "$value"
  }

  require_pg_url() {
    case "$2" in
      postgres://*|postgresql://*) ;;
      *) echo "[secrets] ERROR: ${SCOPE}/$1 is not a postgres:// URL; nothing written" >&2; exit 1 ;;
    esac
  }

  # require_owned_url NAME URL ROLE_SUFFIX DATABASE... -> the URL's role is
  # tenant_<id>_<suffix> and its database one of DATABASE. Provisioning names
  # them after the id (hyphens may become underscores), so a valid URL of
  # another tenant, or of the master role, is refused instead of started.
  require_owned_url() {
    local name="$1" url="$2" suffix="$3" rest user db ok=0 want
    shift 3
    require_pg_url "$name" "$url"
    rest="${url#*://}"
    user="${rest%%@*}"; user="${user%%:*}"
    db="${rest#*@}"
    case "$rest" in *@*/*) db="${db#*/}"; db="${db%%\?*}" ;; *) db="" ;; esac
    for want in "tenant_${TENANT_ID}_${suffix}" "tenant_${TENANT_ID//-/_}_${suffix}"; do
      [ "$user" = "$want" ] && ok=1
    done
    if [ "$ok" = 1 ]; then
      ok=0
      for want in "$@"; do [ "$db" = "$want" ] && ok=1; done
    fi
    if [ "$ok" != 1 ]; then
      echo "[secrets] ERROR: ${SCOPE}/${name} names role '${user}' on database '${db}', not tenant ${TENANT_ID}'s; nothing written" >&2
      exit 1
    fi
  }

  if [ "$HOSTING_MODE" = tenant ]; then
    PG_URL="$(hosting_value postgres-url)"
    require_owned_url postgres-url "$PG_URL" owner "tenant_${TENANT_ID}" "tenant_${TENANT_ID//-/_}"
    CTL_URL="$(hosting_value control-url)"
    require_owned_url control-url "$CTL_URL" ctl memrain_control
    TOKEN="$(hosting_value internal-token)"
    if [ "${#TOKEN}" -lt 32 ]; then
      echo "[secrets] ERROR: ${SCOPE}/internal-token is shorter than 32 characters; nothing written" >&2
      exit 1
    fi
    # Each tenant's token is its own: a neighbour holding the same one could
    # call this tenant's internal routes. Compared in the shell, so the value
    # never reaches a process argument list.
    # shellcheck disable=SC2094  # only basename of the file is printed
    for other in "${OUT_DIR}"/*.env; do
      [ -f "$other" ] && [ "$other" != "$OUT" ] || continue
      while IFS= read -r line || [ -n "$line" ]; do
        if [ "$line" = "MEMRAIN_INTERNAL_TOKEN=${TOKEN}" ]; then
          echo "[secrets] ERROR: tenant ${TENANT_ID}'s internal token is already held by $(basename "$other" .env); nothing written" >&2
          exit 1
        fi
      done < "$other"
    done
    { printf 'MEMRAIN_POSTGRES_URL=%s\n' "$PG_URL"
      printf 'MEMRAIN_CONTROL_URL=%s\n' "$CTL_URL"
      printf 'MEMRAIN_INTERNAL_TOKEN=%s\n' "$TOKEN"; } > "$OUT_TMP"
    WHAT="tenant ${TENANT_ID}: database URL, control URL and internal token"
  else
    ADMIN_URL="$(hosting_value control-admin-url)"; require_pg_url control-admin-url "$ADMIN_URL"
    printf 'MEMRAIN_CONTROL_ADMIN_URL=%s\n' "$ADMIN_URL" > "$OUT_TMP"
    WHAT="control admin URL"
  fi
  chmod 0400 "$OUT_TMP"
  mv -f "$OUT_TMP" "$OUT"
  echo "[secrets] ${WHAT} written to ${OUT} (backend ${BACKEND})"
  exit 0
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
