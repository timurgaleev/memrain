#!/usr/bin/env bash
# Deploy the memrain container from the checkout in /opt/<project>, stamped
# with the version it was built from, and start the ingress only after the new
# container proved it serves the real brain.
#
# Order: preflights (compose parses, no pre-rename container, the secrets are
# staged under the new name, the Postgres URL is staged when required) → build
# the image → stop the ingress → read the page floor from the old app → start
# the app alone → healthy + stamp gate → data gates (db=postgres, pages ≥ the
# floor, OAuth state consistent) → ingress. A failed build changes nothing
# that runs. A failed gate leaves the ingress stopped and the app unreachable
# from outside.
# With MEMRAIN_MAINTENANCE=1 the ingress is held back.
#
# Why the stamp exists: the build arg, the Dockerfile ENV, `version.ts` and the
# `/health` payload were wired end to end, but nothing ever supplied the value,
# so every image ever built was stamped `dev`. A deploy could not be told apart
# from a no-op.
#
# Run from the repo root on the instance, after `git pull --ff-only`.
#
# Knobs (shell env):
#   DEPLOY_MIN_PAGES   page floor when no container is running to read one
#                      from (a non-negative integer). The larger of the two
#                      wins when both are known.
#   DEPLOY_ALLOW_PGLITE=1   accept db=pglite (a dev or PGLite install). The
#                      page and OAuth gates cannot run there and are skipped.
#   DEPLOY_ALLOW_EMPTY=1    accept an empty brain (a fresh install).
#   DEPLOY_ALLOW_INGRESS_IN_MAINTENANCE=1   start the ingress even in
#                      maintenance (a rehearsal only).
#   DEPLOY_STATUS_TIMEOUT   seconds any one read of the app's status or
#                      /health may take (a positive integer, default 60).
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# A hosting host (deploy/tenants/*.yml exists) runs one brain per tenant and
# no single-tenant brain: it deploys tenant by tenant instead (docs/HOSTING.md).
if compgen -G "${SCRIPT_DIR}/tenants/*.yml" > /dev/null; then
  exec bash "${SCRIPT_DIR}/tenant/deploy-tenants.sh" "$@"
fi

# The ingress overlay (Caddy, when ingress_mode=caddy) is a SECOND compose file
# chosen at bootstrap and recorded as COMPOSE_FILE in the host .env. Resolving
# only the base file here would treat the running ingress container as an
# orphan — one `--remove-orphans` away from deleting the only route into the
# box — and would leave the parked cloudflared service startable with an empty
# token. Shell env wins; .env is the fallback.
if [ -z "${COMPOSE_FILE:-}" ] && [ -f "$ENV_FILE" ]; then
  # Compose strips surrounding quotes and trailing whitespace when it reads
  # this itself; a raw sed does not, and `-f '"a' ` then fails the deploy.
  COMPOSE_FILE="$(sed -n 's/^COMPOSE_FILE=//p' "$ENV_FILE" | tail -1 |
    sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
fi
COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.yml}"

# COMPOSE_FILE is a ':'-separated list (docker compose's own convention);
# expand it into repeated -f flags. A single path passes through unchanged.
COMPOSE_ARGS=()
IFS=':' read -r -a _compose_files <<< "$COMPOSE_FILE"
for _f in "${_compose_files[@]}"; do
  [ -n "$_f" ] && COMPOSE_ARGS+=(-f "$_f")
done
SERVICE="${SERVICE:-memrain}"
CONTAINER="${CONTAINER:-deploy-memrain-1}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"
APP_SECRETS="${SCRIPT_DIR}/.secrets/memrain.env"

# shellcheck source=deploy/lib/legacy-guard.sh
. "${SCRIPT_DIR}/lib/legacy-guard.sh"

compose() { docker compose --env-file "$ENV_FILE" "${COMPOSE_ARGS[@]}" "$@"; }

# env_value KEY -> the value compose interpolates for KEY: the shell env
# first, then the last KEY= line of $ENV_FILE (quotes stripped).
env_value() {
  local key="$1" v="${!1:-}"
  if [ -z "$v" ] && [ -f "$ENV_FILE" ]; then
    v="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -1 |
      sed -e 's/[[:space:]]\{1,\}#.*$//' -e 's/[[:space:]]*$//' \
        -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  fi
  printf '%s' "$v"
}

