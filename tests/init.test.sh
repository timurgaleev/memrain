#!/usr/bin/env bash
# tests/init.test.sh — unit tests for scripts/init.sh.
#
# Each test creates a disposable directory with a minimal terraform/
# subdir, runs init.sh in non-interactive mode by piping answers, and
# asserts that the expected files were written with valid content.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INIT_SH="$REPO_ROOT/scripts/init.sh"

PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t init-test.XXXXXX)"
# The last command of an EXIT trap does NOT become the script's exit status,
# so the old `[ "$FAIL" -eq 0 ]` here reported success no matter how many
# cases failed — and `make test` is a ship gate, in CI as well. Exit
# explicitly, and preserve a non-zero status from an early crash.
# A function, not an inline trap string: shellcheck reads a trap body as its own
# scope and cannot see `rc` assigned there (SC2154), and the exit status has to
# be captured on the FIRST line or the commands below overwrite it.
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "init.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

# Standard valid answer set, one prompt per line, in the order init.sh asks:
#   AWS_ACCOUNT_ID, AWS_REGION, AWS_PROFILE, PROJECT_NAME, DOMAIN, SUBDOMAIN,
#   GITHUB_OWNER, REPO_NAME, SECRETS_PREFIX, TFSTATE_BUCKET, TFSTATE_REGION,
#   TFSTATE_KEY, ALARM_EMAIL, SSH_ALLOWED_CIDR, USE_SSH_DEPLOY_KEY
# valid_answers [TFSTATE_KEY] — empty takes the default <project>/terraform.tfstate.
valid_answers() {
  cat <<EOF
123456789012
eu-west-1
default
proj
example.com
brain
testowner
test-stack
stack
my-tfstate-bucket
eu-central-1
${1:-}


false
EOF
}

new_workspace() {
  local name="$1"
  local dir="$TMPROOT/$name"
  mkdir -p "$dir/terraform"
  echo "$dir"
}

run_init() {
  # run_init <workspace> [extra_args...]
  local ws="$1"; shift
  (
    cd "$ws" || exit
    INIT_NON_INTERACTIVE=1 INIT_REPO_ROOT="$ws" bash "$INIT_SH" "$@"
  )
}

# ---------------------------------------------------------------------------
echo "== init.sh =="

# T1. Happy path: writes all three files with expected values.
t1=$(new_workspace t1)
ec=0; output=$(valid_answers | run_init "$t1" 2>&1) || ec=$?
if [ "$ec" -eq 0 ] \
   && [ -f "$t1/.env" ] \
   && [ -f "$t1/terraform/terraform.tfvars" ] \
   && [ -f "$t1/terraform/backend.hcl" ]; then
  pass "T1 happy path → 3 files written (exit 0)"
else
  die "T1 happy path failed (exit=$ec). Output: $output"
  ls -la "$t1" "$t1/terraform" 2>/dev/null
fi

# T2. .env contains user-supplied values.
if [ -f "$t1/.env" ] \
   && grep -q '^AWS_ACCOUNT_ID=123456789012$' "$t1/.env" \
   && grep -q '^DOMAIN=example.com$' "$t1/.env" \
   && grep -q '^GITHUB_OWNER=testowner$' "$t1/.env" \
   && grep -q '^REPO_URL=https://github.com/testowner/test-stack.git$' "$t1/.env"; then
  pass "T2 .env has correct values"
else
  die "T2 .env content wrong: $(cat "$t1/.env" 2>/dev/null)"
fi

# T3. terraform.tfvars uses HCL syntax with quoted strings + bool literal.
if [ -f "$t1/terraform/terraform.tfvars" ] \
   && grep -q 'aws_region          = "eu-west-1"' "$t1/terraform/terraform.tfvars" \
   && grep -q 'use_ssh_deploy_key  = false' "$t1/terraform/terraform.tfvars"; then
  pass "T3 tfvars HCL syntax correct"
else
  die "T3 tfvars wrong: $(cat "$t1/terraform/terraform.tfvars" 2>/dev/null)"
fi

# T4. backend.hcl has bucket + region + key.
if [ -f "$t1/terraform/backend.hcl" ] \
   && grep -q 'bucket  = "my-tfstate-bucket"' "$t1/terraform/backend.hcl" \
   && grep -q 'region  = "eu-central-1"' "$t1/terraform/backend.hcl" \
   && grep -q 'key     = "proj/terraform.tfstate"' "$t1/terraform/backend.hcl"; then
  pass "T4 backend.hcl values correct"
else
  die "T4 backend.hcl wrong: $(cat "$t1/terraform/backend.hcl" 2>/dev/null)"
