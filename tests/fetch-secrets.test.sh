#!/usr/bin/env bash
# tests/fetch-secrets.test.sh — deploy/secrets/fetch-secrets.sh against a stub
# `aws` CLI: new-then-old secret names, the unset-prefix default (memex), and
# the two-phase write (a failed run leaves every existing file byte-identical).
# The app file is .secrets/memrain.env with MEMRAIN_ keys; a .secrets/memex.env
# left by a pre-rename release is never written, truncated or deleted.
set -uo pipefail

# shellcheck source=/dev/null
. "$(cd "$(dirname "$0")" && pwd)/lib/secrets-stub.sh"

PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t fetch-secrets-test.XXXXXX)"
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "fetch-secrets.test.sh: PASS=$PASS FAIL=$FAIL"
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
  APP="$WS/deploy/.secrets/memrain.env"
  TUN="$WS/deploy/.secrets/cloudflared.env"
  LEGACY="$WS/deploy/.secrets/memex.env"
  # Every workspace starts with the pre-rename release's file; the end of
  # this script checks it is byte-identical in all of them.
  mkdir -p "$WS/deploy/.secrets"
  printf 'MEMEX_POSTGRES_URL=postgres://legacy\nMEMEX_PUBLIC_BEARER=legacy-bearer\n' > "$LEGACY"
  chmod 0600 "$LEGACY"
  cp "$LEGACY" "$WS/legacy.before"
}

# Seed the four secrets under PREFIX with NAME-style leaf names.
seed_all() {
  local prefix="$1" brand="$2" tag="$3"
  stub_secret "$prefix/$brand-postgres-url" "postgres://u:p@db/$tag"
  stub_secret "$prefix/$brand-public-bearer" "bearer-$tag"
  stub_secret "$prefix/$brand-internal-token" "internal-$tag"
  stub_secret "$prefix/cloudflared-tunnel-token" "tunnel-$tag"
}

# Previous state: files a good earlier run left behind. Owner-writable by
# default: the tests run unprivileged, and a 0400 file would make any stray
# overwrite fail on EACCES and pass the byte-identical check by accident
# (on the host the script runs as root, where the mode stops nothing).
seed_previous() {
  local mode="${1:-0600}"
  mkdir -p "$WS/deploy/.secrets"
  printf 'MEMRAIN_POSTGRES_URL=postgres://previous\nMEMRAIN_PUBLIC_BEARER=previous-bearer\n' > "$APP"
  printf 'TUNNEL_TOKEN=previous-tunnel\nCLOUDFLARE_TUNNEL_TOKEN=previous-tunnel\n' > "$TUN"
  chmod "$mode" "$APP" "$TUN"
  cp "$APP" "$WS/app.before"
  cp "$TUN" "$WS/tun.before"
}

unchanged() {
  cmp -s "$APP" "$WS/app.before" && cmp -s "$TUN" "$WS/tun.before"
}

no_tmp_left() {
  [ -z "$(find "$WS/deploy/.secrets" -name '*.tmp.*' 2>/dev/null)" ]
}

no_values_in_output() {
  ! grep -Eq 'postgres://u:p@|bearer-(new|old)|internal-(new|old)|tunnel-(new|old)|kek-value|webhook-value' "$WS/out.log"
}

echo "== fetch-secrets.sh =="

# T1. new names only: every value lands in memrain.env under MEMRAIN_ keys, 0400.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memrain new
if run_fetch "$WS" \
   && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/new' "$APP" \
   && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-new' "$APP" \
   && grep -qx 'MEMRAIN_INTERNAL_TOKEN=internal-new' "$APP" \
   && grep -qx 'MEMRAIN_PUBLIC_WRITE=0' "$APP" \
   && grep -qx 'TUNNEL_TOKEN=tunnel-new' "$TUN" \
   && grep -qx 'CLOUDFLARE_TUNNEL_TOKEN=tunnel-new' "$TUN" \
   && [ "$(file_mode "$APP")" = "400" ] && [ "$(file_mode "$TUN")" = "400" ] \
   && ! grep -q '^MEMEX_' "$APP" \
   && no_tmp_left && no_values_in_output; then
  pass "T1 new names only: memrain.env with MEMRAIN_ keys only, 0400"
else
  die "T1 new names only"; cat "$WS/out.log"
fi

# T2. old names only.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memex old
if run_fetch "$WS" \
   && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/old' "$APP" \
   && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-old' "$APP" \
   && grep -qx 'MEMRAIN_INTERNAL_TOKEN=internal-old' "$APP" \
   && grep -q 'stack/memex-postgres-url' "$WS/out.log" \
   && no_values_in_output; then
  pass "T2 old names only: legacy secrets used, ids printed"
