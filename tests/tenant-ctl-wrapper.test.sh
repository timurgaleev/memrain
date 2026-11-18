#!/usr/bin/env bash
# tests/tenant-ctl-wrapper.test.sh — deploy/tenant/ctl.sh runs one
# control-plane command in tenant-ctl with the whole hosting file set, as the
# deploy does; with --build it first builds the image stamped like a deploy,
# which is how a fresh stack gets its CLI before any tenant runs.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPROOT="$(mktemp -d -t tenant-ctl.XXXXXX)"
PASS=0
FAIL=0
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "tenant-ctl-wrapper.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT
die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

WS="$TMPROOT/ws"; S="$TMPROOT/stub"
mkdir -p "$WS/deploy/tenant" "$WS/deploy/tenants" "$S/bin"
cp "$REPO_ROOT/deploy/tenant/"* "$WS/deploy/tenant/"
printf 'services: {}\n' > "$WS/deploy/tenants/acme.yml"
cat > "$S/bin/docker" <<'STUB'
#!/usr/bin/env bash
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
    printf 'compose%s | version=%s | %s\n' "$files" "${MEMRAIN_VERSION:-}" "$*" >> "$S/calls.log" ;;
  ps) ;;
  *) printf 'docker %s\n' "$*" >> "$S/calls.log" ;;
esac
exit 0
STUB
cat > "$S/bin/git" <<'STUB'
#!/usr/bin/env bash
case "$*" in *describe*) echo v1.23.0-2-gabcdef0 ;; *) exit 1 ;; esac
STUB
chmod +x "$S/bin/docker" "$S/bin/git"

echo "== ctl.sh =="
RC=0
(cd "$WS" && env -i PATH="$S/bin:$PATH" STUB_DIR="$S" bash deploy/tenant/ctl.sh --build tenant migrate-control) > "$TMPROOT/out.log" 2>&1 || RC=$?
EXPECTED="compose compose.hosting.yml acme.yml | version=v1.23.0-2-gabcdef0 | build tenant-ctl
compose compose.hosting.yml acme.yml | version=v1.23.0-2-gabcdef0 | run --rm --no-deps -T tenant-ctl tenant migrate-control"
if [ "$RC" -eq 0 ] && [ "$(cat "$S/calls.log" 2>/dev/null)" = "$EXPECTED" ]; then
  pass "--build: builds the image stamped like a deploy, then runs the command with the whole file set"
else
  die "rc=$RC calls: $(cat "$S/calls.log" "$TMPROOT/out.log" 2>/dev/null)"
fi

rm -f "$S/calls.log"; RC=0
(cd "$WS" && env -i PATH="$S/bin:$PATH" STUB_DIR="$S" MEMRAIN_VERSION=v1.22.0 bash deploy/tenant/ctl.sh tenant list --json) > "$TMPROOT/out.log" 2>&1 || RC=$?
if [ "$RC" -eq 0 ] && [ "$(cat "$S/calls.log" 2>/dev/null)" = "compose compose.hosting.yml acme.yml | version=v1.22.0 | run --rm --no-deps -T tenant-ctl tenant list --json" ]; then
  pass "without --build: no build, the given version"
else
  die "rc=$RC calls: $(cat "$S/calls.log" "$TMPROOT/out.log" 2>/dev/null)"
fi
