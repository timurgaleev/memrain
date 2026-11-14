#!/usr/bin/env bash
# tests/fetch-secrets-overrides.test.sh — the optional *_SECRET_NAME
# keys: an override replaces the new-then-old lookup exactly, a bad value is
# refused before any AWS call, and the bearer rotation and mcp-refresh use
# the same id fetch-secrets reads.
set -uo pipefail

# shellcheck source=/dev/null
. "$(cd "$(dirname "$0")" && pwd)/lib/secrets-stub.sh"

PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t fetch-secrets-ovr-test.XXXXXX)"
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "fetch-secrets-overrides.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

N=0
ws_new() {
  N=$((N + 1))
  WS="$TMPROOT/ws$N"
  new_secrets_workspace "$WS"
  printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
  APP="$WS/deploy/.secrets/memrain.env"
  TUN="$WS/deploy/.secrets/cloudflared.env"
  export STUB_DIR="$WS/stub"
  # Default-resolution secrets exist too, so a fallback would be visible.
  stub_secret stack/memrain-postgres-url "postgres://u:p@db/default"
  stub_secret stack/memrain-public-bearer "bearer-default"
  stub_secret stack/memrain-internal-token "internal-default"
  stub_secret stack/cloudflared-tunnel-token "tunnel-default"
}

seed_previous() {
  mkdir -p "$WS/deploy/.secrets"
  printf 'MEMRAIN_POSTGRES_URL=postgres://previous\n' > "$APP"
  printf 'TUNNEL_TOKEN=previous-tunnel\n' > "$TUN"
  chmod 0600 "$APP" "$TUN"
  cp "$APP" "$WS/app.before"
  cp "$TUN" "$WS/tun.before"
}

# calls_for LEAF_PATTERN -> the logged secret ids whose name matches
calls_for() { awk '{print $2}' "$WS/stub/calls.log" | grep -E "$1" | sort -u; }

echo "== *_SECRET_NAME overrides =="

# T1. Each key alone: exactly that id is used, no new/old fallback.
check_override() {
  local key="$1" id="$2" value="$3" pattern="$4" line="$5" file="$6"
  ws_new
  file="${!file}"
  stub_secret "$id" "$value"
  printf '%s=%s\n' "$key" "$id" >> "$WS/.env"
  if run_fetch "$WS" && grep -qx "$line" "$file" \
     && [ "$(calls_for "$pattern")" = "$id" ] \
     && grep -q "(override $key)" "$WS/out.log" \
     && ! grep -qF "$value" "$WS/out.log"; then
    pass "T1 $key: exactly $id, printed as an override, value not printed"
  else
    die "T1 $key"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
  fi
}
check_override POSTGRES_URL_SECRET_NAME legacy/memex-postgres-url "postgres://u:p@db/ovr" 'postgres-url' 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/ovr' APP
check_override PUBLIC_BEARER_SECRET_NAME legacy/memex-public-bearer "bearer-ovr" 'public-bearer' 'MEMRAIN_PUBLIC_BEARER=bearer-ovr' APP
check_override INTERNAL_TOKEN_SECRET_NAME legacy/memex-internal-token "internal-ovr" 'internal-token' 'MEMRAIN_INTERNAL_TOKEN=internal-ovr' APP
check_override TUNNEL_TOKEN_SECRET_NAME legacy/cloudflared-tunnel-token "tunnel-ovr" 'tunnel-token' 'TUNNEL_TOKEN=tunnel-ovr' TUN
check_override CONNECTOR_KEK_SECRET_NAME ops/brain-kek "kek-ovr" 'kek' 'MEMRAIN_CONNECTOR_KEK=kek-ovr' APP
check_override NOTIFY_WEBHOOK_SECRET_NAME ops/brain-webhook "webhook-ovr" 'webhook' 'MEMRAIN_NOTIFY_WEBHOOK_SECRET=webhook-ovr' APP

