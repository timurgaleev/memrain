#!/usr/bin/env bash
# tests/tenant-purge-host.test.sh — deploy/tenant/purge-deleted.sh runs
# `tenant purge-deleted` in tenant-ctl and then removes, for every tenant the
# control plane purged, what the host still holds of it: the container, its
# rendered file, its secrets file, its Bedrock credentials, its provisioned
# secrets and its network. Nothing of a tenant that was not purged is
# touched, including one whose id merely starts with a purged one.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPROOT="$(mktemp -d -t purge-host.XXXXXX)"
PASS=0
FAIL=0
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "tenant-purge-host.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT
die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

command -v jq >/dev/null 2>&1 || { echo "  (jq not available — skipping)"; exit 0; }

WS="$TMPROOT/ws"; S="$WS/stub"
mkdir -p "$WS/deploy/tenant" "$WS/deploy/tenants" "$WS/deploy/.secrets/tenants" "$WS/deploy/.secrets/provisioned" "$S/bin"
cp "$REPO_ROOT/deploy/tenant/"* "$WS/deploy/tenant/"
cat > "$S/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_DIR/calls.log"
case "$*" in
  *"tenant-ctl tenant purge-deleted"*) cat "$STUB_DIR/purge.json" ;;
esac
exit 0
STUB
chmod +x "$S/bin/docker"

seed() {
  rm -f "$S/calls.log"
  for id in "$@"; do
    printf 'services: {}\n' > "$WS/deploy/tenants/$id.yml"
    : > "$WS/deploy/tenants/$id.yml.bak"
    : > "$WS/deploy/.secrets/tenants/$id.env"
    mkdir -p "$WS/deploy/.bedrock/$id" "$WS/deploy/.secrets/provisioned/$id"
    : > "$WS/deploy/.bedrock/$id/credentials.json"
    : > "$WS/deploy/.secrets/provisioned/$id.invite"
  done
}
run() { RC=0; (cd "$WS" && env -i PATH="$S/bin:$PATH" STUB_DIR="$S" MEMRAIN_VERSION=v9.9.9 bash deploy/tenant/purge-deleted.sh "$@") > "$WS/out.log" 2>&1 || RC=$?; }
left() { find "$WS/deploy" -path "$WS/deploy/tenant" -prune -o -name "*$1*" -print | grep -v "/$1x" ; }

echo "== purge-deleted.sh =="
seed acme acmex beta
printf '{"ok":true,"purged":["acme"],"skipped":[{"id":"beta","why":"no longer due"}],"removedExports":{"acme":[]},"finished":["acme"]}\n' > "$S/purge.json"
run
if [ "$RC" -eq 0 ] && [ -z "$(left acme)" ]; then pass "nothing with the purged id is left on the host"; else die "left: $(left acme | tr '\n' ' ') rc=$RC"; sed 's/^/      /' "$WS/out.log"; fi
if [ -f "$WS/deploy/tenants/acmex.yml" ] && [ -f "$WS/deploy/.secrets/tenants/acmex.env" ] && [ -d "$WS/deploy/.bedrock/acmex" ] \
   && [ -f "$WS/deploy/tenants/beta.yml" ] && [ -f "$WS/deploy/.secrets/tenants/beta.env" ]; then
  pass "a tenant whose id only starts with the purged one, and a skipped one, keep everything"
else
  die "another tenant's files were removed"
fi
if grep -q '^rm -f memrain-acme$' "$S/calls.log" && grep -q '^network rm memrain_tenant_acme$' "$S/calls.log" \
   && ! grep -q 'memrain-beta\|memrain_tenant_beta' "$S/calls.log"; then
  pass "removes the purged tenant's container and network only"
else
  die "docker calls: $(tr '\n' ';' < "$S/calls.log")"
fi
if grep -q -- '--secrets aws' "$S/calls.log" || ! grep -q 'tenant purge-deleted' "$S/calls.log"; then die "purge call wrong"; else pass "runs purge-deleted in tenant-ctl"; fi
if grep -q 'acme' "$WS/out.log"; then pass "reports what it purged"; else die "no report"; fi

seed acme
printf '{"ok":true,"purged":["../x"],"skipped":[],"removedExports":{},"finished":[]}\n' > "$S/purge.json"
run
if [ "$RC" -ne 0 ] && [ -f "$WS/deploy/tenants/acme.yml" ]; then pass "an invalid id from control is refused and nothing is removed"; else die "invalid id accepted (rc=$RC)"; fi

# A run that stopped after control purged the tenant: the next one, with
# nothing new to purge, still clears what the host holds of it.
seed acme
printf '{"ok":true,"purged":[],"skipped":[],"removedExports":{},"finished":["acme"]}\n' > "$S/purge.json"
run
if [ "$RC" -eq 0 ] && [ -z "$(left acme)" ] && grep -q '^rm -f memrain-acme$' "$S/calls.log"; then
  pass "a rerun clears a tenant purged earlier whose host files were left"
else
  die "rerun left: $(left acme | tr '\n' ' ') rc=$RC"; sed 's/^/      /' "$WS/out.log"
fi

printf 'not json\n' > "$S/purge.json"
run
if [ "$RC" -ne 0 ]; then pass "an unreadable answer from control fails"; else die "bad answer accepted"; fi