fi

# T5. Idempotency guard: re-running without --force aborts.
ec=0; output=$(valid_answers | run_init "$t1" 2>&1) || ec=$?
if [ "$ec" -eq 1 ] && echo "$output" | grep -q "already exist"; then
  pass "T5 second run without --force → exit 1"
else
  die "T5 expected exit 1 on second run (got exit=$ec): $output"
fi

# T6. --force overwrites existing files.
ec=0; output=$(valid_answers | run_init "$t1" --force 2>&1) || ec=$?
if [ "$ec" -eq 0 ]; then
  pass "T6 --force re-runs successfully → exit 0"
else
  die "T6 --force should succeed (got exit=$ec): $output"
fi

# T7. Atomic writes leave no .tmp files behind.
leftovers=$(find "$t1" -name "*.XXXXXX*" -o -name ".env.*" 2>/dev/null | grep -cv "^$")
if [ "$leftovers" -eq 0 ]; then
  pass "T7 no temp leftovers from atomic write"
else
  die "T7 found temp leftovers ($leftovers files)"
fi

# T8. Validation rejects bad AWS account ID (non-12-digit) — script exits 1
# in non-interactive mode rather than retry-loop.
t8=$(new_workspace t8)
ec=0; output=$( { printf '%s\n' \
  "abc" \
  "eu-west-1" "default" "proj" "example.com" "brain" \
  "testowner" "test-stack" "stack" "my-tfstate" "eu-central-1" "" \
  "" "" "false" \
  | INIT_NON_INTERACTIVE=1 INIT_REPO_ROOT="$t8" bash "$INIT_SH" 2>&1 ; } ) || ec=$?
if [ "$ec" -eq 1 ] && echo "$output" | grep -qi "12 digits"; then
  pass "T8 invalid AWS account ID → exit 1"
else
  die "T8 expected validation failure (exit=$ec): $output"
fi

# T9. Validation rejects bad domain.
t9=$(new_workspace t9)
ec=0; output=$( { printf '%s\n' \
  "123456789012" "eu-west-1" "default" "proj" "no-dot-domain" \
  "brain" "owner" "name" "stack" "buck" "eu-central-1" "" \
  "" "" "false" \
  | INIT_NON_INTERACTIVE=1 INIT_REPO_ROOT="$t9" bash "$INIT_SH" 2>&1 ; } ) || ec=$?
if [ "$ec" -eq 1 ] && echo "$output" | grep -q "domain"; then
  pass "T9 invalid domain → exit 1"
else
  die "T9 expected domain validation failure (exit=$ec): $output"
fi

# T10. Defaults applied when answer is empty (Enter).
t10=$(new_workspace t10)
ec=0; output=$( { printf '%s\n' \
  "123456789012" \
  "" "" "" \
  "example.com" \
  "" \
  "owner" "" \
  "" "buck" "" "" \
  "" "" "" "" \
  | INIT_NON_INTERACTIVE=1 INIT_REPO_ROOT="$t10" bash "$INIT_SH" 2>&1 ; } ) || ec=$?
if [ "$ec" -eq 0 ] \
   && grep -q '^AWS_REGION=eu-west-1$' "$t10/.env" \
   && grep -q '^PROJECT=memrain$' "$t10/.env" \
   && grep -q '^SUBDOMAIN=brain$' "$t10/.env" \
   && grep -q '^SECRETS_PREFIX=memrain$' "$t10/.env" \
   && grep -q '^EFS_MOUNT=/mnt/memrain-efs/memrain$' "$t10/.env" \
   && grep -q '^EFS_REPO=/mnt/memrain-efs/memrain-repo$' "$t10/.env" \
   && grep -q '^REPO_NAME=memrain$' "$t10/.env" \
   && grep -q '^USE_SSH_DEPLOY_KEY=false$' "$t10/.env" \
   && grep -q 'key     = "memrain/terraform.tfstate"' "$t10/terraform/backend.hcl"; then
  pass "T10 defaults applied for empty answers"
else
  die "T10 defaults missing (exit=$ec): $(cat "$t10/.env" 2>/dev/null)"
fi

# T11. Optional fields accept empty strings.
if [ -f "$t10/.env" ] \
   && grep -q '^ALARM_EMAIL=$' "$t10/.env" \
   && grep -q '^SSH_ALLOWED_CIDR=$' "$t10/.env"; then
  pass "T11 optional fields stay empty"
else
  die "T11 optional fields wrong: $(cat "$t10/.env" 2>/dev/null)"
fi

