#!/usr/bin/env bash
# tests/test-pg-summary.test.sh — unit tests for assert_no_skips in
# scripts/test-pg.sh: a Postgres run that skips a test must fail.
#
# The script is sourced with TEST_PG_SOURCE_ONLY=1 inside a subshell per case,
# so no container starts and its traps stay out of this harness.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_PG_SH="$REPO_ROOT/scripts/test-pg.sh"

PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t test-pg-summary.XXXXXX)"
trap 'rc=$?; rm -rf "$TMPROOT"; echo; echo "test-pg-summary.test.sh: PASS=$PASS FAIL=$FAIL"; if [ "$FAIL" -ne 0 ]; then exit 1; fi; exit "$rc"' EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

# Runs assert_no_skips on a fixture holding $1 (printf format); prints its
# combined output and returns its exit status.
check() {
  local fixture="$TMPROOT/out.$RANDOM"
  # shellcheck disable=SC2059 # the fixture text is the format on purpose
  printf "$1" > "$fixture"
  # shellcheck source=scripts/test-pg.sh
  (TEST_PG_SOURCE_ONLY=1 source "$TEST_PG_SH" && assert_no_skips "$fixture") 2>&1
}

echo "assert_no_skips"

out="$(check ' 12 pass\n 1 skip\n 0 fail\nRan 13 tests across 2 files.\n')"
rc=$?
if [ "$rc" -eq 1 ] && [[ "$out" == *"1 test(s) skipped"* ]]; then
  pass "a skip line with a non-zero count fails the run"
else
  die "expected exit 1 with '1 test(s) skipped', got rc=$rc: $out"
fi

out="$(check ' 12 pass\n 0 skip\n 0 fail\n')"
rc=$?
if [ "$rc" -eq 0 ]; then pass "' 0 skip' passes"; else die "' 0 skip' failed (rc=$rc): $out"; fi

out="$(check ' 12 pass\n 0 fail\nRan 12 tests across 2 files.\n')"
rc=$?
if [ "$rc" -eq 0 ]; then pass "no skip line passes"; else die "no skip line failed (rc=$rc): $out"; fi

out="$(check ' 12 pass\n\033[0m\033[33m 1 skip\033[0m\n 0 fail\n')"
rc=$?
if [ "$rc" -eq 1 ]; then pass "a colored skip line fails the run"; else die "colored skip passed (rc=$rc): $out"; fi

out="$(check ' 12 pass\n 2 todo\n 0 fail\n')"
rc=$?
if [ "$rc" -eq 1 ]; then pass "a todo line fails the run"; else die "todo passed (rc=$rc): $out"; fi

echo "read_direct_only (pooler mode)"

# Runs read_direct_only on a list holding $1 (printf format) against the found
# files a.test.ts .. l.test.ts; prints its output and the routed files.
direct() {
  local list="$TMPROOT/direct.$RANDOM" found=() f
  # shellcheck disable=SC2059 # the fixture text is the format on purpose
  printf "$1" > "$list"
  for f in a b c d e f g h i j k l; do found+=("tests/$f.test.ts"); done
  # shellcheck source=scripts/test-pg.sh
  (TEST_PG_SOURCE_ONLY=1 source "$TEST_PG_SH" && DIRECT_ONLY="$list" && read_direct_only "${found[@]}" \
    && echo "routed ${DIRECT_FILES[*]} session=${DIRECT_SESSION}") 2>&1
}

out="$(direct '# comment\n\na.test.ts session holds a session SET\nb.test.ts session takes an advisory lock across statements\n')"
rc=$?
if [ "$rc" -eq 0 ] && [[ "$out" == *"routed tests/a.test.ts tests/b.test.ts session=2"* ]]; then pass "routes listed files, counted per category"; else die "valid list (rc=$rc): $out"; fi

out="$(direct 'a.test.ts session\n')"
rc=$?
if [ "$rc" -eq 1 ] && [[ "$out" == *"no reason"* ]]; then pass "an entry without a reason fails"; else die "missing reason (rc=$rc): $out"; fi

out="$(direct 'a.test.ts sometimes it is flaky\n')"
rc=$?
if [ "$rc" -eq 1 ] && [[ "$out" == *"category"* ]]; then pass "an unknown category fails"; else die "unknown category (rc=$rc): $out"; fi

out="$(direct 'zz.test.ts session reason\n')"
rc=$?
if [ "$rc" -eq 1 ] && [[ "$out" == *"not a Postgres test file"* ]]; then pass "an entry naming no found file fails"; else die "unknown file (rc=$rc): $out"; fi

eleven=""
for f in a b c d e f g h i j k; do eleven+="$f.test.ts session needs its own session\n"; done
out="$(direct "$eleven")"
rc=$?
if [ "$rc" -eq 1 ] && [[ "$out" == *"not pooler-compatible"* ]]; then pass "more than 10 session entries fail"; else die "11 session entries (rc=$rc): $out"; fi

