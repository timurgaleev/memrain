#!/usr/bin/env bash
# scripts/audit.sh — PII gate for the public migration.
#
# Reads patterns from scripts/lib/pii-patterns.txt, greps every git-tracked
# file (so .gitignored content is automatically skipped), and exits 1 with
# file:line:matched_text on any hit. LICENSE, the patterns/allowlist files,
# and tests/fixtures/repo-with-pii/** are exempt.
#
# Usage:
#   scripts/audit.sh                  # scan tracked files in current repo
#   PII_PATTERNS=other.txt scripts/audit.sh
#   AUDIT_REPO=/path/to/other/repo scripts/audit.sh
#
# Exit codes: 0 = clean, 1 = matches found, 2 = misconfiguration (missing
# patterns file, not a git repo, etc.).
set -euo pipefail

REPO_ROOT="${AUDIT_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || echo "")}"
if [ -z "$REPO_ROOT" ] || [ ! -e "$REPO_ROOT/.git" ]; then
  echo "[audit] ERROR: not inside a git repository (set AUDIT_REPO to override)" >&2
  exit 2
fi
cd "$REPO_ROOT"

PATTERNS_FILE="${PII_PATTERNS:-scripts/lib/pii-patterns.txt}"
LOCAL_PATTERNS_FILE="${PII_PATTERNS_LOCAL:-scripts/lib/pii-patterns.local.txt}"
ALLOWLIST_FILE="${PII_ALLOWLIST:-scripts/lib/pii-allowlist.txt}"

if [ ! -f "$PATTERNS_FILE" ]; then
  echo "[audit] ERROR: patterns file not found: $PATTERNS_FILE" >&2
  exit 2
fi

# If a local (gitignored) patterns file exists, concatenate it onto the
# pattern set for this run. Operators use it to add exact matches for
# their personal identifiers without committing them.
EFFECTIVE_PATTERNS_FILE="$PATTERNS_FILE"
if [ -f "$LOCAL_PATTERNS_FILE" ]; then
  EFFECTIVE_PATTERNS_FILE="$(mktemp)"
  trap '[ -n "${EFFECTIVE_PATTERNS_FILE:-}" ] && [ "$EFFECTIVE_PATTERNS_FILE" != "$PATTERNS_FILE" ] && rm -f "$EFFECTIVE_PATTERNS_FILE"' EXIT
  cat "$PATTERNS_FILE" "$LOCAL_PATTERNS_FILE" > "$EFFECTIVE_PATTERNS_FILE"
fi

# Build allowlist (one path per line, comments stripped).
declare -a ALLOWLIST=()
if [ -f "$ALLOWLIST_FILE" ]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -n "$line" ] && ALLOWLIST+=("$line")
  done < "$ALLOWLIST_FILE"
fi

is_allowlisted() {
  local f="$1" allow
  for allow in "${ALLOWLIST[@]}"; do
    [ "$f" = "$allow" ] && return 0
  done
  case "$f" in
    tests/fixtures/repo-with-pii/*) return 0 ;;
  esac
  return 1
}

# Tracked files only — git already excludes .gitignored content. Skip
# binary blobs.
declare -a SCAN_FILES=()
while IFS= read -r f; do
  is_allowlisted "$f" && continue
  [ -f "$f" ] || continue
  case "$f" in
    *.wasm|*.png|*.jpg|*.jpeg|*.gif|*.pdf|*.zip|*.tar|*.tar.gz|*.tgz|*.ico) continue ;;
  esac
  SCAN_FILES+=("$f")
done < <(git ls-files)

if [ "${#SCAN_FILES[@]}" -eq 0 ]; then
  echo "[audit] no scannable tracked files (allowlist consumed everything?)" >&2
  exit 0
fi

# Run grep for each pattern. Aggregate matches; never abort early on a
# pattern that has no hits (`grep` exits 1 in that case).
total_matches=0
total_patterns_with_hits=0
while IFS='|' read -r pattern severity description; do
  pattern="${pattern%%#*}"
  pattern="${pattern#"${pattern%%[![:space:]]*}"}"
  pattern="${pattern%"${pattern##*[![:space:]]}"}"
  [ -z "$pattern" ] && continue

  matches=$(grep -EnH "$pattern" "${SCAN_FILES[@]}" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    count=$(printf '%s\n' "$matches" | wc -l | tr -d ' ')
    total_matches=$((total_matches + count))
    total_patterns_with_hits=$((total_patterns_with_hits + 1))
    printf '\n[audit] %s match(es) for pattern: %s\n' "$count" "$pattern"
    printf '        severity: %s — %s\n' "${severity:-UNKNOWN}" "${description:-}"
    printf '%s\n' "$matches" | sed 's/^/  /'
  fi
done < "$EFFECTIVE_PATTERNS_FILE"

if [ "$total_matches" -gt 0 ]; then
  echo
  echo "[audit] FAIL: $total_matches match(es) across $total_patterns_with_hits pattern(s)"
  exit 1
fi

echo "[audit] OK: ${#SCAN_FILES[@]} tracked file(s) scanned, no PII matches"
exit 0