# T2. Unset or empty keys: the default new-then-old resolution.
ws_new
printf 'POSTGRES_URL_SECRET_NAME=\nPUBLIC_BEARER_SECRET_NAME=\n' >> "$WS/.env"
if run_fetch "$WS" && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/default' "$APP" \
   && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-default' "$APP" \
   && ! grep -q '(override' "$WS/out.log"; then
  pass "T2 empty override keys: default resolution"
else
  die "T2 empty override keys"; cat "$WS/out.log"
fi

# T3. A missing override secret follows the default rules, with no fallback.
ws_new
printf 'POSTGRES_URL_SECRET_NAME=legacy/absent-url\n' >> "$WS/.env"
if run_fetch "$WS" && ! grep -q POSTGRES_URL "$APP" \
   && [ "$(calls_for 'postgres-url|absent-url')" = "legacy/absent-url" ]; then
  pass "T3a missing URL override without REQUIRE: no URL line, no fallback"
else
  die "T3a missing URL override"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
ws_new
printf 'POSTGRES_URL_SECRET_NAME=legacy/absent-url\nMEMRAIN_REQUIRE_POSTGRES=1\n' >> "$WS/.env"
seed_previous
ec=0; run_fetch "$WS" || ec=$?
if [ "$ec" -eq 1 ] && cmp -s "$APP" "$WS/app.before" && cmp -s "$TUN" "$WS/tun.before"; then
  pass "T3b missing URL override + REQUIRE: exit 1, files unchanged"
else
  die "T3b missing URL override + REQUIRE (exit $ec)"; cat "$WS/out.log"
fi
ws_new
printf 'TUNNEL_TOKEN_SECRET_NAME=legacy/absent-tunnel\n' >> "$WS/.env"
seed_previous
if run_fetch "$WS" && cmp -s "$TUN" "$WS/tun.before" \
   && grep -q 'WARN: cloudflared tunnel token has no value yet' "$WS/out.log"; then
  pass "T3c missing tunnel override: existing file kept, warning"
else
  die "T3c missing tunnel override"; cat "$WS/out.log"
fi
ws_new
printf 'TUNNEL_TOKEN_SECRET_NAME=legacy/absent-tunnel\n' >> "$WS/.env"
if run_fetch "$WS" && [ -f "$TUN" ] && [ ! -s "$TUN" ]; then
  pass "T3d missing tunnel override, no file: empty placeholder"
else
  die "T3d missing tunnel override placeholder"; cat "$WS/out.log"
fi

# T4. AccessDenied on an override id: exit 1, files unchanged.
for key in POSTGRES_URL_SECRET_NAME PUBLIC_BEARER_SECRET_NAME INTERNAL_TOKEN_SECRET_NAME TUNNEL_TOKEN_SECRET_NAME; do
  ws_new
  stub_secret legacy/some-secret "value-ovr"
  stub_deny legacy/some-secret AccessDeniedException
  printf '%s=legacy/some-secret\n' "$key" >> "$WS/.env"
  seed_previous
  ec=0; run_fetch "$WS" || ec=$?
  if [ "$ec" -eq 1 ] && cmp -s "$APP" "$WS/app.before" && cmp -s "$TUN" "$WS/tun.before"; then
    pass "T4 AccessDenied on $key: exit 1, files unchanged"
  else
    die "T4 AccessDenied on $key (exit $ec)"; cat "$WS/out.log"
  fi
done

# T5. A bad value is refused before any AWS call.
for key in POSTGRES_URL_SECRET_NAME TUNNEL_TOKEN_SECRET_NAME; do
  # shellcheck disable=SC2016  # the literal text is the point
  for bad in 'legacy/a b' 'legacy/a;b' 'legacy/$(id)' $'legacy/a\nb' 'legacy/a`id`' "legacy/$(printf 'a%.0s' $(seq 1 600))"; do
    ws_new
    seed_previous
    ec=0; run_fetch "$WS" "$key=$bad" || ec=$?
    if [ "$ec" -eq 1 ] && [ ! -s "$WS/stub/calls.log" ] \
       && cmp -s "$APP" "$WS/app.before" && cmp -s "$TUN" "$WS/tun.before"; then
      pass "T5 $key=$(printf '%q' "${bad:0:24}"): exit 1, no AWS call"
    else
      die "T5 $key=$(printf '%q' "${bad:0:24}") (exit $ec)"; cat "$WS/out.log"
    fi
  done
