#!/usr/bin/env bash
# tests/deploy-tenants.test.sh — the per-tenant deploy loop of a hosting host.
#
# Runs deploy/deploy.sh on a workspace that has deploy/tenants/*.yml, against
# stub `docker`, `git`, `timeout` and `sleep`, and a stub isolation smoke. The
# stub docker plays the `memrain tenant ...` CLI for `compose run tenant-ctl`.
# Checks the order (control migrations before any tenant), the stop on the
# first failure (migration, health, stamp or smoke), who is covered (every
# tenant except deleting/deleted) and the report.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPROOT="$(mktemp -d -t deploy-tenants.XXXXXX)"
PASS=0
FAIL=0
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "deploy-tenants.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

command -v jq >/dev/null 2>&1 || { echo "deploy-tenants.test.sh: jq not installed — skipping"; exit 0; }

# Stub state in $S:
#   version             what `git describe` prints
#   list.json           what `tenant list --json` prints
#   fail_migrate_control, fail_migrate_<id>, unhealthy_<id>, stale_<id>,
#   smoke_fail_<id>     failure switches
#   up_<id>, ver_<id>   written when a tenant container is (re)created
#   calls.log           one line per call, compose flags stripped
write_stubs() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/docker" <<'STUB'
#!/usr/bin/env bash
set -u
S="$STUB_DIR"
case "$1" in
  compose)
    shift
    files=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --env-file) shift 2 ;;
        -f) files="${files} $(basename "$2")"; shift 2 ;;
        *) break ;;
      esac
    done
    printf 'compose%s | %s\n' "$files" "$*" >> "$S/calls.log"
    case "$1" in
      config) [ -e "$S/config_fail" ] && exit 1; exit 0 ;;
      build) exit 0 ;;
      run)
        while [ $# -gt 0 ] && [ "$1" != "tenant-ctl" ]; do shift; done
        shift
        case "$*" in
          "tenant migrate-control"*) [ -e "$S/fail_migrate_control" ] && { echo "control migration failed" >&2; exit 1; }
            echo '{"ok":true}' ;;
          "tenant list --json"*) cat "$S/list.json" ;;
          "tenant migrate "*) id="$3"; [ -e "$S/fail_migrate_$id" ] && { echo "migration failed for $id" >&2; exit 1; }
            echo "{\"ok\":true,\"tenant\":\"$id\"}" ;;
          *) echo "stub: unexpected ctl call: $*" >&2; exit 2 ;;
        esac ;;
      up)
        svc="${*: -1}"
        case "$svc" in
          memrain-*) id="${svc#memrain-}"; touch "$S/up_$id"; printf '%s' "$MEMRAIN_VERSION" > "$S/ver_$id" ;;
        esac ;;
    esac
    exit 0 ;;
  inspect)
    printf 'docker %s\n' "$*" >> "$S/calls.log"
    c="$2"; id="${c#memrain-}"
    if [ "$c" = deploy-memrain-1 ]; then [ -e "$S/single_running" ] && echo true || echo false; exit 0; fi
    if [ -e "$S/up_$id" ] && [ ! -e "$S/unhealthy_$id" ]; then echo healthy; else echo starting; fi ;;
  exec)
    printf 'docker %s\n' "$*" >> "$S/calls.log"
    c="$2"; id="${c#memrain-}"
    v="$(cat "$S/ver_$id")"; [ -e "$S/stale_$id" ] && v="v0.9.9"
    printf '{"ok":true,"version":"%s"}\n' "$v" ;;
  logs) printf 'docker %s\n' "$*" >> "$S/calls.log" ;;
  *) printf 'docker %s\n' "$*" >> "$S/calls.log" ;;
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
shift
exec "$@"
STUB
  cat > "$bin/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$bin/docker" "$bin/git" "$bin/timeout" "$bin/sleep"
}

