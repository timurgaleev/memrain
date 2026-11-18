#!/usr/bin/env bash
# tests/deploy-single-tenant-trace.test.sh — the single-tenant deploy, pinned.
#
# Runs deploy/deploy.sh against stub `docker`, `git`, `timeout`, `sleep` and
# `memrain` on a host with no deploy/tenants/ and no hosting variables, and
# compares every command it issues, its exit code and its output byte for byte
# with tests/fixtures/deploy-single-tenant.trace. That file was recorded from
# deploy.sh before any hosting change. A hosting-aware deploy must leave a
# single-tenant host on exactly this path; a diff here is a regression, not a
# fixture to refresh.
#
# DEPLOY_TRACE_OUT=<file> also writes the trace this run produced (debug aid).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="$REPO_ROOT/tests/fixtures/deploy-single-tenant.trace"
TMPROOT="$(mktemp -d -t deploy-trace.XXXXXX)"
PASS=0
FAIL=0
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "deploy-single-tenant-trace.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

command -v jq >/dev/null 2>&1 || { echo "deploy-single-tenant-trace.test.sh: jq not installed — skipping"; exit 0; }

# Stub state lives in $S:
#   pre_running    the app container runs before the deploy
#   health.json    /health body (@VERSION@ is filled in)
#   status.json    `status` output
#   services       services `compose config --services` prints
#   calls.log      one line per stubbed call
write_stubs() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/docker" <<'STUB'
#!/usr/bin/env bash
set -u
S="$STUB_DIR"
printf 'docker %s\n' "$*" >> "$S/calls.log"
case "$1" in
  inspect)
    case "$*" in
      *State.Running*) if [ -e "$S/pre_running" ] || [ -e "$S/up_done" ]; then echo true; else echo false; fi ;;
      *State.Health.Status*) if [ -e "$S/up_done" ]; then echo healthy; else echo missing; fi ;;
    esac ;;
  exec)
    case "$*" in
      *"cli.ts status"*) cat "$S/status.json" ;;
      *"/health"*) sed "s/@VERSION@/$(cat "$S/version")/" "$S/health.json" ;;
    esac ;;
  compose)
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        --env-file|-f) shift 2 ;;
        *) break ;;
      esac
    done
    case "$1" in
      config) [ "${2:-}" = "--services" ] && cat "$S/services" ;;
      up) case "$*" in *--no-deps*) touch "$S/up_done" ;; *) touch "$S/ingress_up" ;; esac ;;
      stop) shift; for svc in "$@"; do touch "$S/stopped_$svc"; done ;;
      ps)
        if [ -e "$S/ingress_up" ]; then cat "$S/services"; exit 0; fi
        while read -r svc; do
          case "$svc" in
            cloudflared|caddy) [ -e "$S/stopped_$svc" ] || echo "$svc" ;;
          esac
        done < "$S/services" ;;
    esac ;;
esac
exit 0
STUB
  cat > "$bin/git" <<'STUB'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$STUB_DIR/calls.log"
cat "$STUB_DIR/version"
STUB
  cat > "$bin/timeout" <<'STUB'
#!/usr/bin/env bash
printf 'timeout %s\n' "$*" >> "$STUB_DIR/calls.log"
shift
exec "$@"
STUB
  cat > "$bin/sleep" <<'STUB'
#!/usr/bin/env bash
printf 'sleep %s\n' "$*" >> "$STUB_DIR/calls.log"
STUB
  # The single-tenant path never calls the memrain CLI on the host; any call
  # lands in the trace and breaks the comparison.
  cat > "$bin/memrain" <<'STUB'
#!/usr/bin/env bash
printf 'memrain %s\n' "$*" >> "$STUB_DIR/calls.log"
STUB
  chmod +x "$bin/docker" "$bin/git" "$bin/timeout" "$bin/sleep" "$bin/memrain"
}

N=0
ws_new() {
  N=$((N + 1))
  WS="$TMPROOT/ws$N"
  S="$WS/stub"
  mkdir -p "$WS/deploy/lib" "$WS/deploy/.secrets" "$S/bin"
  cp "$REPO_ROOT/deploy/deploy.sh" "$WS/deploy/"
  cp "$REPO_ROOT/deploy/lib/legacy-guard.sh" "$WS/deploy/lib/"
  printf 'AWS_REGION=eu-west-1\n' > "$WS/.env"
  write_stubs "$S/bin"
  echo v1.0.0 > "$S/version"
  printf '{"ok":true,"db":"postgres","version":"@VERSION@"}\n' > "$S/health.json"
  printf '{"ok":true,"oauth_self_issued":true,"oauth_clients_live":2,"stats":{"pages":100}}\n' > "$S/status.json"
  printf 'memrain\ncloudflared\n' > "$S/services"
}

# trace NAME [VAR=VALUE...] -> the scenario's section of the trace on stdout.
trace() {
  local name="$1" ec=0
  shift
  (cd "$WS" && env -i PATH="$S/bin:$PATH" HOME="$WS" STUB_DIR="$S" "$@" \
    bash deploy/deploy.sh) > "$WS/out.log" 2>&1 || ec=$?
  printf '### %s\n' "$name"
  [ -d "$WS/deploy/tenants" ] && echo "deploy/tenants appeared"
  cat "$S/calls.log" 2>/dev/null
  printf -- '--- exit %s\n' "$ec"
  sed "s#$WS#<ws>#g" "$WS/out.log"
}

all_traces() {
  ws_new; touch "$S/pre_running"
  trace "running app, cloudflared ingress"
  ws_new
  printf 'COMPOSE_FILE=deploy/docker-compose.yml:/etc/memrain/compose.caddy.yml\n' >> "$WS/.env"
  printf 'memrain\ncaddy\nbackup\n' > "$S/services"
  trace "first deploy, caddy overlay from .env"
  ws_new; printf '{"ok":true,"db":"postgres","version":"@VERSION@","maintenance":true}\n' > "$S/health.json"
  trace "maintenance holds the ingress"
  ws_new; printf '{"ok":true,"oauth_self_issued":true,"oauth_clients_live":0,"stats":{"pages":0}}\n' > "$S/status.json"
  trace "empty brain fails the page gate"
}

echo "== deploy.sh single-tenant trace =="

ACTUAL="$TMPROOT/actual.trace"
all_traces > "$ACTUAL"
[ -n "${DEPLOY_TRACE_OUT:-}" ] && cp "$ACTUAL" "$DEPLOY_TRACE_OUT"

if [ ! -f "$BASELINE" ]; then
  die "baseline missing: $BASELINE"
elif diff -u "$BASELINE" "$ACTUAL"; then
  pass "single-tenant deploy matches the recorded trace ($(grep -c '^### ' "$BASELINE") scenarios)"
else
  die "single-tenant deploy diverged from the recorded trace (diff above)"
fi
