#!/usr/bin/env bash
# tests/test-sharded.test.sh — unit tests for
# deploy/memrain/scripts/test-sharded.sh.
#
# `bun` is stubbed on PATH so no real test suite runs: the stub records the
# files it was handed, which is what the shard maths has to get right.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARD_SH="$REPO_ROOT/deploy/memrain/scripts/test-sharded.sh"

PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t sharded-test.XXXXXX)"
# The last command of an EXIT trap does NOT become the script's exit status,
# so the old `[ "$FAIL" -eq 0 ]` here reported success no matter how many
# cases failed — and `make test` is a ship gate, in CI as well. Exit
# explicitly, and preserve a non-zero status from an early crash.
trap 'rc=$?; rm -rf "$TMPROOT"; echo; echo "test-sharded.test.sh: PASS=$PASS FAIL=$FAIL"; if [ "$FAIL" -ne 0 ]; then exit 1; fi; exit "$rc"' EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

# A fake `bun` that appends one line per `bun test` invocation: the file count
# it was given, then the file names. `BUN_EXIT` forces every shard to fail;
# `BUN_FAIL_FILE` fails only the shard holding that file; `BUN_SLEEP` makes each
# shard take that long. The template build (`bun scripts/build-test-template.ts
# <dir>`) creates the directory and logs it to `$TEMPLATE_CALLS`; each shard
# logs the template it was handed to `$TEMPLATE_SEEN`, and a `--changed=` flag
# to `$CHANGED_SEEN`.
make_stub_bun() {
  local dir="$1"
  mkdir -p "$dir/bin"
  cat > "$dir/bin/bun" <<'EOF'
#!/usr/bin/env bash
if [ "$1" != "test" ]; then
  mkdir -p "$2"
  echo "$2" >> "$TEMPLATE_CALLS"
  exit 0
fi
# args: test --timeout <ms> [--changed=<ref>] <file>...
shift 3
case "${1:-}" in --changed=*) echo "$1" >> "$CHANGED_SEEN"; shift ;; esac
echo "$# $*" >> "$BUN_CALLS"
echo "${MEMRAIN_TEST_PGLITE_TEMPLATE:-unset}" >> "$TEMPLATE_SEEN"
if [ -n "${BUN_SLEEP:-}" ]; then sleep "$BUN_SLEEP"; fi
case " $* " in
  *" ${BUN_FAIL_FILE:-/none/} "*) exit 1 ;;
esac
exit "${BUN_EXIT:-0}"
EOF
  chmod +x "$dir/bin/bun"
}

# A disposable tests dir holding N empty *.test.ts files.
make_test_dir() {
  local dir="$1" n="$2"
  mkdir -p "$dir"
  for ((i = 0; i < n; i++)); do
    printf 'x' > "$dir/$(printf 't%03d' "$i").test.ts"
  done
}

# Run the script under the SAME interpreter running this test, so
# `bash tests/test-sharded.test.sh` with macOS's bash 3.2 actually exercises
# the script on 3.2 rather than on whatever bash sits first in PATH.
run_shards() {
  local sandbox="$1"; shift
  PATH="$sandbox/bin:$PATH" TMPDIR="$sandbox" BUN_CALLS="$sandbox/calls" \
    TEMPLATE_CALLS="$sandbox/template-calls" TEMPLATE_SEEN="$sandbox/template-seen" \
    CHANGED_SEEN="$sandbox/changed-seen" \
    "$@" "${BASH:-bash}" "$SHARD_SH"
}

# --- T1: files are split into shards of SHARD_SIZE, remainder in the last ---
T1="$TMPROOT/t1"
make_stub_bun "$T1"
make_test_dir "$T1/tests" 7
: > "$T1/calls"
out=$(run_shards "$T1" env JOBS=1 SHARD_SIZE=3 TEST_DIR="$T1/tests" 2>&1)
rc=$?
counts=$(cut -d' ' -f1 "$T1/calls" | tr '\n' ',')
if [ "$rc" -eq 0 ] && [ "$counts" = "3,3,1," ]; then
  pass "T1 7 files at SHARD_SIZE=3 → shards of 3,3,1"
