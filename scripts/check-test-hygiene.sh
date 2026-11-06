#!/usr/bin/env bash
# scripts/check-test-hygiene.sh — CI guard over deploy/memrain/tests/**/*.test.ts.
#
# 1. `process.exitCode = prev…;` restores a saved exit code that was usually
#    `undefined`. Bun ignores an `undefined` assignment, so a 1 set by the code
#    under test leaks out and fails the whole run. Use restoreExitCode() from
#    tests/helpers/exit-code.ts (or `?? 0`).
# 2. `new URL(import.meta.url).pathname` keeps percent-escapes, so the path breaks
#    under a directory with a space in it. Use `import.meta.dir`.
#
# TEST_HYGIENE_ROOT overrides the repo root (used by tests/check-test-hygiene.test.sh).
# Exit codes: 0 = clean, 1 = a hit (file:line printed), 2 = misconfig.
set -euo pipefail

ROOT="${TEST_HYGIENE_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || echo "")}"
if [ -z "$ROOT" ]; then
  echo "[test-hygiene] ERROR: not inside a git repository" >&2
  exit 2
fi
cd "$ROOT"

TEST_DIR="deploy/memrain/tests"
if [ ! -d "$TEST_DIR" ]; then
  echo "[test-hygiene] ERROR: tests dir not found: $TEST_DIR" >&2
  exit 2
fi

violations=0
# check REGEX FIX -> print each hit as file:line and count it.
check() {
  local hits
  hits="$(grep -rnE --include='*.test.ts' "$1" "$TEST_DIR" || true)"
  [ -z "$hits" ] && return 0
  while IFS= read -r hit; do
    echo "[test-hygiene] FAIL: ${hit%%:*}:$(echo "$hit" | cut -d: -f2) — $2" >&2
    violations=$((violations + 1))
  done <<< "$hits"
}

check 'process\.exitCode = (orig|prev)[A-Za-z]*;' 'restore with restoreExitCode(prev) (tests/helpers/exit-code.ts)'
check 'new URL\(import\.meta\.url\)\.pathname' 'use import.meta.dir'

if [ "$violations" -gt 0 ]; then
  echo "[test-hygiene] $violations hit(s)." >&2
  exit 1
fi

echo "[test-hygiene] OK: test files restore exitCode and resolve paths safely"
exit 0