# app_status -> the `status` JSON of the running app. The object starts at the
# first line that opens with `{`; a stray log line before it cannot break jq.
app_status() {
  local out
  out="$(timeout "$STATUS_TIMEOUT" docker exec "$CONTAINER" bun run src/cli.ts status)" || return 1
  printf '%s\n' "$out" | sed -n '/^{/,$p'
}

# app_db -> the engine the running app reports on /health (postgres, pglite).
app_db() {
  timeout "$STATUS_TIMEOUT" docker exec "$CONTAINER" wget -qO- http://localhost:18790/health 2>/dev/null | jq -r '.db // empty'
}

# restore_ingress -> start the ingress services stopped below again and
# confirm they run. For failures where the old app was never replaced.
restore_ingress() {
  local running svc
  [ "${#INGRESS[@]}" -gt 0 ] || return 0
  compose start "${INGRESS[@]}" || { echo "FAIL: could not restart the ingress (${INGRESS[*]})" >&2; return 1; }
  running="$(compose ps --status running --services)" || { echo "FAIL: cannot confirm the ingress restarted" >&2; return 1; }
  for svc in "${INGRESS[@]}"; do
    if ! printf '%s\n' "$running" | grep -qx "$svc"; then
      echo "FAIL: ${svc} is not running after the restart" >&2
      return 1
    fi
  done
  echo "==> ingress restarted (${INGRESS[*]}); ${SERVICE} was not replaced" >&2
}

# Armed from the ingress stop until the app swap: any exit in between leaves
# the old app serving, so its ingress comes back first.
restore_on_exit() {
  local rc=$?
  trap - EXIT
  restore_ingress || true
  exit "$rc"
}

command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required (dnf install -y jq)" >&2; exit 1; }
command -v timeout >/dev/null 2>&1 || { echo "FAIL: timeout is required (dnf install -y coreutils)" >&2; exit 1; }

# ---- Preflights: nothing is touched until all of them pass -----------------

MIN_PAGES="${DEPLOY_MIN_PAGES:-}"
if [ -n "$MIN_PAGES" ] && ! [[ "$MIN_PAGES" =~ ^[0-9]+$ ]]; then
  echo "FAIL: DEPLOY_MIN_PAGES must be a non-negative integer, got '${MIN_PAGES}'" >&2
  exit 1
