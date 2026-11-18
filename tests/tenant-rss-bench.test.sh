#!/usr/bin/env bash
# tests/tenant-rss-bench.test.sh — the summary of scripts/tenant-rss-bench.sh:
# docker stats memory strings to MiB, p95 per container, the suggested
# per-tenant memory limit and how many tenants fit a 4 GiB host. The bench
# itself needs docker and minutes; only its arithmetic is tested here.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

# shellcheck source=scripts/tenant-rss-bench.sh
BENCH_LIB_ONLY=1 . "$REPO_ROOT/scripts/tenant-rss-bench.sh"

echo "== tenant-rss-bench.sh summary =="

before=$FAIL
for pair in "512MiB:512" "1.5GiB:1536" "2048KiB:2" "0B:0" "300.4MiB:300"; do
  got="$(to_mib "${pair%%:*}")"
  [ "$got" = "${pair#*:}" ] || die "to_mib ${pair%%:*} = $got, want ${pair#*:}"
done
[ "$FAIL" -eq "$before" ] && pass "docker stats sizes convert to whole MiB"

# 20 samples for t1 (100..290 step 10) and a flat t2 at 200.
samples="$(for i in $(seq 0 19); do printf 't1\t%s\nt2\t200\n' $((100 + i * 10)); done)"
summary="$(printf '%s\n' "$samples" | bench_summary 4096 768)"
if printf '%s\n' "$summary" | grep -qx 't1 samples=20 p50=190 p95=280 max=290'; then pass "p50/p95/max per container (nearest rank)"; else die "t1 line wrong:"; printf '%s\n' "$summary" | sed 's/^/      /'; fi
if printf '%s\n' "$summary" | grep -qx 't2 samples=20 p50=200 p95=200 max=200'; then pass "a flat series"; else die "t2 line wrong"; fi
# limit = p95 of the worst container (280) * 1.5 = 420, rounded up to 64 -> 448
if printf '%s\n' "$summary" | grep -qx 'MEMRAIN_TENANT_MEM_LIMIT=448m'; then pass "limit is 1.5 x the worst p95, rounded up to 64 MiB"; else die "limit wrong"; printf '%s\n' "$summary" | sed 's/^/      /'; fi
# (4096 - 768) / 448 = 7
if printf '%s\n' "$summary" | grep -qx 'tenants_per_host=7 (host 4096 MiB, reserved 768 MiB)'; then pass "tenants per host from the limit"; else die "tenants per host wrong"; fi
if [ -z "$(printf '' | bench_summary 4096 768 2>/dev/null)" ]; then pass "no samples, no summary"; else die "summary from no samples"; fi

echo
echo "tenant-rss-bench.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