done

# T6. The rotation script PUTs to the id fetch-secrets reads.
run_rotate() {
  env -i PATH="$WS/stub/bin:/usr/bin:/bin" HOME="$WS" STUB_DIR="$WS/stub" \
    REPO_DIR="$WS" "$@" bash "$WS/scripts/rotate-memrain-public-bearer.sh" > "$WS/out.log" 2>&1
}
write_docker_stub() {
  printf '#!/bin/sh\nexit 0\n' > "$WS/stub/bin/docker"
  chmod +x "$WS/stub/bin/docker"
}
ws_new; write_docker_stub
stub_secret legacy/memex-public-bearer "bearer-ovr"
printf 'PUBLIC_BEARER_SECRET_NAME=legacy/memex-public-bearer\n' >> "$WS/.env"
if run_rotate && grep -qx 'put-secret-value legacy/memex-public-bearer' "$WS/stub/calls.log" \
   && ! grep -q 'put-secret-value stack/' "$WS/stub/calls.log" \
   && ! grep -Eq '[0-9a-f]{64}' "$WS/out.log"; then
  pass "T6a rotate: PUT to PUBLIC_BEARER_SECRET_NAME, token not printed"
else
  die "T6a rotate with override"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
ws_new; write_docker_stub
if run_rotate && grep -qx 'put-secret-value stack/memrain-public-bearer' "$WS/stub/calls.log"; then
  pass "T6b rotate without override: PUT to the resolved new name"
else
  die "T6b rotate default"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
ws_new; write_docker_stub
rm -f "$WS/stub/secrets/$(stub_key stack/memrain-public-bearer)"
stub_secret stack/memex-public-bearer "bearer-old"
if run_rotate && grep -qx 'put-secret-value stack/memex-public-bearer' "$WS/stub/calls.log"; then
  pass "T6c rotate on a legacy-named install: PUT to the legacy name"
else
  die "T6c rotate legacy"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
ws_new; write_docker_stub
stub_secret stack/memex-public-bearer "bearer-default"
ec=0; run_rotate || ec=$?
if [ "$ec" -ne 0 ] && ! grep -q 'put-secret-value' "$WS/stub/calls.log" \
   && grep -q 'stack/memex-public-bearer also holds the bearer' "$WS/out.log" \
   && ! grep -q bearer-default "$WS/out.log"; then
  pass "T6e rotate with the bearer under both names: refused before the PUT"
else
  die "T6e rotate both names (exit $ec)"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
ws_new; write_docker_stub
ec=0; run_rotate 'PUBLIC_BEARER_SECRET_NAME=legacy/a b' || ec=$?
if [ "$ec" -ne 0 ] && [ ! -s "$WS/stub/calls.log" ]; then
  pass "T6d rotate with a bad override: fails before any AWS call"
else
  die "T6d rotate bad override (exit $ec)"; cat "$WS/out.log"
fi

# T7. mcp-refresh reads the bearer from the same id.
write_claude_stub() {
  cat > "$WS/stub/bin/claude" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB_DIR/claude.log"
exit 0
STUB
  chmod +x "$WS/stub/bin/claude"
}
run_refresh() {
  env -i PATH="$WS/stub/bin:/usr/bin:/bin" HOME="$WS" STUB_DIR="$WS/stub" \
    AWS_REGION=eu-west-1 "$@" bash "$WS/scripts/mcp-refresh.sh" > "$WS/out.log" 2>&1
}
ws_new; write_claude_stub
stub_secret legacy/memex-public-bearer "bearer-ovr"
if run_refresh MEMEX_MCP_URL=https://brain.example.test/mcp PUBLIC_BEARER_SECRET_NAME=legacy/memex-public-bearer \
   && grep -qx 'get-secret-value legacy/memex-public-bearer' "$WS/stub/calls.log" \
   && ! grep -q 'get-secret-value memex/' "$WS/stub/calls.log" \
   && grep -q 'https://brain.example.test/mcp' "$WS/stub/claude.log" \
   && ! grep -q 'bearer-ovr' "$WS/out.log"; then
  pass "T7a mcp-refresh: reads PUBLIC_BEARER_SECRET_NAME, legacy URL name works"
