#!/bin/bash
# bootstrap.sh — runs ONCE per instance via cloud-init user_data (cloud-init
# executes user_data scripts once-per-instance, not per-boot; on a plain
# reboot the stack comes back via docker's restart policies instead).
# Idempotent: safe to re-run any time via SSM:
#   aws s3 cp s3://<scripts-bucket>/scripts/bootstrap.sh /tmp/b.sh && sudo bash /tmp/b.sh
# Fast — ~30s on a cold run, ~2s on a warm one.
#
# Reads its env contract from /etc/stack-env (written by terraform
# user_data). Failing-fast on a missing required value is intentional —
# silent fallbacks would mask wiring mistakes.
set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Load env contract written by cloud-init from terraform vars.
# ---------------------------------------------------------------------------
# shellcheck source=/dev/null
if [ -f /etc/stack-env ]; then
  . /etc/stack-env
fi

: "${STACK_REPO_URL:?STACK_REPO_URL must be set (write it to /etc/stack-env)}"
: "${STACK_EFS_ID:=}"          # optional — skip mount if absent
: "${STACK_PROJECT:=memrain}"
: "${STACK_USE_SSH_DEPLOY_KEY:=false}"
: "${STACK_SECRETS_PREFIX:=$STACK_PROJECT}"
: "${STACK_AWS_REGION:=eu-west-1}"
: "${STACK_DOMAIN:=}"
: "${STACK_SUBDOMAIN:=${STACK_MEMEX_SUBDOMAIN:-brain}}"
: "${STACK_INGRESS_MODE:=cloudflare}"

# ---------------------------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------------------------
dnf install -y docker git amazon-efs-utils jq aws-cli unzip
systemctl enable --now docker

# 1b. Install docker compose v2 plugin (AL2023's docker package doesn't ship it).
# Binary is downloaded over HTTPS but verified against a pinned sha256
# checksum — a tampered GitHub release asset or hijacked DNS would
# otherwise yield a compose binary running as root with full Docker
# socket access. Bump COMPOSE_VERSION + both SHAs together; the canonical
# table lives at https://github.com/docker/compose/releases.
COMPOSE_VERSION="v2.30.3"
COMPOSE_SHA256_aarch64="8fed7b79b8bd1cb0624142f7d723c3cc67ba747c77ed69abbdefdc77a6d416d1"
COMPOSE_SHA256_x86_64="fbb4853d3f2148b0f2f0916f8971c9e500784e4e4949324934fc0b7dc2ed5016"
COMPOSE_PLUGIN_DIR="/usr/libexec/docker/cli-plugins"
COMPOSE_PLUGIN="${COMPOSE_PLUGIN_DIR}/docker-compose"
ARCH_DC=$(uname -m)  # aarch64 or x86_64 — both used in compose release names
case "$ARCH_DC" in
  aarch64) COMPOSE_SHA256="$COMPOSE_SHA256_aarch64" ;;
  x86_64)  COMPOSE_SHA256="$COMPOSE_SHA256_x86_64" ;;
  *) echo "[bootstrap] unsupported arch $ARCH_DC"; exit 1 ;;
esac
if [ ! -x "$COMPOSE_PLUGIN" ] || [ "$($COMPOSE_PLUGIN version --short 2>/dev/null || echo)" != "${COMPOSE_VERSION#v}" ]; then
  echo "[bootstrap] installing docker compose ${COMPOSE_VERSION} (${ARCH_DC})"
  mkdir -p "$COMPOSE_PLUGIN_DIR"
  TMP_COMPOSE="$(mktemp)"
  curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH_DC}" \
    -o "$TMP_COMPOSE"
  if ! echo "${COMPOSE_SHA256}  ${TMP_COMPOSE}" | sha256sum -c -; then
    rm -f "$TMP_COMPOSE"
    echo "[bootstrap] FATAL: docker-compose sha256 mismatch — refusing to install"
    exit 1
  fi
  install -m 0755 "$TMP_COMPOSE" "$COMPOSE_PLUGIN"
  rm -f "$TMP_COMPOSE"
  echo "[bootstrap] docker compose: $($COMPOSE_PLUGIN version --short)"
else
  echo "[bootstrap] docker compose ${COMPOSE_VERSION} already installed"
fi