else
  die "T1 expected rc=0 counts='3,3,1,' got rc=$rc counts='$counts' out='$out'"
fi

# --- T2: every discovered file is handed to exactly one shard ---
handed=$(cut -d' ' -f2- "$T1/calls" | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')
if [ "$handed" = "7" ]; then
  pass "T2 all 7 files run exactly once, none dropped"
else
  die "T2 expected 7 distinct files handed to bun, got $handed"
fi

# --- T3: a failing shard fails the run, and later shards still run ---
T3="$TMPROOT/t3"
make_stub_bun "$T3"
make_test_dir "$T3/tests" 4
: > "$T3/calls"
run_shards "$T3" env JOBS=1 SHARD_SIZE=2 TEST_DIR="$T3/tests" BUN_EXIT=1 >/dev/null 2>&1
rc=$?
shards=$(wc -l < "$T3/calls" | tr -d ' ')
if [ "$rc" -eq 1 ] && [ "$shards" = "2" ]; then
  pass "T3 failing shard → exit 1, remaining shards still run"
else
  die "T3 expected rc=1 with 2 shards, got rc=$rc shards=$shards"
fi

# --- T4: an empty test dir is an error, not a silent green ---
T4="$TMPROOT/t4"
make_stub_bun "$T4"
mkdir -p "$T4/tests"
: > "$T4/calls"
out=$(run_shards "$T4" env TEST_DIR="$T4/tests" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && [ ! -s "$T4/calls" ]; then
  pass "T4 no test files → exit 2, bun never invoked"
else
  die "T4 expected rc=2 and no bun calls, got rc=$rc out='$out'"
fi

# --- T5: MAX_SECONDS budget stops the loop instead of running every shard ---
# MAX_SECONDS=-1 can never be reached (the guard requires > 0), so the budget
# must NOT fire; a budget of 0 likewise means unlimited.
T5="$TMPROOT/t5"
make_stub_bun "$T5"
make_test_dir "$T5/tests" 6
: > "$T5/calls"
run_shards "$T5" env SHARD_SIZE=2 TEST_DIR="$T5/tests" MAX_SECONDS=0 >/dev/null 2>&1
shards=$(wc -l < "$T5/calls" | tr -d ' ')
if [ "$shards" = "3" ]; then
  pass "T5 MAX_SECONDS=0 means unlimited — every shard runs"
else
  die "T5 expected 3 shards with MAX_SECONDS=0, got $shards"
fi

# --- T6: JOBS>1 runs every shard concurrently, each file exactly once ---
T6="$TMPROOT/t6"
make_stub_bun "$T6"
make_test_dir "$T6/tests" 7
: > "$T6/calls"
out=$(run_shards "$T6" env JOBS=3 SHARD_SIZE=2 TEST_DIR="$T6/tests" 2>&1)
rc=$?
shards=$(wc -l < "$T6/calls" | tr -d ' ')
handed=$(cut -d' ' -f2- "$T6/calls" | tr ' ' '\n' | sort | uniq | wc -l | tr -d ' ')
dups=$(cut -d' ' -f2- "$T6/calls" | tr ' ' '\n' | sort | uniq -d | wc -l | tr -d ' ')
headers=$(printf '%s\n' "$out" | grep -cE '^(==> |::group::)bun test shard')
if [ "$rc" -eq 0 ] && [ "$shards" = "4" ] && [ "$handed" = "7" ] && [ "$dups" = "0" ] && [ "$headers" = "4" ]; then
  pass "T6 JOBS=3 → 4 shards, 7 files once each, one header per shard"
else
  die "T6 expected rc=0, 4 shards, 7 files, 0 dups, 4 headers; got rc=$rc shards=$shards handed=$handed dups=$dups headers=$headers"
fi

# --- T7: under JOBS>1 one failing shard fails the run and is named ---
T7="$TMPROOT/t7"
make_stub_bun "$T7"
make_test_dir "$T7/tests" 6
: > "$T7/calls"
out=$(run_shards "$T7" env JOBS=3 SHARD_SIZE=2 TEST_DIR="$T7/tests" BUN_FAIL_FILE="$T7/tests/t003.test.ts" 2>&1)
rc=$?
shards=$(wc -l < "$T7/calls" | tr -d ' ')
if [ "$rc" -eq 1 ] && [ "$shards" = "3" ] && printf '%s\n' "$out" | grep -q '^failed shards: 1$'; then
  pass "T7 one failing shard of three → exit 1, 'failed shards: 1', the others still ran"
else
  die "T7 expected rc=1, 3 shards, 'failed shards: 1'; got rc=$rc shards=$shards out='$out'"
fi

# --- T8: SHARD_GROUPS deals files longest-first by TIMINGS ---
# t000 weighs as much as the other five together, so it gets a worker alone.
T8="$TMPROOT/t8"
make_stub_bun "$T8"
make_test_dir "$T8/tests" 6
printf '# comment\n%s\t10\n' "$T8/tests/t000.test.ts" > "$T8/timings"
for i in 1 2 3 4 5; do printf '%s\t1\n' "$T8/tests/t00$i.test.ts" >> "$T8/timings"; done
: > "$T8/calls"
run_shards "$T8" env JOBS=1 SHARD_SIZE=20 TEST_DIR="$T8/tests" TIMINGS="$T8/timings" SHARD_GROUPS=2 SHARD_GROUP=0 >/dev/null 2>&1
g0=$(cut -d' ' -f2- "$T8/calls" | tr ' ' '\n' | xargs -n1 basename | tr '\n' ',')
: > "$T8/calls"
run_shards "$T8" env JOBS=1 SHARD_SIZE=20 TEST_DIR="$T8/tests" TIMINGS="$T8/timings" SHARD_GROUPS=2 SHARD_GROUP=1 >/dev/null 2>&1
g1=$(cut -d' ' -f2- "$T8/calls" | tr ' ' '\n' | xargs -n1 basename | tr '\n' ',')
if [ "$g0" = "t000.test.ts," ] && [ "$g1" = "t001.test.ts,t002.test.ts,t003.test.ts,t004.test.ts,t005.test.ts," ]; then
  pass "T8 heaviest file alone on group 0, the rest on group 1"
else
  die "T8 expected g0='t000.test.ts,' g1=t001..t005; got g0='$g0' g1='$g1'"
fi

# --- T9: a file missing from TIMINGS weighs the median, not zero ---
# Three listed files at 3s; two unlisted. At the median they alternate with
# the listed ones (group 0 gets t000,t002,t004); at zero both would pile onto
# group 1.
T9="$TMPROOT/t9"
make_stub_bun "$T9"
make_test_dir "$T9/tests" 5
: > "$T9/timings"
for i in 0 1 2; do printf '%s\t3\n' "$T9/tests/t00$i.test.ts" >> "$T9/timings"; done
: > "$T9/calls"
run_shards "$T9" env JOBS=1 SHARD_SIZE=20 TEST_DIR="$T9/tests" TIMINGS="$T9/timings" SHARD_GROUPS=2 SHARD_GROUP=0 >/dev/null 2>&1
g0=$(cut -d' ' -f2- "$T9/calls" | tr ' ' '\n' | xargs -n1 basename | tr '\n' ',')
if [ "$g0" = "t000.test.ts,t002.test.ts,t004.test.ts," ]; then
  pass "T9 unlisted files count as the median"
else
  die "T9 expected g0='t000.test.ts,t002.test.ts,t004.test.ts,'; got '$g0'"
fi

# --- T10: the template is built once and handed to every shard ---
T10="$TMPROOT/t10"
make_stub_bun "$T10"
make_test_dir "$T10/tests" 4
: > "$T10/calls"; : > "$T10/template-calls"; : > "$T10/template-seen"
run_shards "$T10" env JOBS=2 SHARD_SIZE=2 TEST_DIR="$T10/tests" >/dev/null 2>&1
rc=$?
built=$(wc -l < "$T10/template-calls" | tr -d ' ')
tpl=$(head -1 "$T10/template-calls")
seen=$(sort -u "$T10/template-seen")
case "$tpl" in "$T10"/memrain-pglite-tpl-*) under_tmp=yes ;; *) under_tmp=no ;; esac
if [ "$rc" -eq 0 ] && [ "$built" = "1" ] && [ "$under_tmp" = "yes" ] && [ "$seen" = "$tpl" ]; then
  pass "T10 template built once under TMPDIR and exported to both shards"
