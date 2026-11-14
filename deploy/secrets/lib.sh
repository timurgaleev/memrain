# shellcheck shell=bash
# Secret-id resolution shared by fetch-secrets.sh, the bearer rotation script
# and scripts/mcp-refresh.sh. Sourced, never executed. Bash 3.2 compatible
# (mcp-refresh runs on a macOS operator machine).
#
# Every function prints ids only, never a secret value, except secret_value,
# whose stdout is the value and must be captured by the caller.
#
# Return codes: 0 found, 2 missing (ResourceNotFoundException), 1 anything
# else (AccessDenied, expired credentials, throttling, network, bad input).
# Only a genuine "not found" may be treated as missing; every other failure
# must stop the caller, or a transient IAM error would look like an absent
# secret and blank a file that still holds a good value.
#
# Env contract:
#   AWS_REGION       region the secrets live in (required)
#   SECRETS_PREFIX   namespace; unset or empty means `memex`, the prefix every
#                    stack without the key was created with
#   POSTGRES_URL_SECRET_NAME, PUBLIC_BEARER_SECRET_NAME,
#   INTERNAL_TOKEN_SECRET_NAME, TUNNEL_TOKEN_SECRET_NAME,
#   CONNECTOR_KEK_SECRET_NAME, NOTIFY_WEBHOOK_SECRET_NAME
#                    optional full secret ids. A non-empty value is used
#                    exactly: no prefix, no new-then-old fallback.

SECRET_NAME_OVERRIDE_KEYS="POSTGRES_URL_SECRET_NAME PUBLIC_BEARER_SECRET_NAME INTERNAL_TOKEN_SECRET_NAME TUNNEL_TOKEN_SECRET_NAME CONNECTOR_KEK_SECRET_NAME NOTIFY_WEBHOOK_SECRET_NAME"

secrets_log() { printf '[secrets] %s\n' "$*" >&2; }

# The value reaches the AWS CLI as one argv entry, never through a shell, but
# reject anything outside the Secrets Manager name alphabet anyway. The
# length is checked apart from the pattern: BSD regex (macOS) caps a bound
# at 255, so `{1,512}` would reject every value there.
valid_secret_id() {
  local re='^[A-Za-z0-9/_+=.@-]+$'
  [ "${#1}" -ge 1 ] && [ "${#1}" -le 512 ] && [[ "$1" =~ $re ]]
}

# Check every override up front, so a bad one fails before any AWS call.
validate_secret_name_overrides() {
  local key value
  for key in $SECRET_NAME_OVERRIDE_KEYS; do
    value="${!key:-}"
    if [ -n "$value" ] && ! valid_secret_id "$value"; then
      secrets_log "ERROR: ${key} is not a valid secret id (allowed: A-Z a-z 0-9 / _ + = . @ -, at most 512)"
      return 1
    fi
  done
  return 0
}

# _secret_exists ID -> 0 exists, 2 not found, 1 other error.
_secret_exists() {
  local id="$1" err rc=0
  err="$(aws secretsmanager describe-secret \
    --secret-id "$id" \
    --region "$AWS_REGION" 2>&1 >/dev/null)" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  case "$err" in
    *ResourceNotFoundException*) return 2 ;;
  esac
  secrets_log "ERROR: describe-secret ${id} failed: $(printf '%s' "$err" | head -n 1)"
  return 1
}