# ---------------------------------------------------------------------------
# 2. EFS mount (idempotent fstab + retry)
# ---------------------------------------------------------------------------
EFS_MOUNT="/mnt/${STACK_PROJECT}-efs"
EFS_DATA="${EFS_MOUNT}/${STACK_PROJECT}"
EFS_REPO="${EFS_MOUNT}/${STACK_PROJECT}-repo"
mkdir -p "$EFS_MOUNT"

if [ -n "$STACK_EFS_ID" ]; then
  FSTAB_LINE="${STACK_EFS_ID}:/ ${EFS_MOUNT} efs _netdev,tls,iam 0 0"
  grep -qxF "$FSTAB_LINE" /etc/fstab || echo "$FSTAB_LINE" >> /etc/fstab
  for _ in 1 2 3 4 5; do
    mountpoint -q "$EFS_MOUNT" && break
    if mount -t efs -a; then break; else sleep 10; fi
  done
  mountpoint -q "$EFS_MOUNT" || { echo "[bootstrap] EFS mount failed after 5 retries"; exit 1; }
else
  echo "[bootstrap] WARNING: STACK_EFS_ID not set — skipping EFS mount"
fi

# ---------------------------------------------------------------------------
# 3. Clone or update the repo. HTTPS by default (public); SSH only when
#    STACK_USE_SSH_DEPLOY_KEY=true (SSH deploy-key flow).
# ---------------------------------------------------------------------------
REPO_DIR="/opt/${STACK_PROJECT}"
SSH_DIR="/root/.ssh"

git_clone_with_retry() {
  # Retry git clone up to 3 times with 5s backoff — handles transient
  # DNS / TLS hiccups on a fresh boot before the network is fully up.
  local url="$1" dst="$2" tries=0
  while [ "$tries" -lt 3 ]; do
    if git clone "$url" "$dst"; then
      return 0
    fi
    tries=$((tries + 1))
    echo "[bootstrap] git clone failed (try $tries/3) — retrying in 5s"
    sleep 5
  done
  return 1
}

if [ "$STACK_USE_SSH_DEPLOY_KEY" = "true" ]; then
  echo "[bootstrap] SSH deploy-key mode (SSH deploy-key flow)"
  SSH_KEY_FILE="${SSH_DIR}/${STACK_PROJECT}_deploy_key"
  mkdir -p "$SSH_DIR"
  chmod 700 "$SSH_DIR"
  # Fetch (or refresh) the deploy key from Secrets Manager. The key
  # never crosses the chat / log surface — --query+--output text avoids
  # JSON wrapping.
  aws secretsmanager get-secret-value \
    --secret-id "${STACK_SECRETS_PREFIX}/github-deploy-key" \
    --query SecretString --output text \
    --region "$STACK_AWS_REGION" > "$SSH_KEY_FILE"
  chmod 600 "$SSH_KEY_FILE"
  export GIT_SSH_COMMAND="ssh -i $SSH_KEY_FILE -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
else
  echo "[bootstrap] HTTPS clone mode (public repo, no auth required)"
  unset GIT_SSH_COMMAND
fi

# Nothing moves until the legacy guards below pass. An existing checkout is
# only fetched here and fast-forwarded after them, so a refused run leaves the
# running stack's checkout as it was. A new checkout is cloned into a staging
# dir and moved into place after them, so a refused run leaves no second one.
STAGE_DIR=""
if [ -d "${REPO_DIR}/.git" ]; then
  git -C "${REPO_DIR}" fetch
  GUARD_LIB="$(mktemp)"
  git -C "${REPO_DIR}" show '@{upstream}:deploy/lib/legacy-guard.sh' > "$GUARD_LIB" \
    || { rm -f "$GUARD_LIB"; echo "[bootstrap] FATAL: cannot read deploy/lib/legacy-guard.sh from the fetched revision"; exit 1; }
else
  # git clone accepts only an empty directory; say so before cloning.
  if [ -e "$REPO_DIR" ] && [ -n "$(ls -A "$REPO_DIR" 2>&1)" ]; then
    echo "[bootstrap] FATAL: ${REPO_DIR} exists and is not an empty directory"
    exit 1
  fi
  STAGE_DIR="$(mktemp -d "$(dirname "$REPO_DIR")/.${STACK_PROJECT}-clone.XXXXXX")"
  git_clone_with_retry "$STACK_REPO_URL" "${STAGE_DIR}/repo" \
    || { rm -rf "$STAGE_DIR"; echo "[bootstrap] FATAL: git clone failed 3x — check STACK_REPO_URL"; exit 1; }
  GUARD_LIB="${STAGE_DIR}/repo/deploy/lib/legacy-guard.sh"