N=0
ws_new() {
  N=$((N + 1))
  WS="$TMPROOT/ws$N"
  S="$WS/stub"
  mkdir -p "$WS/deploy/lib" "$WS/deploy/tenant" "$WS/deploy/tenants" "$WS/scripts" "$S/bin"
  cp "$REPO_ROOT/deploy/deploy.sh" "$WS/deploy/"
  cp "$REPO_ROOT/deploy/lib/legacy-guard.sh" "$WS/deploy/lib/"
  cp "$REPO_ROOT/deploy/tenant/"*.sh "$REPO_ROOT/deploy/tenant/compose.hosting.yml" "$WS/deploy/tenant/" 2>/dev/null
  printf 'AWS_REGION=eu-west-1\n' > "$WS/.env"
  # The smoke is its own script with its own tests; here it only logs, and
  # records the tenant as tenant-isolation-smoke.sh does on success.
  cat > "$WS/scripts/tenant-isolation-smoke.sh" <<'SMOKE'
#!/usr/bin/env bash
printf 'smoke %s\n' "$*" >> "$STUB_DIR/calls.log"
[ -e "$STUB_DIR/smoke_fail_$1" ] && { echo "FAIL isolation for $1" >&2; exit 1; }
printf 'smoke-record %s\n' "$1" >> "$STUB_DIR/calls.log"
SMOKE
  write_stubs "$S/bin"
  echo v2.0.0 > "$S/version"
}

# tenants ID:STATUS... -> list.json plus a compose file per id
tenants() {
  local entries="" pair id st
  for pair in "$@"; do
    id="${pair%%:*}"; st="${pair#*:}"
    entries="${entries:+$entries,}{\"id\":\"$id\",\"status\":\"$st\",\"mode\":null,\"hostname\":\"$id.example.test\"}"
    printf 'services: {}\n' > "$WS/deploy/tenants/$id.yml"
  done
  printf '{"ok":true,"tenants":[%s]}\n' "$entries" > "$S/list.json"
}

run_deploy() {
  RC=0
  (cd "$WS" && env -i PATH="$S/bin:$PATH" HOME="$WS" STUB_DIR="$S" "$@" \
    bash deploy/deploy.sh) > "$WS/out.log" 2>&1 || RC=$?
  CALLS="$(cat "$S/calls.log" 2>/dev/null)"
}

# line_of PATTERN -> first line number in calls.log matching the fixed string
line_of() { printf '%s\n' "$CALLS" | grep -nF -- "$1" | head -1 | cut -d: -f1; }
called() { printf '%s\n' "$CALLS" | grep -qF -- "$1"; }
report() { cat "$WS/deploy/tenants/.deploy-report" 2>/dev/null; }

echo "== deploy.sh on a hosting host =="

# ---- 1. Happy path: order and the report --------------------------------
ws_new; tenants ta:active tb:active tc:active
run_deploy
if [ "$RC" -eq 0 ]; then pass "three tenants deploy (exit 0)"; else die "three tenants: exit $RC"; sed 's/^/      /' "$WS/out.log"; fi
mc="$(line_of 'tenant migrate-control')"; ma="$(line_of 'tenant migrate ta')"
if [ -n "$mc" ] && [ -n "$ma" ] && [ "$mc" -lt "$ma" ]; then pass "control migrations run before the first tenant"; else die "control migrations not first (mc=$mc ma=$ma)"; fi
bld="$(line_of '| build tenant-ctl')"
if [ -n "$bld" ] && [ "$bld" -lt "$mc" ] && [ "$(printf '%s\n' "$CALLS" | grep -c '| build')" -eq 1 ]; then pass "the image is built once, before anything else"; else die "build not once/first"; fi
if called 'tenant list --json --status active,suspended,provisioning'; then pass "lists every tenant except deleting/deleted"; else die "list call missing or wrong status filter"; fi
# per tenant: migrate -> recreate -> health -> stamp -> smoke, then the next one
seq_ok=1; prev=0
for id in ta tb tc; do
  for step in "tenant migrate $id" "--force-recreate memrain-$id" "inspect memrain-$id" "exec memrain-$id" "smoke $id" "smoke-record $id"; do
    l="$(line_of "$step")"
    if [ -z "$l" ] || [ "$l" -le "$prev" ]; then seq_ok=0; echo "      out of order: $step (line ${l:-none}, after $prev)"; fi
    prev="${l:-$prev}"
  done