# resolve_secret_id NEW OLD -> prints the id to read among <prefix>/NEW,
# <prefix>/OLD. A name counts only when its value is non-empty: a new-name
# secret that exists but is empty (or has no version yet) falls back to the
# legacy one, so a half-done rename never blanks a working value. Both
# non-empty and different is fatal: either pick could lock a client out, so
# the operator decides. With no non-empty value the first existing id is
# printed and the caller decides what empty means. Only one prefix is ever
# searched: probing a second one could pick up a different stack's secret.
resolve_secret_id() {
  local new="$1" old="$2" prefix="${SECRETS_PREFIX:-memex}" name id rc tried=""
  local value first="" chosen="" chosen_value=""
  for name in "$new" "$old"; do
    id="${prefix}/${name}"
    case " $tried " in *" $id "*) continue ;; esac
    tried="${tried:+$tried }$id"
    rc=0
    _secret_exists "$id" || rc=$?
    case "$rc" in
      0) ;;
      2) continue ;;
      *) return 1 ;;
    esac
    [ -n "$first" ] || first="$id"
    rc=0
    value="$(secret_value "$id")" || rc=$?
    case "$rc" in
      0) ;;
      2) continue ;;
      *) return 1 ;;
    esac
    [ -n "$value" ] || continue
    if [ -z "$chosen" ]; then
      chosen="$id"
      chosen_value="$value"
    elif [ "$value" != "$chosen_value" ]; then
      secrets_log "ERROR: ${chosen} and ${id} both hold a value and the values differ; make them equal or empty one of them"
      return 1
    fi
  done
  if [ -n "$chosen" ]; then
    [ "$chosen" = "$first" ] || secrets_log "${first} has no value; using ${chosen}"
    printf '%s\n' "$chosen"
    return 0
  fi
  if [ -n "$first" ]; then
    printf '%s\n' "$first"
    return 0
  fi
  secrets_log "not found: ${tried}"
  return 2
}

# secret_id_for KIND -> prints the id for one of
# postgres-url | public-bearer | internal-token | tunnel-token |
# connector-kek | notify-webhook,
# and logs (stderr) which id was chosen and where it came from.
secret_id_for() {
  local kind="$1" key new old override id rc=0
  case "$kind" in
    postgres-url)   key=POSTGRES_URL_SECRET_NAME;   new=memrain-postgres-url;   old=memex-postgres-url ;;
    public-bearer)  key=PUBLIC_BEARER_SECRET_NAME;  new=memrain-public-bearer;  old=memex-public-bearer ;;
    internal-token) key=INTERNAL_TOKEN_SECRET_NAME; new=memrain-internal-token; old=memex-internal-token ;;
    tunnel-token)   key=TUNNEL_TOKEN_SECRET_NAME;   new=cloudflared-tunnel-token; old=cloudflared-tunnel-token ;;
    # Added after the rename, so there is no legacy name to fall back to.
    connector-kek)  key=CONNECTOR_KEK_SECRET_NAME;  new=memrain-connector-kek;  old=memrain-connector-kek ;;
    notify-webhook) key=NOTIFY_WEBHOOK_SECRET_NAME; new=memrain-notify-webhook; old=memrain-notify-webhook ;;
    *) secrets_log "ERROR: unknown secret kind: ${kind}"; return 1 ;;
  esac
  override="${!key:-}"
  if [ -n "$override" ]; then
    if ! valid_secret_id "$override"; then
      secrets_log "ERROR: ${key} is not a valid secret id"
      return 1
    fi
    _secret_exists "$override" || rc=$?
    case "$rc" in
      0) secrets_log "${kind}: ${override} (override ${key})"; printf '%s\n' "$override"; return 0 ;;
      2) secrets_log "${kind}: ${override} (override ${key}) not found"; return 2 ;;
      *) return 1 ;;
    esac
  fi
  id="$(resolve_secret_id "$new" "$old")" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  secrets_log "${kind}: ${id}"
  printf '%s\n' "$id"
}

# secret_value ID -> prints the AWSCURRENT SecretString with CR/LF removed
# (the AWS CLI's text output always appends a newline, and URL parsers choke
# on it). 2 = not found, including a secret that has no version yet.
secret_value() {
  local id="$1" errf value rc=0
  errf="$(mktemp)" || return 1
  value="$(aws secretsmanager get-secret-value \
    --secret-id "$id" \
    --region "$AWS_REGION" \
    --query SecretString --output text 2>"$errf")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if grep -q ResourceNotFoundException "$errf"; then
      rm -f "$errf"
      return 2
    fi
    secrets_log "ERROR: get-secret-value ${id} failed: $(head -n 1 "$errf")"
    rm -f "$errf"
    return 1
  fi
  rm -f "$errf"
  value="${value//$'\n'/}"
  value="${value//$'\r'/}"
  printf '%s' "$value"
}