# T12. Missing terraform/ dir → exit 2.
t12="$TMPROOT/t12"
mkdir -p "$t12"  # no terraform/ subdir
ec=0; output=$(valid_answers | INIT_NON_INTERACTIVE=1 INIT_REPO_ROOT="$t12" bash "$INIT_SH" 2>&1) || ec=$?
if [ "$ec" -eq 2 ] && echo "$output" | grep -q "terraform/"; then
  pass "T12 missing terraform/ dir → exit 2"
else
  die "T12 expected exit 2 (got exit=$ec): $output"
fi

# T13. Project name, repo name and state key are independent answers.
t13=$(new_workspace t13)
ec=0; output=$(valid_answers legacy/terraform.tfstate | run_init "$t13" 2>&1) || ec=$?
if [ "$ec" -eq 0 ] \
   && grep -q 'project_name        = "proj"' "$t13/terraform/terraform.tfvars" \
   && grep -q 'repo_name           = "test-stack"' "$t13/terraform/terraform.tfvars" \
   && grep -q 'key     = "legacy/terraform.tfstate"' "$t13/terraform/backend.hcl" \
   && grep -q '^EFS_MOUNT=/mnt/proj-efs/proj$' "$t13/.env" \
   && grep -q '^REPO_URL=https://github.com/testowner/test-stack.git$' "$t13/.env"; then
  pass "T13 project name, repo name and state key are independent"
else
  die "T13 independence (exit=$ec): $output"
fi

# T14. --force refuses to change the key of an existing backend.hcl, and
# writes nothing at all.
t14=$(new_workspace t14)
valid_answers legacy/terraform.tfstate | run_init "$t14" >/dev/null 2>&1
for f in .env terraform/terraform.tfvars terraform/backend.hcl; do cp "$t14/$f" "$t14/$(basename "$f").before"; done
ec=0; output=$(valid_answers | run_init "$t14" --force 2>&1) || ec=$?
if [ "$ec" -eq 1 ] \
   && echo "$output" | grep -q "legacy/terraform.tfstate" \
   && echo "$output" | grep -q -- "--allow-backend-key-change" \
   && cmp -s "$t14/.env" "$t14/.env.before" \
   && cmp -s "$t14/terraform/terraform.tfvars" "$t14/terraform.tfvars.before" \
   && cmp -s "$t14/terraform/backend.hcl" "$t14/backend.hcl.before"; then
  pass "T14 --force with a different state key → exit 1, files unchanged"
else
  die "T14 key change under --force (exit=$ec): $output"
fi

# T15. --allow-backend-key-change lets the key change.
ec=0; output=$(valid_answers | run_init "$t14" --force --allow-backend-key-change 2>&1) || ec=$?
if [ "$ec" -eq 0 ] && grep -q 'key     = "proj/terraform.tfstate"' "$t14/terraform/backend.hcl"; then
  pass "T15 --allow-backend-key-change → key switched"
else
  die "T15 allowed key change (exit=$ec): $output"
fi

# T16. New names only: subdomain in tfvars, no legacy keys in .env.
if grep -q '^subdomain           = "brain"$' "$t1/terraform/terraform.tfvars" \
   && ! grep -q 'memex_subdomain' "$t1/terraform/terraform.tfvars" \
   && grep -q '^SUBDOMAIN=brain$' "$t1/.env" \
   && grep -q '^PUBLIC_HOST=brain.example.com$' "$t1/.env" \
   && grep -q '^MEMRAIN_PUBLIC_URL=https://brain.example.com$' "$t1/.env" \
   && grep -q '^MEMRAIN_PUBLIC_WRITE=0$' "$t1/.env" \
   && ! grep -q 'MEMEX_' "$t1/.env"; then
  pass "T16 subdomain + MEMRAIN_ keys, no memex_subdomain, no MEMEX_ key"
else
  die "T16 new names: $(cat "$t1/.env" "$t1/terraform/terraform.tfvars" 2>/dev/null)"
fi

# T17. No feature-tier prompt, and the .env enables no removed feature.
if ! grep -q 'Feature tier' "$t1/.env" \
   && ! grep -Eq '^MEMRAIN_(RERANK|GRAPH_RERANK|DREAM_SYNTHESIS|THINK|DEEP_SYNTH|TAKE_ENSEMBLE|FACTS_EXTRACTION|CONTEXTUAL_[A-Z_]+|RELATIONAL_LLM|DOCTOR_PER_SOURCE)=' "$t1/.env"; then
  pass "T17 no feature tier, no removed feature flag in .env"
else
  die "T17 tier leftovers: $(grep -E 'Feature tier|^MEMRAIN_' "$t1/.env" 2>/dev/null)"
fi