fi

# ---------------------------------------------------------------------------
# 3b. Refuse to run next to a pre-rename install: a running legacy container,
#     the legacy EFS mount point, a data directory still under its old name,
#     or a legacy checkout. Each would put a second server on one database or
#     start the brain on an empty directory. deploy/deploy.sh shares the logic.
# ---------------------------------------------------------------------------
# shellcheck source=/dev/null
. "$GUARD_LIB"
if [ -z "$STAGE_DIR" ]; then rm -f "$GUARD_LIB"; fi
GUARDS_OK=1
legacy_guard_container || GUARDS_OK=0
legacy_guard_mount "$STACK_PROJECT" || GUARDS_OK=0
legacy_guard_data_dir "$EFS_DATA" || GUARDS_OK=0
legacy_guard_repo "$REPO_DIR" || GUARDS_OK=0
if [ "$GUARDS_OK" -ne 1 ]; then
  [ -n "$STAGE_DIR" ] && rm -rf "$STAGE_DIR"
  echo "[bootstrap] FATAL: a pre-rename install is in the way (see above); nothing was started"
  exit 1
fi
if [ -n "$STAGE_DIR" ]; then
  if [ -d "$REPO_DIR" ]; then rmdir "$REPO_DIR"; fi
  mv "${STAGE_DIR}/repo" "$REPO_DIR"
  rmdir "$STAGE_DIR"
else
  git -C "${REPO_DIR}" merge --ff-only '@{upstream}'
fi

# ---------------------------------------------------------------------------
# 4. Seed canonical EFS dirs (idempotent). After the legacy guards: seeding
#    the memrain dir first would hide a data directory that still needs its mv.
# DO NOT use `chown -R` on the data tree — that walks every file on every
# boot over NFS (5-15 min stall on a populated vault). Only chown the dirs
# we seeded; pre-existing content keeps its existing ownership.
# ---------------------------------------------------------------------------
SEEDED=()
# workspace/memory and memrain are bind sources compose will not create.
for d in vault memrain workspace workspace/memory skills credentials; do
  TARGET="${EFS_DATA}/${d}"
  mkdir -p "$TARGET"
  SEEDED+=("$TARGET")
done
chown 1000:1000 "$EFS_DATA" "${SEEDED[@]}" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4b. Code-index seed — memrain expects a checkout at ${EFS_REPO} so the
# code-chunkers have files to index. Empty -> "0 indexable files" warning;
# we make it idempotent: clone if absent, pull otherwise.
# ---------------------------------------------------------------------------
if [ -d "${EFS_REPO}/.git" ]; then
  git -C "${EFS_REPO}" pull --ff-only || echo "[bootstrap] WARN: code-index pull failed (continuing)"
else
  git_clone_with_retry "$STACK_REPO_URL" "$EFS_REPO" \
    || echo "[bootstrap] WARN: code-index clone failed — memrain will start with empty index"
fi
# compose binds it with create_host_path: false, so it must exist even empty.
mkdir -p "$EFS_REPO"
chown -R 1000:1000 "$EFS_REPO" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 5. Render /opt/<project>/.env from the env contract.
#    Both bash scripts and docker compose (via --env-file) read this file.
# ---------------------------------------------------------------------------
# Only a real domain yields a public origin. Without one, leave it empty so the
# server keeps its request-host fallback instead of advertising "https://sub.".
if [ -n "${STACK_DOMAIN:-}" ]; then
  STACK_PUBLIC_URL="https://${STACK_SUBDOMAIN}.${STACK_DOMAIN}"
else
  STACK_PUBLIC_URL=""
fi

# Secret lookups below use the same new-then-old resolution as fetch-secrets.
# Both are read by deploy/secrets/lib.sh.
# shellcheck disable=SC2034
AWS_REGION="$STACK_AWS_REGION"
# shellcheck disable=SC2034
SECRETS_PREFIX="$STACK_SECRETS_PREFIX"
# shellcheck source=/dev/null
. "${REPO_DIR}/deploy/secrets/lib.sh"

