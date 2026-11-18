#!/usr/bin/env bash
# tests/tenant-smoke-all.test.sh — deploy/tenant/smoke-all.sh runs the
# isolation smoke for every tenant that has a running container, keeps going
# after a failure (so one bad tenant does not leave the others unverified),
# and exits non-zero when any of them failed.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPROOT="$(mktemp -d -t smoke-all.XXXXXX)"
PASS=0
FAIL=0
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "tenant-smoke-all.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT
die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

WS="$TMPROOT/ws"; S="$WS/stub"
mkdir -p "$WS/deploy/tenant" "$WS/deploy/tenants" "$WS/scripts" "$S/bin"
cp "$REPO_ROOT/deploy/tenant/"* "$WS/deploy/tenant/"
for id in alpha beta gamma idle; do printf 'services: {}\n' > "$WS/deploy/tenants/$id.yml"; done
cat > "$S/bin/docker" <<'STUB'
#!/usr/bin/env bash
# inspect memrain-<id> --format ...: running unless the id is idle
[ "$1" = inspect ] || exit 0
case "$2" in memrain-idle) echo false ;; *) echo true ;; esac
STUB
cat > "$WS/scripts/tenant-isolation-smoke.sh" <<'SMOKE'
#!/usr/bin/env bash
printf 'smoke %s\n' "$*" >> "$STUB_DIR/calls.log"
[ "$1" != beta ]
SMOKE
chmod +x "$S/bin/docker"

echo "== smoke-all.sh =="
RC=0
(cd "$WS" && env -i PATH="$S/bin:$PATH" STUB_DIR="$S" bash deploy/tenant/smoke-all.sh) > "$WS/out.log" 2>&1 || RC=$?
if [ "$(cat "$S/calls.log" 2>/dev/null)" = "$(printf 'smoke alpha\nsmoke beta\nsmoke gamma')" ]; then
  pass "smokes every running tenant, in order, and carries on past a failure"
else
  die "smoke calls: $(tr '\n' ' ' < "$S/calls.log" 2>/dev/null)"
fi
if [ "$RC" -ne 0 ] && grep -q 'beta' "$WS/out.log" && grep -q 'idle' "$WS/out.log"; then
  pass "exits non-zero, names the failed tenant and the one without a running container"
else
  die "rc=$RC or summary incomplete"; sed 's/^/      /' "$WS/out.log"
fi
