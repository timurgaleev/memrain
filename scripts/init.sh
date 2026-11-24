#!/usr/bin/env bash
# scripts/init.sh — interactive bootstrap for memrain.
#
# Prompts for the values needed to deploy and writes:
#   - .env                          (runtime config for compose + scripts)
#   - terraform/terraform.tfvars    (terraform input vars; gitignored)
#   - terraform/backend.hcl         (S3 backend partial config; gitignored)
#
# All writes are atomic (tmpfile + mv). By default the script refuses to
# overwrite existing files; pass --force to overwrite. Even with --force it
# refuses to change the state key of an existing backend.hcl, which would
# point terraform at a different (empty) state.
#
# Usage:
#   scripts/init.sh                 # interactive
#   scripts/init.sh --force         # overwrite existing .env / tfvars / backend.hcl
#   scripts/init.sh --force --allow-backend-key-change   # also change the state key
#   INIT_NON_INTERACTIVE=1 scripts/init.sh < answers.txt   # for tests/CI
#
# Exit codes: 0 = success, 1 = aborted, 2 = misconfiguration (missing dirs).
set -euo pipefail

REPO_ROOT="${INIT_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO_ROOT"

FORCE=0
ALLOW_BACKEND_KEY_CHANGE=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    --allow-backend-key-change) ALLOW_BACKEND_KEY_CHANGE=1 ;;
    --help|-h)
      sed -n '2,18p' "$0" | sed 's/^# //; s/^#//'
      exit 0
      ;;
    *) echo "[init] unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ENV_FILE="${INIT_ENV_FILE:-.env}"
TFVARS_FILE="${INIT_TFVARS_FILE:-terraform/terraform.tfvars}"
BACKEND_FILE="${INIT_BACKEND_FILE:-terraform/backend.hcl}"

[ -d "terraform" ] || { echo "[init] ERROR: terraform/ directory not found at $REPO_ROOT" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Collision detection
# ---------------------------------------------------------------------------
collisions=()
for f in "$ENV_FILE" "$TFVARS_FILE" "$BACKEND_FILE"; do
  [ -e "$f" ] && collisions+=("$f")
done

if [ "${#collisions[@]}" -gt 0 ] && [ "$FORCE" -ne 1 ]; then
  echo "[init] The following files already exist:"
  printf '  - %s\n' "${collisions[@]}"
  echo "[init] Re-run with --force to overwrite, or remove them first."
  exit 1
fi

# ---------------------------------------------------------------------------
# Prompt helpers
# ---------------------------------------------------------------------------
NON_INTERACTIVE="${INIT_NON_INTERACTIVE:-0}"

prompt() {
  # prompt VAR_NAME "Question" "default" "validator_fn_or_empty"
  local var="$1" question="$2" default="$3" validator="${4:-}"
  local value="" reply
  while true; do
    if [ "$NON_INTERACTIVE" = "1" ]; then
      IFS= read -r reply || reply=""
    else
      if [ -n "$default" ]; then
        printf '%s [%s]: ' "$question" "$default" >&2
      else
        printf '%s: ' "$question" >&2
      fi
      IFS= read -r reply || reply=""
    fi
    [ -z "$reply" ] && reply="$default"
    if [ -n "$validator" ]; then
      if ! "$validator" "$reply" >&2; then
        [ "$NON_INTERACTIVE" = "1" ] && exit 1
        continue
      fi
    fi
    value="$reply"
    break
  done
  printf -v "$var" '%s' "$value"
}

valid_aws_account_id() {
  local v="$1"
  if [[ "$v" =~ ^[0-9]{12}$ ]]; then return 0; fi
  echo "  invalid: AWS account ID must be exactly 12 digits"
  return 1
}

valid_domain() {
  local v="$1"
  if [[ "$v" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$ ]]; then return 0; fi
  echo "  invalid: domain must be like example.com (FQDN with at least one dot)"
  return 1
}

valid_subdomain() {
  local v="$1"
  if [[ "$v" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$ ]]; then return 0; fi
  echo "  invalid: subdomain must be a single label (no dots)"
  return 1
}

valid_project_name() {
  local v="$1"
  if [[ "$v" =~ ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$ ]]; then return 0; fi
  echo "  invalid: project name must be 1-32 lowercase letters, digits or hyphens"
  return 1
}

valid_github_owner() {
  local v="$1"
  if [[ "$v" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,38})$ ]]; then return 0; fi
  echo "  invalid: GitHub username must be 1-39 alphanumeric/hyphen chars"
  return 1
}