# The optional *_SECRET_NAME keys live in .env, which is rewritten below. Carry
# them over: a value from /etc/stack-env wins, else the previous .env's value.
# Dropped, fetch-secrets would look up the default names instead.
if [ -f "${REPO_DIR}/.env" ]; then
  while IFS='=' read -r key value; do
    case " ${SECRET_NAME_OVERRIDE_KEYS} " in *" ${key} "*) ;; *) continue ;; esac
    if [ -z "${!key:-}" ]; then printf -v "$key" '%s' "$value"; fi
  done < <(
    set +eu
    # shellcheck source=/dev/null
    . "${REPO_DIR}/.env" >/dev/null 2>&1
    for key in $SECRET_NAME_OVERRIDE_KEYS; do printf '%s=%s\n' "$key" "${!key:-}"; done
  )
fi
validate_secret_name_overrides \
  || { echo "[bootstrap] FATAL: invalid secret name override (see above)"; exit 1; }

# A stack with a Postgres URL secret must never start on PGLite: with the flag
# set, fetch-secrets and the entrypoint fail instead of falling back.
REQUIRE_POSTGRES=""
rc=0
secret_id_for postgres-url >/dev/null || rc=$?
case "$rc" in
  0) REQUIRE_POSTGRES=1 ;;
  2) ;;
  *) echo "[bootstrap] FATAL: cannot check the Postgres URL secret (see above)"; exit 1 ;;
esac

cat > "${REPO_DIR}/.env" <<EOF
# Generated by scripts/bootstrap.sh at boot — overwrites any prior file.
PROJECT=${STACK_PROJECT}
AWS_REGION=${STACK_AWS_REGION}
AWS_PROFILE=default
SECRETS_PREFIX=${STACK_SECRETS_PREFIX}
DOMAIN=${STACK_DOMAIN}
SUBDOMAIN=${STACK_SUBDOMAIN}
PUBLIC_HOST=${STACK_SUBDOMAIN}.${STACK_DOMAIN}
# The external origin, needed whole (scheme included) by every absolute URL the
# server emits: the OAuth issuer and the admin magic link. This file is
# rewritten by every bootstrap run, so a hand-added value here does not survive
# the next one. Empty when no domain is configured — the server then falls back
# to the request host rather than advertising a malformed "https://sub." origin.
MEMRAIN_PUBLIC_URL=${STACK_PUBLIC_URL}
REPO_DIR=${REPO_DIR}
EFS_MOUNT=${EFS_DATA}
EFS_REPO=${EFS_REPO}
MEMRAIN_PUBLIC_WRITE=${MEMRAIN_PUBLIC_WRITE:-${MEMEX_PUBLIC_WRITE:-0}}
# The compose file set, so "docker compose --env-file .env COMMAND" from this
# directory resolves it without a hand-passed -f (verified: compose reads
# COMPOSE_FILE out of the file given to --env-file). The caddy branch below
# rewrites this line to append its ingress overlay.
COMPOSE_FILE=deploy/docker-compose.yml
EOF
if [ "$REQUIRE_POSTGRES" = "1" ]; then
  echo "MEMRAIN_REQUIRE_POSTGRES=1" >> "${REPO_DIR}/.env"
fi
for key in $SECRET_NAME_OVERRIDE_KEYS; do
  if [ -n "${!key:-}" ]; then printf '%s=%s\n' "$key" "${!key}" >> "${REPO_DIR}/.env"; fi
done
chmod 0600 "${REPO_DIR}/.env"

# ---------------------------------------------------------------------------
# 6. Fetch secrets -> .env files for compose
# ---------------------------------------------------------------------------
SECRETS_PREFIX="$STACK_SECRETS_PREFIX" \
  bash "${REPO_DIR}/deploy/secrets/fetch-secrets.sh"