else
  die "T2 old names only"; cat "$WS/out.log"
fi

# T3. both names with equal values: fine, the new id is read.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memex same
seed_all stack memrain same
if run_fetch "$WS" \
   && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/same' "$APP" \
   && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-same' "$APP" \
   && grep -qx 'MEMRAIN_INTERNAL_TOKEN=internal-same' "$APP" \
   && grep -q 'public-bearer: stack/memrain-public-bearer' "$WS/out.log"; then
  pass "T3 both names, equal values: new id used"
else
  die "T3 both names equal"; cat "$WS/out.log"
fi

# T3b. both names, different non-empty values: exit 1, the conflicting ids
# are named, no value is printed, and the previous files stay intact.
for leaf in postgres-url public-bearer internal-token; do
  ws_new; export STUB_DIR="$WS/stub"
  printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
  seed_all stack memex old
  seed_all stack memrain old
  stub_secret "stack/memrain-$leaf" "$(cat "$WS/stub/secrets/$(stub_key "stack/memex-$leaf")")-new"
  seed_previous
  ec=0; run_fetch "$WS" || ec=$?
  if [ "$ec" -eq 1 ] && unchanged && no_tmp_left && no_values_in_output \
     && grep -q "stack/memrain-$leaf and stack/memex-$leaf both hold a value" "$WS/out.log" \
     && ! grep -q -- '-new' "$WS/out.log"; then
    pass "T3b $leaf differs under both names: exit 1, files unchanged"
  else
    die "T3b $leaf conflict (exit $ec)"; cat "$WS/out.log"
  fi
done

# T3c. the new name exists but is empty (or has no version yet): the legacy
# value is used, so a half-done rename never drops the bearer or token.
for how in empty noversion; do
  ws_new; export STUB_DIR="$WS/stub"
  printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
  seed_all stack memex old
  if [ "$how" = empty ]; then
    stub_secret stack/memrain-public-bearer ""
    stub_secret stack/memrain-internal-token ""
  else
    stub_noversion stack/memrain-public-bearer
    stub_noversion stack/memrain-internal-token
  fi
  seed_previous
  if run_fetch "$WS" \
     && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-old' "$APP" \
     && grep -qx 'MEMRAIN_INTERNAL_TOKEN=internal-old' "$APP" \
     && grep -q 'public-bearer: stack/memex-public-bearer' "$WS/out.log" \
     && no_values_in_output; then
    pass "T3c new name $how + old set: old value used"
  else
    die "T3c new name $how"; cat "$WS/out.log"
  fi
done

# T3d. the new name is missing for one secret: that one comes from the old name.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memex old
stub_secret stack/memrain-postgres-url "postgres://u:p@db/old"
if run_fetch "$WS" \
   && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-old' "$APP" \
   && grep -qx 'MEMRAIN_INTERNAL_TOKEN=internal-old' "$APP" \
   && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/old' "$APP"; then
  pass "T3d new name missing: old value used"
else
  die "T3d new name missing"; cat "$WS/out.log"
fi

# T4. unset prefix means the legacy `memex` prefix: memex/<new>, then
# memex/<old>, and no other prefix is ever asked.
ws_new; export STUB_DIR="$WS/stub"
stub_secret memex/memex-postgres-url "postgres://u:p@db/old"
expected=$'describe-secret memex/memrain-postgres-url\ndescribe-secret memex/memex-postgres-url'
if run_fetch "$WS" \
   && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/old' "$APP" \
   && [ "$(grep 'postgres-url' "$WS/stub/calls.log" | grep '^describe')" = "$expected" ] \
   && ! grep -q ' memrain/' "$WS/stub/calls.log"; then
  pass "T4 unset prefix: memex prefix, new then old name"
else
  die "T4 unset prefix order"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
# T4b. secrets under a `memrain/` prefix are never picked up without the key.
ws_new; export STUB_DIR="$WS/stub"
seed_all memex memex old
seed_all memrain memrain new
if run_fetch "$WS" && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-old' "$APP" \
   && grep -qx 'TUNNEL_TOKEN=tunnel-old' "$TUN" \
   && ! grep -q ' memrain/' "$WS/stub/calls.log"; then
  pass "T4b unset prefix: no cross-prefix probing"
else
  die "T4b unset prefix isolation"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
# T4c. an empty SECRETS_PREFIX counts as unset.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=\n' >> "$WS/.env"
seed_all memex memrain new
if run_fetch "$WS" && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-new' "$APP"; then
  pass "T4c empty prefix: memex prefix, new name first"