valid_email_or_empty() {
  local v="$1"
  [ -z "$v" ] && return 0
  if [[ "$v" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then return 0; fi
  echo "  invalid: must be a valid email or empty"
  return 1
}

valid_cidr_or_empty() {
  local v="$1"
  [ -z "$v" ] && return 0
  if [[ "$v" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]]; then return 0; fi
  echo "  invalid: must be CIDR (e.g. 1.2.3.4/32) or empty"
  return 1
}


valid_bool() {
  local v="$1"
  case "$v" in
    true|false) return 0 ;;
    *) echo "  invalid: must be 'true' or 'false'"; return 1 ;;
  esac
}

valid_nonempty() {
  local v="$1"
  [ -n "$v" ] && return 0
  echo "  invalid: cannot be empty"
  return 1
}

# ---------------------------------------------------------------------------
# Collect answers
# ---------------------------------------------------------------------------
echo "[init] memrain bootstrap"
echo "[init] Press Enter to accept the default in [brackets]."
echo

prompt AWS_ACCOUNT_ID    "AWS account ID (12 digits)"             ""             valid_aws_account_id
prompt AWS_REGION        "AWS region"                             "eu-west-1"    valid_nonempty
prompt AWS_PROFILE       "AWS CLI profile"                        "default"      valid_nonempty
# The project name drives AWS resource names and host paths; it is separate
# from the repo name, so a fork may use any repo name.
prompt PROJECT_NAME      "Project name (AWS names, /opt/<name>)"  "memrain"      valid_project_name
prompt DOMAIN            "Public root domain (e.g. example.com)"  ""             valid_domain
prompt SUBDOMAIN         "Subdomain for the public MCP"           "brain"        valid_subdomain
prompt GITHUB_OWNER      "GitHub username/org that owns the repo" ""             valid_github_owner
prompt REPO_NAME         "Public repo name"                       "memrain"      valid_nonempty
prompt SECRETS_PREFIX    "AWS Secrets Manager prefix"             "memrain"      valid_nonempty
prompt TFSTATE_BUCKET    "S3 bucket for terraform state"          ""             valid_nonempty
prompt TFSTATE_REGION    "S3 region of the tfstate bucket"        "eu-central-1" valid_nonempty
prompt TFSTATE_KEY       "S3 key of the terraform state"          "${PROJECT_NAME}/terraform.tfstate" valid_nonempty
prompt ALARM_EMAIL       "CloudWatch alarm email (optional)"      ""             valid_email_or_empty
prompt SSH_ALLOWED_CIDR  "SSH allowed CIDR (optional, e.g. 1.2.3.4/32)" ""       valid_cidr_or_empty
prompt USE_SSH_DEPLOY_KEY  "Use SSH deploy key (true/false; false for public repo)" "false" valid_bool

REPO_URL="https://github.com/${GITHUB_OWNER}/${REPO_NAME}.git"

# ---------------------------------------------------------------------------
# State-key guard. A different key in an existing backend.hcl points
# terraform at another state: the next plan would create a second stack
# beside the live one. Checked before anything is written.
# ---------------------------------------------------------------------------
if [ -e "$BACKEND_FILE" ] && [ "$ALLOW_BACKEND_KEY_CHANGE" -ne 1 ]; then
  EXISTING_KEY="$(sed -n 's/^[[:space:]]*key[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$BACKEND_FILE" | head -n 1)"
  if [ "$EXISTING_KEY" != "$TFSTATE_KEY" ]; then
    echo "[init] ERROR: ${BACKEND_FILE} uses state key '${EXISTING_KEY}', not '${TFSTATE_KEY}'." >&2
    echo "[init] Answer the state key prompt with the existing key, or pass --allow-backend-key-change" >&2
    echo "[init] if you really mean to switch state. Nothing was written." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Atomic write helpers
# ---------------------------------------------------------------------------
write_atomic() {
  local target="$1" content="$2" mode="${3:-0644}"
  local dir
  dir="$(dirname "$target")"
  mkdir -p "$dir"
  local tmp
  tmp="$(mktemp "${target}.XXXXXX")"
  printf '%s' "$content" > "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$target"
}

