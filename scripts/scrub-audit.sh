#!/usr/bin/env bash
# scripts/scrub-audit.sh — broader pre-publication audit.
#
# Superset of `scripts/audit.sh`. Where `audit.sh` is a strict pattern
# gate (one regex set, exit 0/1), `scrub-audit.sh` produces a
# **categorized report** across a wider pattern set and only fails the
# build on HIGH-severity hits.
#
# Pattern file: scripts/lib/scrub-patterns.txt
# Allowlist:    scripts/lib/scrub-allowlist.txt
#
# Usage:
#   scripts/scrub-audit.sh                 # scan current repo
#   AUDIT_REPO=/path/to/repo scripts/scrub-audit.sh
#
# Exit codes: 0 = clean, 1 = HIGH-severity hits, 2 = misconfiguration.
set -euo pipefail

REPO_ROOT="${AUDIT_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || echo "")}"
if [ -z "$REPO_ROOT" ] || [ ! -e "$REPO_ROOT/.git" ]; then
  echo "[scrub-audit] ERROR: not inside a git repository (set AUDIT_REPO)" >&2
  exit 2
fi
cd "$REPO_ROOT"

PATTERNS_FILE="${SCRUB_PATTERNS:-scripts/lib/scrub-patterns.txt}"
LOCAL_PATTERNS_FILE="${SCRUB_PATTERNS_LOCAL:-scripts/lib/scrub-patterns.local.txt}"
ALLOWLIST_FILE="${SCRUB_ALLOWLIST:-scripts/lib/scrub-allowlist.txt}"

if [ ! -f "$PATTERNS_FILE" ]; then
  echo "[scrub-audit] ERROR: patterns file not found: $PATTERNS_FILE" >&2
  exit 2
fi

EFFECTIVE_PATTERNS_FILE="$PATTERNS_FILE"
if [ -f "$LOCAL_PATTERNS_FILE" ]; then
  EFFECTIVE_PATTERNS_FILE="$(mktemp)"
  trap '[ -n "${EFFECTIVE_PATTERNS_FILE:-}" ] && [ "$EFFECTIVE_PATTERNS_FILE" != "$PATTERNS_FILE" ] && rm -f "$EFFECTIVE_PATTERNS_FILE"' EXIT
  cat "$PATTERNS_FILE" "$LOCAL_PATTERNS_FILE" > "$EFFECTIVE_PATTERNS_FILE"
fi

# ---------------------------------------------------------------------------
# Step 1 — run the existing pii audit; bail if it fails.
# ---------------------------------------------------------------------------
echo "==> pii audit (scripts/audit.sh)"
if ! "$REPO_ROOT/scripts/audit.sh"; then
  echo "[scrub-audit] FAIL: existing pii audit failed; fix those first" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 2 — load allowlist globs.
# ---------------------------------------------------------------------------
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
  local f="$1" pat
  for pat in "${ALLOWLIST[@]}"; do
    # Plain equality first.
    [ "$f" = "$pat" ] && return 0
    # Shell-glob match (intentional: $pat may contain * or ?).
    # shellcheck disable=SC2254
    case "$f" in
      $pat) return 0 ;;
    esac
  done
  case "$f" in
    tests/fixtures/repo-with-pii/*) return 0 ;;
  esac
  return 1
}

# ---------------------------------------------------------------------------
# Step 3 — collect tracked files (git ls-files honours .gitignore).
# ---------------------------------------------------------------------------
declare -a SCAN_FILES=()
while IFS= read -r f; do
  is_allowlisted "$f" && continue
  [ -f "$f" ] || continue
  # Skip binary blobs.
  case "$f" in
    *.wasm|*.png|*.jpg|*.jpeg|*.gif|*.pdf|*.zip|*.tar|*.tar.gz|*.tgz) continue ;;
  esac
  SCAN_FILES+=("$f")
done < <(git ls-files)

if [ "${#SCAN_FILES[@]}" -eq 0 ]; then
  echo "[scrub-audit] no scannable tracked files (allowlist consumed everything?)" >&2
  exit 0
fi

echo
echo "==> scrub patterns (scripts/lib/scrub-patterns.txt)"
echo "    scanning ${#SCAN_FILES[@]} tracked file(s)"
echo

# ---------------------------------------------------------------------------
# Step 4 — run each pattern, group by category, report.
# ---------------------------------------------------------------------------
declare -A CATEGORY_HIGH_COUNT=()
declare -A CATEGORY_LOW_COUNT=()
total_high=0
total_low=0

while IFS='|' read -r pattern severity category description; do
  # Skip comment / blank lines.
  trimmed="${pattern#"${pattern%%[![:space:]]*}"}"
  case "$trimmed" in ''|'#'*) continue ;; esac

  pattern="${pattern%%#*}"
  pattern="${pattern#"${pattern%%[![:space:]]*}"}"
  pattern="${pattern%"${pattern##*[![:space:]]}"}"
  [ -z "$pattern" ] && continue

  matches="$(grep -EInH "$pattern" "${SCAN_FILES[@]}" 2>/dev/null || true)"
  [ -z "$matches" ] && continue

  count=$(printf '%s\n' "$matches" | wc -l | tr -d ' ')
  case "$severity" in
    HIGH)
      total_high=$((total_high + count))
      CATEGORY_HIGH_COUNT["$category"]=$(( ${CATEGORY_HIGH_COUNT["$category"]:-0} + count ))
      ;;
    LOW|INFO)
      total_low=$((total_low + count))
      CATEGORY_LOW_COUNT["$category"]=$(( ${CATEGORY_LOW_COUNT["$category"]:-0} + count ))
      ;;
  esac

  printf '\n[%s] (%s) %s\n' "$severity" "$category" "${description:-}"
  printf '  pattern: %s\n' "$pattern"
  printf '%s\n' "$matches" | sed 's/^/    /'
done < "$EFFECTIVE_PATTERNS_FILE"

# ---------------------------------------------------------------------------
# Step 5 — sanity stats.
# ---------------------------------------------------------------------------
echo
echo "==> repo sanity"
total_lines=$(git ls-files | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}')
echo "    tracked LOC total: $total_lines"
echo "    file count by extension:"
git ls-files | awk -F. 'NF>1 { print "      ." $NF }' | sort | uniq -c | sort -rn | head -10

# ---------------------------------------------------------------------------
# Step 6 — summary + exit.
# ---------------------------------------------------------------------------
echo
echo "==> summary"
printf '    HIGH hits: %d\n' "$total_high"
for cat in "${!CATEGORY_HIGH_COUNT[@]}"; do
  printf '      %-18s %d\n' "$cat" "${CATEGORY_HIGH_COUNT[$cat]}"
done
printf '    LOW hits:  %d\n' "$total_low"
for cat in "${!CATEGORY_LOW_COUNT[@]}"; do
  printf '      %-18s %d\n' "$cat" "${CATEGORY_LOW_COUNT[$cat]}"
done

if [ "$total_high" -gt 0 ]; then
  echo
  echo "[scrub-audit] FAIL: $total_high HIGH-severity hit(s)"
  exit 1
fi

echo
echo "[scrub-audit] OK: ${#SCAN_FILES[@]} file(s) scanned, no HIGH-severity hits (LOW: $total_low)"
exit 0