done
if [ "$seq_ok" = 1 ]; then pass "each tenant: migrate, recreate, healthy, stamp, smoke, then the next"; else die "per-tenant order broken"; fi
cf="$(line_of '--no-deps cloudflared')"
if [ -n "$cf" ] && [ "$cf" -gt "$prev" ]; then pass "the ingress is refreshed after the last tenant"; else die "cloudflared not refreshed last"; fi
if printf '%s\n' "$CALLS" | grep -F 'compose' | grep -v 'compose compose.hosting.yml ta.yml tb.yml tc.yml |' | grep -q .; then
  die "a compose call did not use the hosting file set"
else
  pass "every compose call uses compose.hosting.yml plus every tenant file"
fi
if [ "$(report | grep -c ' ok v2.0.0$')" -eq 3 ]; then pass "report lists three tenants ok on v2.0.0"; else die "report wrong:"; report | sed 's/^/      /'; fi
if called '| build memrain' || called 'config --services'; then die "the single-tenant path ran on a hosting host"; else pass "the single-tenant path does not run"; fi

# ---- 2. Control migration fails: no tenant is touched -------------------
ws_new; tenants ta:active tb:active
touch "$S/fail_migrate_control"
run_deploy
if [ "$RC" -ne 0 ] && ! called 'tenant migrate ta' && ! called 'tenant list' && ! called '| up '; then
  pass "a failed control migration stops the deploy before any tenant"
else
  die "control migration failure did not stop the deploy (rc=$RC)"
fi

# ---- 3. Migration of the second of three fails --------------------------
ws_new; tenants ta:active tb:active tc:active
touch "$S/fail_migrate_tb"
run_deploy
if [ "$RC" -ne 0 ] && called 'smoke-record ta' && ! called 'memrain-tb' && ! called 'tenant migrate tc' && ! called 'memrain-tc'; then
  pass "a failed tenant migration stops the loop; later tenants untouched"
else
  die "migration failure on b: rc=$RC"
fi
if report | grep -q '^ta ok' && report | grep -q '^tb FAILED migrate' && report | grep -q '^tc not reached'; then
  pass "report: a ok, b failed at migrate, c not reached"
else
  die "report after b's migration failure:"; report | sed 's/^/      /'
fi
if grep -q 'tb FAILED migrate' "$WS/out.log"; then pass "the report is printed too"; else die "report not printed"; fi
if called '--no-deps cloudflared'; then die "the ingress was refreshed after a failed loop"; else pass "a failed loop leaves the ingress as it was"; fi

# ---- 4. Smoke of the second fails ---------------------------------------
ws_new; tenants ta:active tb:active tc:active
touch "$S/smoke_fail_tb"
run_deploy
if [ "$RC" -ne 0 ] && called 'smoke tb' && ! called 'smoke-record tb' && ! called 'tenant migrate tc' && ! called 'memrain-tc'; then
  pass "a failed smoke stops the loop; b gets no smoke record (stays isolation_unverified), c untouched"
else
  die "smoke failure on b: rc=$RC"
fi
if report | grep -q '^tb FAILED smoke'; then pass "report: b failed at smoke"; else die "report missing b smoke failure"; fi

# ---- 5. Health and stamp gates stop the loop ----------------------------
ws_new; tenants ta:active tb:active
touch "$S/unhealthy_ta"
run_deploy HEALTH_TIMEOUT_S=0
if [ "$RC" -ne 0 ] && ! called 'smoke ta' && ! called 'tenant migrate tb' && report | grep -q '^ta FAILED health'; then
  pass "an unhealthy tenant stops the loop before its smoke"
