#!/usr/bin/env bash
# tests/tenant-hosting-ctl.test.sh — hosting_ctl (deploy/tenant/lib.sh) runs
# the control-plane CLI from the image the tenants run. deploy-tenants.sh sets
# MEMRAIN_VERSION itself; a smoke run by hand or after a reboot takes it from a
# running tenant container, and with none running it refuses rather than let
# compose build an image (or run a stale `:dev` one) on a live host.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPROOT="$(mktemp -d -t hosting-ctl.XXXXXX)"
PASS=0
FAIL=0
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "tenant-hosting-ctl.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT
die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

S="$TMPROOT/stub"
mkdir -p "$S/bin"
cat > "$S/bin/docker" <<'STUB'
#!/usr/bin/env bash
S="$STUB_DIR"
case "$1" in
  ps) printf 'ps\n' >> "$S/calls.log"; cat "$S/ps.out" 2>/dev/null ;;
  compose) printf 'compose version=%s | %s\n' "${MEMRAIN_VERSION:-}" "${*: -3}" >> "$S/calls.log" ;;
  *) printf 'docker %s\n' "$*" >> "$S/calls.log" ;;
esac
exit 0
STUB
chmod +x "$S/bin/docker"

# run_ctl [VAR=value...] -> hosting_ctl tenant list in a clean environment.
run_ctl() {
  rm -f "$S/calls.log"
  # shellcheck disable=SC2016 # expanded by the inner bash
  env -i PATH="$S/bin:$PATH" STUB_DIR="$S" "$@" bash -c '. "$1"; hosting_ctl tenant list' _ "$REPO_ROOT/deploy/tenant/lib.sh" \
    > "$S/out.log" 2>&1
}

echo "== hosting_ctl version =="
printf 'memrain-hosting:v1.23.0\ncloudflare/cloudflared:2026.1.0\nmemrain-hosting:v1.23.1-4-gabc1234\n' > "$S/ps.out"
if run_ctl && grep -q '^compose version=v1.23.1-4-gabc1234 | tenant-ctl tenant list$' "$S/calls.log"; then
  pass "unset: takes the newest image a running tenant container runs"
else
  die "derived version: $(cat "$S/calls.log" "$S/out.log" 2>/dev/null | tr '\n' ' ')"
fi

if run_ctl MEMRAIN_VERSION=v2.0.0 && grep -q '^compose version=v2.0.0 ' "$S/calls.log" && ! grep -q '^ps$' "$S/calls.log"; then
  pass "set by the caller (the deploy): used as it is"
else
  die "explicit version: $(cat "$S/calls.log" 2>/dev/null | tr '\n' ' ')"
fi

: > "$S/ps.out"
RC=0; run_ctl || RC=$?
if [ "$RC" -ne 0 ] && ! grep -q '^compose' "$S/calls.log" && grep -q 'MEMRAIN_VERSION' "$S/out.log"; then
  pass "unset and no tenant running: refuses, runs nothing, and says what to set"
else
  die "rc=$RC calls: $(cat "$S/calls.log" 2>/dev/null | tr '\n' ' ') out: $(cat "$S/out.log")"
fi