else
  die "T4c empty prefix"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
# T4d. AccessDenied on the new name under the default prefix is fatal: it
# never falls through to the old name, and the previous files stay intact.
ws_new; export STUB_DIR="$WS/stub"
seed_all memex memex old
seed_previous
stub_deny memex/memrain-public-bearer AccessDeniedException
ec=0; run_fetch "$WS" || ec=$?
if [ "$ec" -eq 1 ] && unchanged && no_tmp_left \
   && ! grep -q 'memex/memex-public-bearer' "$WS/stub/calls.log"; then
  pass "T4d unset prefix + AccessDenied on the new name: exit 1, no fallback"
else
  die "T4d unset prefix AccessDenied (exit $ec)"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi

# T5. R6: a non-NotFound error on each secret in turn, in each error class,
# exits 1 and leaves both files byte-identical with no temp file left, even
# though the secrets before the failing one were fetched.
for code in AccessDeniedException ExpiredTokenException ThrottlingException; do
  for leaf in memrain-postgres-url memrain-public-bearer memrain-internal-token cloudflared-tunnel-token \
              memrain-connector-kek memrain-notify-webhook; do
    for how in deny denyget; do
      ws_new; export STUB_DIR="$WS/stub"
      printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
      seed_all stack memrain new
      stub_secret stack/memrain-connector-kek "kek-value"
      stub_secret stack/memrain-notify-webhook "webhook-value"
      seed_previous
      "stub_$how" "stack/$leaf" "$code"
      ec=0; run_fetch "$WS" || ec=$?
      if [ "$ec" -eq 1 ] && unchanged && no_tmp_left && no_values_in_output; then
        pass "T5 $code ($how) on $leaf: exit 1, files byte-identical"
      else
        die "T5 $code ($how) on $leaf (exit $ec)"; cat "$WS/out.log"
      fi
    done
  done
done

# T6. REQUIRE_POSTGRES (either name) with no URL secret: exit 1, nothing written.
for var in MEMRAIN_REQUIRE_POSTGRES MEMEX_REQUIRE_POSTGRES; do
  ws_new; export STUB_DIR="$WS/stub"
  printf 'SECRETS_PREFIX=stack\n%s=1\n' "$var" >> "$WS/.env"
  stub_secret stack/memrain-public-bearer "bearer-new"
  seed_previous
  ec=0; run_fetch "$WS" || ec=$?
  if [ "$ec" -eq 1 ] && unchanged && no_tmp_left; then
    pass "T6 $var=1 + URL NotFound: exit 1, files unchanged"
  else
    die "T6 $var=1 + URL NotFound (exit $ec)"; cat "$WS/out.log"
  fi
done

# T6b. Without REQUIRE a missing URL is the PGLite dev fallback.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
stub_secret stack/memrain-public-bearer "bearer-new"
if run_fetch "$WS" && ! grep -q POSTGRES_URL "$APP" && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-new' "$APP"; then
  pass "T6b missing URL without REQUIRE: warn, no URL line"
else
  die "T6b missing URL without REQUIRE"; cat "$WS/out.log"
fi

# T7. URL secret that exists but has no current version: fatal, not missing.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memrain new
rm -f "$WS/stub/secrets/$(stub_key stack/memrain-postgres-url)"
stub_noversion stack/memrain-postgres-url
seed_previous
ec=0; run_fetch "$WS" || ec=$?
if [ "$ec" -eq 1 ] && unchanged; then
  pass "T7 URL secret without a version: exit 1, files unchanged"
else
  die "T7 URL secret without a version (exit $ec)"; cat "$WS/out.log"
fi

# T8. An existing secret with an empty value counts as missing.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memrain new
stub_secret stack/memrain-public-bearer ""
if run_fetch "$WS" && ! grep -q PUBLIC_BEARER "$APP" && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/new' "$APP"; then
  pass "T8 empty bearer value: treated as missing"
else
  die "T8 empty bearer value"; cat "$WS/out.log"
fi

# T9. Tunnel token missing: an existing non-empty cloudflared.env is kept.
for kind in notfound noversion; do
  ws_new; export STUB_DIR="$WS/stub"
  printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
  seed_all stack memrain new
  rm -f "$WS/stub/secrets/$(stub_key stack/cloudflared-tunnel-token)"
  [ "$kind" = noversion ] && stub_noversion stack/cloudflared-tunnel-token
  seed_previous
  if run_fetch "$WS" && cmp -s "$TUN" "$WS/tun.before" \
     && grep -q 'WARN: cloudflared tunnel token has no value yet' "$WS/out.log" \
     && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/new' "$APP"; then
    pass "T9 tunnel $kind + existing file: file unchanged, warning printed"
  else
    die "T9 tunnel $kind + existing file"; cat "$WS/out.log"
  fi
