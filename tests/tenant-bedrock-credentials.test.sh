#!/usr/bin/env bash
# shellcheck disable=SC2016  # jq filters are single-quoted on purpose
# tests/tenant-bedrock-credentials.test.sh — deploy/tenant/bedrock-credentials.sh
# rewrites each tenant's Bedrock credential file before it expires, from the
# host, and its systemd timer.
#   - a missing or soon-expiring file is rewritten from `aws sts assume-role`
#     (one session per tenant, a Bedrock-only session policy), atomically,
#     in the tenant's own directory; a fresh one is left alone;
#   - a failed assume-role keeps the old file, names the tenant and exits
#     non-zero after trying every tenant;
#   - without a role configured it changes nothing;
#   - the timer fires often enough for the refresh margin.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPROOT="$(mktemp -d -t bedrock-creds.XXXXXX)"
PASS=0
FAIL=0
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "tenant-bedrock-credentials.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT
die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

command -v jq >/dev/null 2>&1 || { echo "  (jq not available — skipping)"; exit 0; }

WS="$TMPROOT/ws"; S="$WS/stub"
mkdir -p "$WS/deploy/tenant" "$WS/deploy/tenants" "$S/bin"
cp "$REPO_ROOT/deploy/tenant/"* "$WS/deploy/tenant/"
for id in alpha beta; do printf 'services: {}\n' > "$WS/deploy/tenants/$id.yml"; done
printf 'AWS_REGION=eu-west-1\nMEMRAIN_TENANT_BEDROCK_ROLE_ARN=arn:aws:iam::000000000000:role/tenant-bedrock\n' > "$WS/.env"
cat > "$S/bin/aws" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_DIR/calls.log"
session=""; prev=""
for a in "$@"; do [ "$prev" = "--role-session-name" ] && session="$a"; prev="$a"; done
case "$session" in *"${FAIL_FOR:-none}"*) echo "AccessDenied" >&2; exit 254 ;; esac
exp="$(date -u -d '+60 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+60M +%Y-%m-%dT%H:%M:%SZ)"
printf '{"Credentials":{"AccessKeyId":"AKIA%s","SecretAccessKey":"s","SessionToken":"t","Expiration":"%s"}}\n' "$session" "$exp"
STUB
chmod +x "$S/bin/aws"

run() { RC=0; (cd "$WS" && env -i PATH="$S/bin:$PATH" STUB_DIR="$S" ${FAIL_FOR:+FAIL_FOR="$FAIL_FOR"} bash deploy/tenant/bedrock-credentials.sh) > "$WS/out.log" 2>&1 || RC=$?; }
file() { echo "$WS/deploy/.bedrock/$1/credentials.json"; }
iso_in() { date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v"$2" +%Y-%m-%dT%H:%M:%SZ; }

echo "== bedrock-credentials.sh =="
run
if [ "$RC" -eq 0 ] && [ "$(jq -r .AccessKeyId "$(file alpha)")" = "AKIAmemrain-tenant-alpha" ] \
   && [ "$(jq -r .AccessKeyId "$(file beta)")" = "AKIAmemrain-tenant-beta" ]; then
  pass "writes each tenant's file from its own assume-role session"
else
  die "first run rc=$RC"; sed 's/^/      /' "$WS/out.log"
fi
if [ "$(jq -r .Version "$(file alpha)")" = 1 ] && [ "$(jq -r .Expiration "$(file alpha)")" != null ]; then pass "the file carries Version and Expiration"; else die "file shape wrong"; fi
mode="$(stat -c %a "$(file alpha)" 2>/dev/null || stat -f %Lp "$(file alpha)")"
if [ "$mode" = 440 ]; then pass "the file is 0440"; else die "file mode $mode"; fi
if grep -q -- '--policy' "$S/calls.log" && grep -q 'bedrock:InvokeModel' "$S/calls.log" && ! grep -q '"\*"' "$S/calls.log"; then
  pass "the session policy allows Bedrock invocation only"
else
  die "session policy missing or broad"
fi
if ls "$WS/deploy/.bedrock/alpha" | grep -qv '^credentials.json$'; then die "a temporary file was left behind"; else pass "no temporary file left"; fi

: > "$S/calls.log"
run
if [ "$RC" -eq 0 ] && [ ! -s "$S/calls.log" ]; then pass "a file far from expiry is left alone"; else die "fresh files rewritten (rc=$RC)"; fi

jq --arg e "$(iso_in '+5 minutes' '+5M')" '.Expiration = $e' "$(file alpha)" > "$TMPROOT/near" && chmod 600 "$(file alpha)" && cp "$TMPROOT/near" "$(file alpha)"
run
if [ "$RC" -eq 0 ] && grep -q 'memrain-tenant-alpha' "$S/calls.log" && ! grep -q 'memrain-tenant-beta' "$S/calls.log"; then
  pass "a file close to expiry is rewritten, the fresh one is not"
else
  die "near-expiry rotation (rc=$RC)"
fi

: > "$S/calls.log"
rm -f "$(file alpha)" "$(file beta)"
mkdir -p "$WS/deploy/.bedrock/beta"; printf '{"AccessKeyId":"AKIAOLD","Expiration":"2000-01-01T00:00:00Z"}\n' > "$(file beta)"
FAIL_FOR=beta run
if [ "$RC" -ne 0 ] && grep -q 'beta' "$WS/out.log" && [ "$(jq -r .AccessKeyId "$(file beta)")" = AKIAOLD ] && [ -f "$(file alpha)" ]; then
  pass "a failed assume-role keeps the old file, names the tenant and still refreshes the others"
else
  die "failure handling (rc=$RC)"; sed 's/^/      /' "$WS/out.log"
fi

: > "$S/calls.log"
printf 'AWS_REGION=eu-west-1\n' > "$WS/.env"
rm -rf "$WS/deploy/.bedrock"
run
if [ "$RC" -eq 0 ] && [ ! -s "$S/calls.log" ] && [ ! -e "$WS/deploy/.bedrock/alpha/credentials.json" ]; then
  pass "without MEMRAIN_TENANT_BEDROCK_ROLE_ARN nothing changes"
else
  die "no-role run (rc=$RC)"
fi

echo "== systemd units =="
SVC="$REPO_ROOT/deploy/tenant/memrain-tenant-bedrock-credentials.service"
TMR="$REPO_ROOT/deploy/tenant/memrain-tenant-bedrock-credentials.timer"
if grep -q '^ExecStart=/usr/bin/bash /opt/memrain/deploy/tenant/bedrock-credentials.sh$' "$SVC" && grep -q '^WorkingDirectory=/opt/memrain$' "$SVC"; then
  pass "the service runs the repo's script from the checkout"
else
  die "service ExecStart/WorkingDirectory wrong"
fi
if grep -Eq '^OnUnitActiveSec=(5min|300)$' "$TMR" && grep -q '^OnBootSec=' "$TMR" && grep -q '^Unit=memrain-tenant-bedrock-credentials.service$' "$TMR"; then
  pass "the timer fires every five minutes and after boot"
else
  die "timer schedule wrong"
fi