# ---------------------------------------------------------------------------
# Render .env
# ---------------------------------------------------------------------------
ENV_CONTENT="# Generated by scripts/init.sh — do not commit.
# Re-run scripts/init.sh --force to regenerate.
#
# Runtime config for docker-compose + bash scripts.
AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID}
AWS_REGION=${AWS_REGION}
AWS_PROFILE=${AWS_PROFILE}

PROJECT=${PROJECT_NAME}
DOMAIN=${DOMAIN}
SUBDOMAIN=${SUBDOMAIN}
PUBLIC_HOST=${SUBDOMAIN}.${DOMAIN}
# External origin, scheme included — the OAuth issuer and the admin magic link
# are built from it. Unset it to fall back to the request host.
MEMRAIN_PUBLIC_URL=https://${SUBDOMAIN}.${DOMAIN}

GITHUB_OWNER=${GITHUB_OWNER}
REPO_NAME=${REPO_NAME}
REPO_URL=${REPO_URL}

SECRETS_PREFIX=${SECRETS_PREFIX}
TFSTATE_BUCKET=${TFSTATE_BUCKET}

ALARM_EMAIL=${ALARM_EMAIL}
SSH_ALLOWED_CIDR=${SSH_ALLOWED_CIDR}

USE_SSH_DEPLOY_KEY=${USE_SSH_DEPLOY_KEY}

# Off by default. Set to 1 to allow the public MCP to accept constructive
# writes (index, page_put, page_append, add_tag, link). Pair with daily
# bearer rotation.
MEMRAIN_PUBLIC_WRITE=0

# Default EFS paths on the host (used by docker-compose volume binds); the same
# layout scripts/bootstrap.sh mounts and clones.
EFS_MOUNT=/mnt/${PROJECT_NAME}-efs/${PROJECT_NAME}
EFS_REPO=/mnt/${PROJECT_NAME}-efs/${PROJECT_NAME}-repo

# The only paid calls are Bedrock Titan embeddings. Set a brain-wide cap per
# UTC day here (see docs/CONFIGURATION.md):
# MEMRAIN_DAILY_BUDGET_USD=1.00
"

# .env carries AWS account id, alarm email, optional CIDR — keep it
# private even on shared workstations.
write_atomic "$ENV_FILE" "$ENV_CONTENT" 0600

# ---------------------------------------------------------------------------
# Render terraform/terraform.tfvars
# ---------------------------------------------------------------------------
TFVARS_CONTENT="# Generated by scripts/init.sh — do not commit.
aws_region          = \"${AWS_REGION}\"
aws_profile         = \"${AWS_PROFILE}\"
project_name        = \"${PROJECT_NAME}\"

domain              = \"${DOMAIN}\"
subdomain           = \"${SUBDOMAIN}\"

github_owner        = \"${GITHUB_OWNER}\"
repo_name           = \"${REPO_NAME}\"
repo_url            = \"${REPO_URL}\"

secrets_prefix      = \"${SECRETS_PREFIX}\"

alarm_email         = \"${ALARM_EMAIL}\"
ssh_allowed_cidr    = \"${SSH_ALLOWED_CIDR}\"

use_ssh_deploy_key  = ${USE_SSH_DEPLOY_KEY}
"

# tfvars carries account-scoped names — keep readable to terraform only.
write_atomic "$TFVARS_FILE" "$TFVARS_CONTENT" 0600

# ---------------------------------------------------------------------------
# Render terraform/backend.hcl (S3 partial backend config)
# ---------------------------------------------------------------------------
BACKEND_CONTENT="# Generated by scripts/init.sh — do not commit.
# Loaded via: terraform init -backend-config=backend.hcl
bucket  = \"${TFSTATE_BUCKET}\"
key     = \"${TFSTATE_KEY}\"
region  = \"${TFSTATE_REGION}\"
encrypt = true
profile = \"${AWS_PROFILE}\"
"

# backend.hcl carries tfstate bucket + AWS profile — not a secret but
# consistent with .env/tfvars at 0600.
write_atomic "$BACKEND_FILE" "$BACKEND_CONTENT" 0600

echo
echo "[init] wrote:"
printf '  - %s\n' "$ENV_FILE" "$TFVARS_FILE" "$BACKEND_FILE"
echo
echo "[init] next steps:"
echo "  1. review the generated files"
echo "  2. make audit          # verify no PII left in tracked files"
echo "  3. make plan           # terraform init + plan"
echo