else
  die "unhealthy a: rc=$RC"
fi
ws_new; tenants ta:active tb:active
touch "$S/stale_ta"
run_deploy
if [ "$RC" -ne 0 ] && ! called 'smoke ta' && ! called 'tenant migrate tb' && report | grep -q '^ta FAILED stamp'; then
  pass "a container serving another stamp stops the loop"
else
  die "stale stamp a: rc=$RC"
fi

# ---- 6. Coverage: suspended is deployed, deleting is skipped ------------
ws_new; tenants ta:active tb:suspended td:deleting
run_deploy
if [ "$RC" -eq 0 ] && called 'tenant migrate tb' && called 'smoke-record tb' && ! called 'tenant migrate td' && ! called 'memrain-td'; then
  pass "a suspended tenant is migrated and recreated; a deleting one is skipped"
else
  die "coverage: rc=$RC"
fi
# After the deploy a `tenant resume` is a control-plane change only; the
# container that answers is the one just recreated, on the new stamp.
if [ "$(cat "$S/ver_tb" 2>/dev/null)" = "v2.0.0" ] && report | grep -q '^tb ok v2.0.0$'; then
  pass "the suspended tenant runs the new stamp, so resume serves the new version"
else
  die "suspended tenant not on the new stamp"
fi
if report | grep -q '^td skipped (deleting)'; then pass "report names the skipped tenant"; else die "report does not name d as skipped"; fi

# ---- 7. Provisioning without a compose file; active without one --------
ws_new; tenants ta:active tp:provisioning
rm -f "$WS/deploy/tenants/tp.yml"
run_deploy
if [ "$RC" -eq 0 ] && called 'tenant migrate tp' && ! called 'memrain-tp' && report | grep -q '^tp migrated (no container yet)'; then
  pass "a provisioning tenant without a container is migrated only"
else
  die "provisioning without compose file: rc=$RC"
fi
ws_new; tenants ta:active tb:active
rm -f "$WS/deploy/tenants/ta.yml"
run_deploy
if [ "$RC" -ne 0 ] && ! called 'tenant migrate ta' && ! called 'tenant migrate tb'; then
  pass "an active tenant with no compose file fails the deploy before any tenant"
else
  die "active without compose file: rc=$RC"
fi

# ---- 8. Hostile list: an id that is not a tenant id ---------------------
ws_new; tenants ta:active
printf '{"ok":true,"tenants":[{"id":"ta","status":"active","mode":null,"hostname":"ta.example.test"},{"id":"x; rm -rf /","status":"active","mode":null,"hostname":"h"}]}\n' > "$S/list.json"
run_deploy
if [ "$RC" -ne 0 ] && ! called 'tenant migrate ta'; then
  pass "an invalid tenant id in the list fails the deploy before any migration"
else
  die "invalid id accepted: rc=$RC"
fi
ws_new; tenants ta:active
printf 'not json\n' > "$S/list.json"
run_deploy
if [ "$RC" -ne 0 ] && ! called 'tenant migrate ta'; then pass "an unreadable tenant list fails the deploy"; else die "bad list json accepted: rc=$RC"; fi

# ---- 9. Preflight: the compose set must parse ---------------------------
ws_new; tenants ta:active
touch "$S/config_fail"
run_deploy
if [ "$RC" -ne 0 ] && ! called '| build' && ! called 'tenant migrate-control'; then
  pass "an unparsable compose set changes nothing"
else
  die "config failure: rc=$RC"
fi

# ---- 10. A single-tenant brain still runs on the host -------------------
ws_new; tenants ta:active
touch "$S/single_running"
run_deploy
if [ "$RC" -ne 0 ] && ! called '| build' && ! called 'tenant migrate-control' && grep -q 'deploy-memrain-1' "$WS/out.log"; then
  pass "a running single-tenant brain stops the hosting deploy before anything changes"
else
  die "single-tenant brain next to tenants: rc=$RC"
fi