# ---------------------------------------------------------------------------
# 6b. Admin surface. The token gates the admin login and, with it, the
# operator-consent path for /authorize. It goes into .env (not into
# .secrets/memrain.env) on purpose: docker-compose.yml lists
# MEMRAIN_ADMIN_BOOTSTRAP under `environment:`, and an `environment:` entry that
# interpolates to empty OVERRIDES the same key coming from an env_file — the
# token would be silently blanked. Absent secret -> the server mints an
# ephemeral token per restart and /authorize auto-approves, so gate the
# require-login flag on the secret actually existing. Any lookup error other
# than "not found" is fatal for the same reason: reading it as "absent" would
# silently leave /authorize open.
# ---------------------------------------------------------------------------
# Never leak the value via shell trace if someone re-runs this with `bash -x`
# (the header documents that re-run). Same guard as fetch-secrets.sh.
set +x
ADMIN_BOOTSTRAP=""
rc=0
ADMIN_ID="$(resolve_secret_id memrain-admin-bootstrap memex-admin-bootstrap)" || rc=$?
if [ "$rc" -eq 0 ]; then
  ADMIN_BOOTSTRAP="$(secret_value "$ADMIN_ID")" || rc=$?
fi
case "$rc" in
  0|2) ;;
  *) echo "[bootstrap] FATAL: cannot read the admin bootstrap secret (see above); refusing to leave /authorize open"; exit 1 ;;
esac
if [ -n "$ADMIN_BOOTSTRAP" ]; then
  {
    printf 'MEMRAIN_ADMIN_BOOTSTRAP=%s\n' "$ADMIN_BOOTSTRAP"
    printf 'MEMRAIN_OAUTH_REQUIRE_LOGIN=1\n'
  } >> "${REPO_DIR}/.env"
  unset ADMIN_BOOTSTRAP
  echo "[bootstrap] admin bootstrap token fetched from ${ADMIN_ID}; OAuth consent gated on operator login"
else
  echo "[bootstrap] WARN: ${STACK_SECRETS_PREFIX}/memrain-admin-bootstrap (or memex-admin-bootstrap) is empty or absent — /authorize will auto-approve and the admin token resets on every restart"
fi

# ---------------------------------------------------------------------------
# 7. Bake AWS profile config so containers inheriting ~/.aws/config can
#    use the EC2 instance metadata service for credentials.
# ---------------------------------------------------------------------------
# Log sink for the shipped systemd unit (memrain-rotate-bearer). Absent, the
# unit fails on first start.
mkdir -p /var/log/memrain

mkdir -p /home/ec2-user/.aws
cat > /home/ec2-user/.aws/config <<AWSEOF
[default]
region = ${STACK_AWS_REGION}
credential_source = Ec2InstanceMetadata
AWSEOF
# 0644: the telegram-bridge container runs as uid 10001 and bind-mounts
# this file at /home/bridge/.aws/config. The config carries no secret —
# it just points the AWS SDK at IMDS, where actual credentials come
# from the EC2 instance role. World-readable is correct.
chmod 0644 /home/ec2-user/.aws/config

# ---------------------------------------------------------------------------
# 7b. Caddy ingress (ingress_mode = "caddy"): TLS terminates on the instance
# instead of a Cloudflare Tunnel. Caddy runs as a compose override so
# compose owns its lifecycle and network together with memrain; the
# cloudflared service is parked behind a profile it never matches.
# ---------------------------------------------------------------------------
COMPOSE_FILES=(-f deploy/docker-compose.yml)
if [ "$STACK_INGRESS_MODE" = "caddy" ]; then
  : "${STACK_DOMAIN:?STACK_DOMAIN is required for the caddy ingress (Caddyfile site address)}"
  INGRESS_HOST="${STACK_SUBDOMAIN}.${STACK_DOMAIN}"
  mkdir -p "/etc/${STACK_PROJECT}" "${EFS_DATA}/caddy-data" "${EFS_DATA}/caddy-config"

  # Site-scope request_header: memrain's auth guard keys on Cf-Connecting-Ip
  # being present; setting it at site scope (plus header_up inside the
  # proxy block) keeps auth enforced even if routes are added later.
  # MEMRAIN_ASSUME_PUBLIC below is the primary control — the headers are
  # belt and braces.
  cat > "/etc/${STACK_PROJECT}/Caddyfile" <<EOF
{
	servers {
		timeouts {
			read_header 10s
			read_body 30s
			idle 2m
		}
	}
}