fi
STATUS_TIMEOUT="${DEPLOY_STATUS_TIMEOUT:-60}"
if ! [[ "$STATUS_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  echo "FAIL: DEPLOY_STATUS_TIMEOUT must be a positive integer, got '${STATUS_TIMEOUT}'" >&2
  exit 1
fi

# A. The compose set must parse. A caddy overlay rendered before the rename
# still says `depends_on: memex:`, and compose refuses the whole set.
if ! compose config -q; then
  echo "FAIL: docker compose cannot parse ${COMPOSE_FILE}" >&2
  for _f in "${_compose_files[@]}"; do
    if [ -f "$_f" ] && grep -Eq '^[[:space:]]+memex:[[:space:]]*$' "$_f"; then
      echo "      ${_f} still names the pre-rename service. Fix it with:" >&2
      printf '        sed -i %s %s\n' "'s/^\([[:space:]]\+\)memex:[[:space:]]*\$/\1memrain:/'" "$_f" >&2
      echo "      (see UPGRADING)" >&2
    fi
  done
  exit 1
fi

# B. A pre-rename container must not run next to the new one.
legacy_guard_container || exit 1

# C. When Postgres is required, its URL must already be staged; otherwise the
# entrypoint refuses to start (exit 78) after the old container is gone.
REQUIRE_POSTGRES="$(env_value MEMRAIN_REQUIRE_POSTGRES)"
[ -n "$REQUIRE_POSTGRES" ] || REQUIRE_POSTGRES="$(env_value MEMEX_REQUIRE_POSTGRES)"
if [ "$REQUIRE_POSTGRES" = "1" ] && ! grep -Eq '^MEMRAIN_POSTGRES_URL=.+' "$APP_SECRETS" 2>/dev/null; then
  echo "FAIL: MEMRAIN_REQUIRE_POSTGRES=1 but ${APP_SECRETS} has no MEMRAIN_POSTGRES_URL" >&2
  echo "      run deploy/secrets/fetch-secrets.sh first" >&2
  exit 1
fi

# D. Compose reads only memrain.env. A host upgraded with `git pull` alone
# still has just the pre-rename memex.env, and the app would start without its
# Postgres URL, public bearer and internal token.
if [ -e "${SCRIPT_DIR}/.secrets/memex.env" ] && [ ! -e "$APP_SECRETS" ]; then
  echo "FAIL: ${SCRIPT_DIR}/.secrets/memex.env exists but ${APP_SECRETS} does not" >&2
  echo "      run deploy/secrets/fetch-secrets.sh first" >&2
  exit 1
fi

# ---- Build and start the app alone -----------------------------------------

# The stamp: an exact release tag when HEAD is one, else <tag>-<n>-g<sha>, else
# the sha. Only v<digit> tags count, so archived tags never name a build.
# Deliberately NOT package.json and NOT a hand-passed string.
MEMRAIN_VERSION="$(git describe --tags --match 'v[0-9]*' --always --dirty)"
MEMEX_VERSION="$MEMRAIN_VERSION"
export MEMRAIN_VERSION MEMEX_VERSION
echo "==> building ${SERVICE} stamped ${MEMRAIN_VERSION}"

# Build before anything is stopped: a failed build must leave the running app
# and its ingress exactly as they were.
compose build "$SERVICE"

# The ingress goes down before the new app starts. Left running, it reaches the
# new container through the pre-rename network alias as soon as it joins, before
# the gates below have run and even in maintenance. It comes back only in the
# ingress step at the end. Only the ingress services compose resolves are
# named; nothing else is stopped and nothing is treated as an orphan.
services="$(compose config --services)" || { echo "FAIL: docker compose cannot list the services of ${COMPOSE_FILE}" >&2; exit 1; }
INGRESS=()
for svc in $services; do
  case "$svc" in cloudflared|caddy) INGRESS+=("$svc") ;; esac
done
if [ "${#INGRESS[@]}" -gt 0 ]; then
  echo "==> stopping the ingress (${INGRESS[*]}) until the new app passes its gates"
  trap restore_on_exit EXIT
  compose stop "${INGRESS[@]}" || { echo "FAIL: could not stop the ingress (${INGRESS[*]}); ${SERVICE} was not started" >&2; exit 1; }
  still="$(compose ps --status running --services)" || { echo "FAIL: cannot confirm the ingress stopped; ${SERVICE} was not started" >&2; exit 1; }
  for svc in "${INGRESS[@]}"; do
    if printf '%s\n' "$still" | grep -qx "$svc"; then
      echo "FAIL: ${svc} is still running after stop; ${SERVICE} was not started" >&2
      exit 1
    fi
  done
fi

# The page floor: what the running container serves now, and DEPLOY_MIN_PAGES
# when no container runs (the upgrade path, where an EFS or bind mistake would
# present an empty corpus). The larger one wins. Read only once the ingress is
# down, so no write from outside can land after it. A PGLite data dir is locked
# by the running server, so `status` cannot open it next to serve: no pre-read.
PRE_PAGES=""
if [ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null || true)" = "true" ] \
   && [ "$(app_db || true)" != "pglite" ]; then
  if ! PRE_PAGES="$(app_status | jq -er '.stats.pages')" \
     || ! [[ "$PRE_PAGES" =~ ^[0-9]+$ ]]; then
    echo "FAIL: ${CONTAINER} is running but its page count cannot be read (or the read took over ${STATUS_TIMEOUT}s)" >&2
    echo "      stop it and re-run with DEPLOY_MIN_PAGES=<last known page count>" >&2
    exit 1
  fi
fi
FLOOR="$PRE_PAGES"
if [ -n "$MIN_PAGES" ] && { [ -z "$FLOOR" ] || [ "$MIN_PAGES" -gt "$FLOOR" ]; }; then
  FLOOR="$MIN_PAGES"
fi

# From here a failure stops the new app and leaves the ingress down (gate_fail).
trap - EXIT
compose up -d --no-build --no-deps "$SERVICE"

echo "==> waiting for ${CONTAINER} to report healthy (max ${HEALTH_TIMEOUT_S}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
while true; do
  status="$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)"
  [ "$status" = "healthy" ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "FAIL: ${CONTAINER} is '${status}' after ${HEALTH_TIMEOUT_S}s" >&2
    docker logs --tail 40 "$CONTAINER" >&2 || true
    exit 1
  fi
  sleep 5
done

# The stamp gate. A container that came up healthy but is serving the previous
# image reports the previous stamp — which is exactly the failure a deploy check
# is for, and exactly the one a hardcoded version string cannot catch.
HEALTH="$(timeout "$STATUS_TIMEOUT" docker exec "$CONTAINER" wget -qO- http://localhost:18790/health)"
running="$(printf '%s' "$HEALTH" | jq -r '.version // empty')"
if [ "$running" != "$MEMRAIN_VERSION" ]; then
  echo "FAIL: built ${MEMRAIN_VERSION} but the container serves '${running}'" >&2
  echo "      the running image is not the one just built — investigate before trusting this deploy." >&2
  exit 1
fi

# ---- Data gates, before any ingress ----------------------------------------

gate_fail() {
  echo "FAIL: $*" >&2
  echo "      stopping ${SERVICE}; the ingress was not started" >&2
  compose stop "$SERVICE" || true
  exit 1
}

DB="$(printf '%s' "$HEALTH" | jq -r '.db // empty')"
if [ "$DB" != "postgres" ] && [ "${DEPLOY_ALLOW_PGLITE:-}" != "1" ]; then
  gate_fail "/health reports db='${DB}', not postgres (DEPLOY_ALLOW_PGLITE=1 to accept)"
fi

if [ "$DB" = "pglite" ]; then
  # PGLite is single-process: serve holds the data-dir lock, so `status`
  # cannot open the brain to count pages. An explicit floor cannot be checked.
  [ -z "$MIN_PAGES" ] || gate_fail "DEPLOY_MIN_PAGES=${MIN_PAGES} cannot be checked on PGLite"
  echo "WARN: db=pglite: the page and OAuth gates need status, which cannot run next to serve; skipped" >&2
  PAGES="n/a"
else
  STATUS="$(app_status)" || gate_fail "status failed in ${CONTAINER}"
  PAGES="$(printf '%s' "$STATUS" | jq -er '.stats.pages')" || gate_fail "status has no stats.pages"
  [[ "$PAGES" =~ ^[0-9]+$ ]] || gate_fail "status reports pages='${PAGES}'"
  if [ "$PAGES" -eq 0 ] && [ "${DEPLOY_ALLOW_EMPTY:-}" != "1" ]; then
    gate_fail "the brain has 0 pages (DEPLOY_ALLOW_EMPTY=1 to accept)"
  fi
  if [ -n "$FLOOR" ] && [ "$PAGES" -lt "$FLOOR" ]; then
    gate_fail "the brain has ${PAGES} pages, fewer than the ${FLOOR} before this deploy"
  fi
  # OAuth clients exist but the server does not issue tokens: a recreated
  # config.json that silently switched self-issued OAuth off.
  SELF_ISSUED="$(printf '%s' "$STATUS" | jq -r '.oauth_self_issued')"
  CLIENTS="$(printf '%s' "$STATUS" | jq -r '.oauth_clients_live // 0')"
  if [ "$SELF_ISSUED" = "false" ] && [[ "$CLIENTS" =~ ^[0-9]+$ ]] && [ "$CLIENTS" -gt 0 ]; then
    gate_fail "${CLIENTS} OAuth clients exist but oauth_self_issued is false (config.json lost its auth block?)"
  fi
fi

# ---- Maintenance: every gate ran, the ingress stays down --------------------

if [ "$(printf '%s' "$HEALTH" | jq -r '.maintenance // false')" = "true" ] \
   && [ "${DEPLOY_ALLOW_INGRESS_IN_MAINTENANCE:-}" != "1" ]; then
  echo "HELD: maintenance on; ingress not started"
  echo "  ${CONTAINER} serves ${running}, db=${DB}, pages=${PAGES}. Next:"
  echo "  1. docker exec ${CONTAINER} bun run src/cli.ts status --quiescent   (must exit 0)"
  echo "  2. psql \"\$URL\" -X -A -t -q -v ON_ERROR_STOP=1 -f deploy/memrain/scripts/sql/data-manifest.sql > P.txt"
  echo "     and compare it with the baseline: diff B.txt P.txt"
  echo "  3. remove MEMRAIN_MAINTENANCE from ${ENV_FILE} and re-run bash deploy/deploy.sh"
  exit 0
fi

# ---- Ingress ---------------------------------------------------------------

# No service named: naming one would activate its profile and could start a
# parked cloudflared with an empty token. No --remove-orphans: the ingress
# overlay's container must never be treated as an orphan.
compose up -d --no-build

missing=""
running_services="$(compose ps --status running --services)"
for svc in $(compose config --services); do
  printf '%s\n' "$running_services" | grep -qx "$svc" || missing="${missing} ${svc}"
done
if [ -n "$missing" ]; then
  echo "FAIL: not running after the ingress start:${missing}" >&2
  exit 1
fi

echo "OK: ${CONTAINER} healthy, serving ${running}, db=${DB}, pages=${PAGES}, ingress up"