else
  die "T10 expected one build under TMPDIR seen by every shard; got rc=$rc built=$built tpl='$tpl' seen='$seen'"
fi

# --- T11: TEST_TEMPLATE=0 builds nothing and clears an inherited template ---
T11="$TMPROOT/t11"
make_stub_bun "$T11"
make_test_dir "$T11/tests" 2
: > "$T11/calls"; : > "$T11/template-calls"; : > "$T11/template-seen"
run_shards "$T11" env JOBS=1 TEST_DIR="$T11/tests" TEST_TEMPLATE=0 MEMRAIN_TEST_PGLITE_TEMPLATE=/stale >/dev/null 2>&1
rc=$?
seen=$(sort -u "$T11/template-seen")
if [ "$rc" -eq 0 ] && [ ! -s "$T11/template-calls" ] && [ "$seen" = "unset" ]; then
  pass "T11 TEST_TEMPLATE=0 → no build, shards see no template"
else
  die "T11 expected no build and 'unset'; got rc=$rc builds='$(cat "$T11/template-calls")' seen='$seen'"
fi

# --- T12: a spent MAX_SECONDS budget skips the shards not yet started ---
# The budget is read in whole seconds (`date +%s`), so with a 1s budget a start
# that crosses a second boundary already reads 1 and skips the first shard too.
# A 2s budget leaves that start a full second.
T12="$TMPROOT/t12"
make_stub_bun "$T12"
make_test_dir "$T12/tests" 3
: > "$T12/calls"
out=$(run_shards "$T12" env JOBS=1 SHARD_SIZE=1 TEST_DIR="$T12/tests" MAX_SECONDS=2 BUN_SLEEP=2.2 2>&1)
rc=$?
shards=$(wc -l < "$T12/calls" | tr -d ' ')
skipped=$(printf '%s\n' "$out" | grep -c 'wall-clock budget 2s reached')
if [ "$rc" -eq 0 ] && [ "$shards" = "1" ] && [ "$skipped" = "2" ]; then
  pass "T12 MAX_SECONDS=2 → first shard runs, the other two are skipped with a warning"
else
  die "T12 expected rc=0, 1 shard run, 2 skipped; got rc=$rc shards=$shards skipped=$skipped"
fi

# --- T13: CHANGED reaches every shard as bun's --changed filter ---
T13="$TMPROOT/t13"
make_stub_bun "$T13"
make_test_dir "$T13/tests" 4
: > "$T13/calls"; : > "$T13/changed-seen"
run_shards "$T13" env JOBS=2 SHARD_SIZE=2 TEST_DIR="$T13/tests" CHANGED=origin/main >/dev/null 2>&1
rc=$?
seen=$(sort "$T13/changed-seen" | tr '\n' ',')
handed=$(cut -d' ' -f2- "$T13/calls" | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')
if [ "$rc" -eq 0 ] && [ "$seen" = "--changed=origin/main,--changed=origin/main," ] && [ "$handed" = "4" ]; then
  pass "T13 CHANGED=origin/main → both shards filter with --changed=origin/main"
else
  die "T13 expected two --changed=origin/main and 4 files; got rc=$rc seen='$seen' handed=$handed"
fi