done

# T9b. Tunnel token missing on a fresh install: empty 0400 placeholder.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
stub_noversion stack/cloudflared-tunnel-token
if run_fetch "$WS" && [ -f "$TUN" ] && [ ! -s "$TUN" ] && [ "$(file_mode "$TUN")" = "400" ]; then
  pass "T9b tunnel missing, no file: empty 0400 placeholder"
else
  die "T9b tunnel placeholder"; cat "$WS/out.log"
fi

# T10. PUBLIC_WRITE reads the new name, then the legacy one.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\nMEMEX_PUBLIC_WRITE=1\n' >> "$WS/.env"
if run_fetch "$WS" && grep -qx 'MEMRAIN_PUBLIC_WRITE=1' "$APP"; then
  pass "T10a MEMEX_PUBLIC_WRITE=1 honoured"
else
  die "T10a legacy PUBLIC_WRITE"; cat "$WS/out.log"
fi
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\nMEMEX_PUBLIC_WRITE=1\nMEMRAIN_PUBLIC_WRITE=0\n' >> "$WS/.env"
if run_fetch "$WS" && grep -qx 'MEMRAIN_PUBLIC_WRITE=0' "$APP"; then
  pass "T10b MEMRAIN_PUBLIC_WRITE wins over MEMEX_PUBLIC_WRITE"
else
  die "T10b PUBLIC_WRITE precedence"; cat "$WS/out.log"
fi

# T11. A successful run replaces the previous files, read-only ones included.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memrain new
seed_previous 0400
if run_fetch "$WS" && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-new' "$APP" \
   && grep -qx 'TUNNEL_TOKEN=tunnel-new' "$TUN" && no_tmp_left; then
  pass "T11 success replaces the previous files"
else
  die "T11 success over previous files"; cat "$WS/out.log"
fi

# T13. The connector key and the notification webhook secret land in
# memrain.env (0400) under their MEMRAIN_ names; neither value is printed, and
# no legacy name is probed for them (they never existed under one).
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memrain new
stub_secret stack/memrain-connector-kek "kek-value"
stub_secret stack/memrain-notify-webhook "webhook-value"
if run_fetch "$WS" \
   && grep -qx 'MEMRAIN_CONNECTOR_KEK=kek-value' "$APP" \
   && grep -qx 'MEMRAIN_NOTIFY_WEBHOOK_SECRET=webhook-value' "$APP" \
   && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/new' "$APP" \
   && [ "$(file_mode "$APP")" = "400" ] \
   && ! grep -E 'connector-kek|notify-webhook' "$WS/stub/calls.log" | grep -vq 'stack/memrain-' \
   && no_tmp_left && no_values_in_output; then
  pass "T13 connector key + webhook secret written to memrain.env, values not printed"
else
  die "T13 connector key + webhook secret"; cat "$WS/out.log"
fi

# T13b. Both are optional: missing, or the empty placeholder terraform creates
# (no version yet), means no line at all and a successful run.
for how in missing noversion; do
  ws_new; export STUB_DIR="$WS/stub"
  printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
  seed_all stack memrain new
  if [ "$how" = noversion ]; then
    stub_noversion stack/memrain-connector-kek
    stub_noversion stack/memrain-notify-webhook
  fi
  if run_fetch "$WS" \
     && ! grep -q 'CONNECTOR_KEK\|NOTIFY_WEBHOOK' "$APP" \
     && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-new' "$APP" \
     && grep -q 'connector key not provisioned' "$WS/out.log" \
     && grep -q 'notification webhook secret not provisioned' "$WS/out.log"; then
    pass "T13b connector key + webhook secret $how: skipped, exit 0"
  else
    die "T13b connector key + webhook secret $how"; cat "$WS/out.log"
  fi
done

# T12. The pre-rename .secrets/memex.env is byte-identical (content and mode)
# in every workspace above, after runs that succeeded and runs that failed.
bad=""
for i in $(seq 1 "$N"); do
  w="$TMPROOT/ws$i"
  if ! cmp -s "$w/deploy/.secrets/memex.env" "$w/legacy.before" \
     || [ "$(file_mode "$w/deploy/.secrets/memex.env")" != "600" ]; then
    bad="$bad ws$i"
  fi
done
if [ -z "$bad" ]; then
  pass "T12 .secrets/memex.env untouched in all $N runs"
else
  die "T12 .secrets/memex.env changed in:$bad"
fi