${INGRESS_HOST} {
	request_header Cf-Connecting-Ip {remote_host}
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	reverse_proxy memrain:18790 {
		header_up Cf-Connecting-Ip {remote_host}
	}
}
EOF

  cat > "/etc/${STACK_PROJECT}/compose.caddy.yml" <<EOF
# Caddy ingress override (written by bootstrap.sh when ingress_mode=caddy).
# Used as: docker compose -f deploy/docker-compose.yml -f /etc/${STACK_PROJECT}/compose.caddy.yml
services:
  # Stock tunnel ingress parked: a profile it never matches means no plain
  # 'up -d' with these files can start it.
  cloudflared:
    profiles: ["disabled"]
  caddy:
    # Tag pinned to the 2.10 minor; bump intentionally after a smoke test
    # (same policy as the cloudflared pin in deploy/docker-compose.yml).
    image: caddy:2.10
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    read_only: true
    tmpfs:
      - /tmp
    mem_limit: 256m
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - /etc/${STACK_PROJECT}/Caddyfile:/etc/caddy/Caddyfile:ro
      - ${EFS_DATA}/caddy-data:/data
      - ${EFS_DATA}/caddy-config:/config
    networks:
      - internal
    depends_on:
      # started (not healthy): an unhealthy memrain must not block the first
      # ACME issuance — Caddy serving 502s is harmless, repeated failed
      # ACME validations burn Let's Encrypt quota.
      memrain:
        condition: service_started
    healthcheck:
      test: ["CMD", "caddy", "version"]
      interval: 60s
      timeout: 5s
      retries: 3
EOF
  COMPOSE_FILES+=(-f "/etc/${STACK_PROJECT}/compose.caddy.yml")

  # Record the file set so every LATER compose invocation resolves it too:
  # deploy/deploy.sh, a manual `docker compose`, the ship loop in CLAUDE.md.
  # Without this the running Caddy is an orphan to those commands (one
  # `--remove-orphans` deletes the only route into the box) and the parked
  # cloudflared service becomes startable again with an empty tunnel token.
  sed -i "s#^COMPOSE_FILE=.*#COMPOSE_FILE=deploy/docker-compose.yml:/etc/${STACK_PROJECT}/compose.caddy.yml#" \
    "${REPO_DIR}/.env"

  # The auth guard must treat EVERY request as public behind Caddy — without
  # this a request that dodges the header injection is served unauthenticated.
  grep -Eq '^(MEMRAIN|MEMEX)_ASSUME_PUBLIC=' "${REPO_DIR}/.env" \
    || echo "MEMRAIN_ASSUME_PUBLIC=1" >> "${REPO_DIR}/.env"

  # Best-effort wait for public DNS before the first ACME attempt. Non-fatal —
  # Caddy retries issuance on its own; this just makes the first boot clean.
  for _ in $(seq 1 12); do
    getent hosts "$INGRESS_HOST" >/dev/null 2>&1 && break
    echo "[bootstrap] waiting for DNS ${INGRESS_HOST} ..."
    sleep 10
  done
fi

# ---------------------------------------------------------------------------
# 8. Compose up
# ---------------------------------------------------------------------------
cd "$REPO_DIR"
docker compose --env-file .env "${COMPOSE_FILES[@]}" config -q \
  || { echo "[bootstrap] FATAL: compose files do not validate"; exit 1; }
docker compose --env-file .env "${COMPOSE_FILES[@]}" pull --quiet
docker compose --env-file .env "${COMPOSE_FILES[@]}" up -d --build

echo "[bootstrap] stack up. Status:"
docker compose --env-file .env "${COMPOSE_FILES[@]}" ps

if [ "$STACK_INGRESS_MODE" = "caddy" ]; then
  # Auth smoke test: the public /mcp MUST reject unauthenticated requests.
  # Warn-only — DNS/ACME may still be settling on a first boot.
  AUTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
    -X POST "https://${INGRESS_HOST}/mcp" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' || echo 000)
  if [ "$AUTH_CODE" = "401" ] || [ "$AUTH_CODE" = "403" ]; then
    echo "[bootstrap] auth smoke test OK (unauthenticated /mcp -> $AUTH_CODE)"
  else
    echo "[bootstrap] WARNING: unauthenticated /mcp returned $AUTH_CODE (expected 401/403) - VERIFY AUTH BEFORE USE"
  fi
fi
