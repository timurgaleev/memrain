#!/usr/bin/env bash
# tests/check-test-hygiene.test.sh — scripts/check-test-hygiene.sh fails on a
# test file that restores process.exitCode without `?? 0` or derives its path
# from `new URL(import.meta.url).pathname`, names the file, and passes a clean one.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/check-test-hygiene.sh"
PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t test-hygiene-test.XXXXXX)"
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "check-test-hygiene.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

OUT="$TMPROOT/out.log"
# fixture NAME BODY -> a root holding one test file deploy/memrain/tests/NAME.
fixture() {
  local root="$TMPROOT/$1"
  mkdir -p "$root/deploy/memrain/tests/sub"
  printf '%s\n' "$2" > "$root/deploy/memrain/tests/sub/$1.test.ts"
  echo "$root"
}
run() { TEST_HYGIENE_ROOT="$1" bash "$SCRIPT" > "$OUT" 2>&1; }

echo "== check-test-hygiene.sh =="

root="$(fixture exit_restore '  process.exitCode = prevExit;')"
ec=0; run "$root" || ec=$?
if [ "$ec" -eq 1 ] && grep -q 'sub/exit_restore.test.ts:1' "$OUT"; then
  pass "bare exitCode restore → exit 1, file:line named"
else
  die "bare exitCode restore (exit $ec)"; cat "$OUT"
fi

root="$(fixture url_path 'const d = dirname(new URL(import.meta.url).pathname);')"
ec=0; run "$root" || ec=$?
if [ "$ec" -eq 1 ] && grep -q 'sub/url_path.test.ts:1' "$OUT"; then
  pass "import.meta.url pathname → exit 1, file:line named"
else
  die "import.meta.url pathname (exit $ec)"; cat "$OUT"
fi

for assignment in 'process.exitCode = savedStatus;' 'process.exitCode= saved_status_2 ;' 'process.exitCode = $saved;' 'process.exitCode = undefined;'; do
  root="$(fixture arbitrary_restore "$assignment")"
  ec=0; run "$root" || ec=$?
  if [ "$ec" -eq 1 ] && grep -q 'sub/arbitrary_restore.test.ts:1' "$OUT"; then
    pass "arbitrary bare identifier restore refused"
  else
    die "arbitrary restore (exit $ec): $assignment"; cat "$OUT"
  fi
done

root="$(fixture clean "$(printf '%s\n' '  restoreExitCode(prevExit);' '  process.exitCode = savedStatus ?? 0;' 'process.exitCode = 0;' 'process.exitCode = 1;' 'const d = import.meta.dir;')")"
ec=0; run "$root" || ec=$?
if [ "$ec" -eq 0 ]; then pass "clean file → exit 0"; else die "clean file (exit $ec)"; cat "$OUT"; fi