else
  die "T7a mcp-refresh with override"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
ws_new; write_claude_stub
stub_secret memex/memex-public-bearer "bearer-old"
if run_refresh MEMRAIN_MCP_URL=https://brain.example.test/mcp \
   && grep -qx 'get-secret-value memex/memex-public-bearer' "$WS/stub/calls.log" \
   && [ "$(grep '^describe' "$WS/stub/calls.log" | head -n 2)" = $'describe-secret memex/memrain-public-bearer\ndescribe-secret memex/memex-public-bearer' ]; then
  pass "T7b mcp-refresh default: new then old name under the default prefix"
else
  die "T7b mcp-refresh default"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
ws_new; write_claude_stub
stub_secret custom/memrain-public-bearer "bearer-new"
if run_refresh MEMRAIN_MCP_URL=https://brain.example.test/mcp MEMEX_SECRETS_PREFIX=custom \
   && grep -qx 'get-secret-value custom/memrain-public-bearer' "$WS/stub/calls.log"; then
  pass "T7c mcp-refresh: legacy MEMEX_SECRETS_PREFIX honoured"
else
  die "T7c mcp-refresh prefix fallback"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
# T7d. The default name is memrain; a legacy `memex` registration is only
# reported, never removed. An explicitly named server gets no notice.
ws_new; write_claude_stub
stub_secret memex/memrain-public-bearer "bearer-new"
if run_refresh MEMRAIN_MCP_URL=https://brain.example.test/mcp \
   && grep -q '^mcp add .* memrain https://brain.example.test/mcp' "$WS/stub/claude.log" \
   && grep -q '^mcp remove memrain ' "$WS/stub/claude.log" \
   && ! grep -q '^mcp remove memex' "$WS/stub/claude.log" \
   && grep -q "named 'memex' is still registered" "$WS/out.log"; then
  pass "T7d mcp-refresh: default name memrain, legacy registration kept and reported"
else
  die "T7d mcp-refresh default name"; cat "$WS/stub/claude.log"; cat "$WS/out.log"
fi
ws_new; write_claude_stub
stub_secret memex/memrain-public-bearer "bearer-new"
if run_refresh MEMRAIN_MCP_URL=https://brain.example.test/mcp MEMEX_MCP_NAME=memex \
   && grep -q '^mcp add .* memex https://brain.example.test/mcp' "$WS/stub/claude.log" \
   && ! grep -q '^mcp get' "$WS/stub/claude.log" \
   && ! grep -q 'still registered' "$WS/out.log"; then
  pass "T7e mcp-refresh: legacy MEMEX_MCP_NAME honoured, no notice"
else
  die "T7e mcp-refresh explicit name"; cat "$WS/stub/claude.log"; cat "$WS/out.log"
fi

# T8. .env.example documents every override key lib.sh knows, commented out,
# so a key added there cannot go undocumented.
ALL_KEYS="$(sed -n 's/^SECRET_NAME_OVERRIDE_KEYS="\(.*\)"$/\1/p' "$REPO_ROOT/deploy/secrets/lib.sh")"
[ -n "$ALL_KEYS" ] || die "T8 cannot read SECRET_NAME_OVERRIDE_KEYS from lib.sh"
for key in $ALL_KEYS; do
  if grep -Eq "^# ${key}=" "$REPO_ROOT/.env.example" && ! grep -Eq "^${key}=" "$REPO_ROOT/.env.example"; then
    pass "T8 .env.example lists $key commented"
  else
    die "T8 .env.example $key"
  fi
done
