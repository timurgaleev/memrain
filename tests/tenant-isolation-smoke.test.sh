#!/usr/bin/env bash
# tests/tenant-isolation-smoke.test.sh — scripts/tenant-isolation-smoke.sh.
#
# A stub `docker` answers inspect/ps from fixtures and runs `docker exec ...
# bun -e <probe>` with the local bun, from deploy/memrain so the AWS SDK
# resolves as it does in the image. Local listeners stand in for RDS,
# Bedrock, a neighbour tenant, IMDS and Secrets Manager. The smoke must pass
# only when RDS and Bedrock answer and the neighbour, IMDS and a foreign
# secret do not, and only then record the pass in control.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MEMRAIN_DIR="$REPO_ROOT/deploy/memrain"
TMPROOT="$(mktemp -d -t tenant-smoke.XXXXXX)"
PASS=0
FAIL=0
SERVER_PID=""
finish() {
  rc=$?
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$TMPROOT"
  echo
  echo "tenant-isolation-smoke.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

for tool in bun jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "tenant-isolation-smoke.test.sh: $tool not installed — skipping"; exit 0; }
done
[ -d "$MEMRAIN_DIR/node_modules/@aws-sdk/client-secrets-manager" ] \
  || { echo "tenant-isolation-smoke.test.sh: deploy/memrain dependencies not installed (bun install) — skipping"; exit 0; }

# ---- Local stand-ins -------------------------------------------------------
# rds, bedrock, neighbour: accept TCP. imds: answers a PUT. secrets: a fake
# Secrets Manager whose answer comes from $TMPROOT/secrets_mode. closed: a
# port that was bound and released, so connects are refused.
cat > "$TMPROOT/server.js" <<'JS'
import net from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
const dir = process.argv[2];
const tcp = () => net.createServer((s) => s.end()).listen(0, "127.0.0.1");
const ports = {};
for (const name of ["rds", "bedrock", "neighbour"]) {
  const srv = tcp();
  await new Promise((r) => srv.on("listening", r));
  ports[name] = srv.address().port;
}
const imds = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("token") });
ports.imds = imds.port;
const secrets = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    // A per-secret answer in secret_mode/<id with / as __> wins over secrets_mode.
    const id = String((await req.json().catch(() => ({}))).SecretId || "").replaceAll("/", "__");
    let mode;
    try { mode = readFileSync(`${dir}/secret_mode/${id}`, "utf8").trim(); }
    catch { mode = readFileSync(`${dir}/secrets_mode`, "utf8").trim(); }
    if (mode === "readable") return Response.json({ Name: "x", SecretString: "leaked" });
    return new Response(JSON.stringify({ __type: mode, message: "stub" }), {
      status: 400, headers: { "content-type": "application/x-amz-json-1.1" },
    });
  },
});
ports.secrets = secrets.port;
const tmp = net.createServer().listen(0, "127.0.0.1");
await new Promise((r) => tmp.on("listening", r));
ports.closed = tmp.address().port;
tmp.close();
// Accepts and never answers: what IMDS looks like from a tenant container
// whose responses are dropped (hop limit 1, or a firewall DROP).
const held = [];
const blackhole = net.createServer((s) => held.push(s)).listen(0, "127.0.0.1");
await new Promise((r) => blackhole.on("listening", r));
ports.blackhole = blackhole.address().port;
writeFileSync(`${dir}/ports.json`, JSON.stringify(ports));
JS
echo AccessDeniedException > "$TMPROOT/secrets_mode"
bun "$TMPROOT/server.js" "$TMPROOT" &
SERVER_PID=$!
for _ in $(seq 1 50); do [ -s "$TMPROOT/ports.json" ] && break; sleep 0.1; done
[ -s "$TMPROOT/ports.json" ] || { echo "stand-in servers did not start"; exit 1; }
port() { jq -r ".$1" "$TMPROOT/ports.json"; }

# ---- Stub docker -------------------------------------------------------------
# $S/inspect/<name>.json   one container's `docker inspect` object
# $S/probe_env             extra KEY=VALUE lines for the probe process
# $S/calls.log             one line per call
write_stub() {
  mkdir -p "$1"
  cat > "$1/docker" <<'STUB'
#!/usr/bin/env bash
set -u
S="$STUB_DIR"
case "$1" in
  inspect)
    shift
    printf 'inspect %s\n' "$*" >> "$S/calls.log"
    out="[]"
    for name in "$@"; do
      [ -f "$S/inspect/$name.json" ] || { echo "Error: No such object: $name" >&2; exit 1; }
      out="$(jq -c --slurpfile o "$S/inspect/$name.json" '. + $o' <<< "$out")"
    done
    printf '%s\n' "$out" ;;
  exec)
    shift
    envs=()
    while [ "$1" = "-e" ]; do envs+=("$2"); shift 2; done
    c="$1"; shift
    printf 'exec %s %s %s\n' "$c" "$1" "$2" >> "$S/calls.log"
    [ "$1" = bun ] && [ "$2" = -e ] || { echo "stub: unexpected exec" >&2; exit 2; }
    extra=()
    while IFS= read -r l; do [ -n "$l" ] && extra+=("$l"); done < "$S/probe_env"
    cd "$MEMRAIN_DIR" && exec env -i PATH="$PATH" HOME="$S/home" AWS_CONFIG_FILE=/nonexistent \
      AWS_SHARED_CREDENTIALS_FILE=/nonexistent AWS_REGION=eu-west-1 \
      MEMRAIN_POSTGRES_URL="$(cat "$S/pg_url")" "${extra[@]+"${extra[@]}"}" "${envs[@]}" bun -e "$3" ;;
  compose)
    shift
    while [ $# -gt 0 ]; do case "$1" in --env-file|-f) shift 2 ;; *) break ;; esac; done
    printf 'compose %s\n' "$*" >> "$S/calls.log"
    case "$*" in
      *"tenant list --json"*) [ -e "$S/list_fail" ] && exit 1; cat "$S/list.json" ;;
    esac ;;
  # The image the running tenants run: hosting_ctl takes its version from it.
  ps) echo "memrain-hosting:v9.9.9" ;;
  *) printf 'docker %s\n' "$*" >> "$S/calls.log" ;;
esac
STUB
  chmod +x "$1/docker"
}

container_json() { # NAME NETWORK [MOUNT_SOURCE]
  local mounts='[]'
  [ -n "${3:-}" ] && mounts="[{\"Type\":\"bind\",\"Source\":\"$3\",\"Destination\":\"/x\"}]"
  printf '{"Name":"/%s","State":{"Running":true,"StartedAt":"2026-11-18T09:30:00.123456789Z"},"Config":{"Env":["PATH=/usr/bin","MEMRAIN_VERSION=v9.9.9"]},"Mounts":%s,"NetworkSettings":{"Networks":{"%s":{"IPAddress":"127.0.0.1"}}}}\n' \
    "$1" "$mounts" "$2" > "$S/inspect/$1.json"
}

# list ID:STATUS... -> what `tenant list --json` answers in this workspace
list() {
  local e="" p
  for p in "$@"; do e="${e:+$e,}{\"id\":\"${p%%:*}\",\"status\":\"${p#*:}\",\"mode\":null,\"hostname\":\"h\"}"; done
  printf '{"ok":true,"tenants":[%s]}\n' "$e" > "$S/list.json"
}

N=0
ws_new() {
  N=$((N + 1))
  WS="$TMPROOT/ws$N"
  S="$WS/stub"
  mkdir -p "$WS/deploy/tenant" "$WS/deploy/tenants" "$WS/scripts" "$S/inspect" "$S/home"
  cp "$REPO_ROOT/deploy/tenant/"* "$WS/deploy/tenant/"
  cp "$REPO_ROOT/scripts/tenant-isolation-smoke.sh" "$WS/scripts/"
  printf 'AWS_REGION=eu-west-1\nSECRETS_PREFIX=hst\n' > "$WS/.env"
  write_stub "$S/bin"
  : > "$S/probe_env"
  printf 'services: {}\n' > "$WS/deploy/tenants/acme.yml"
  printf 'services: {}\n' > "$WS/deploy/tenants/beta.yml"
  container_json memrain-acme memrain_tenant_acme
  container_json memrain-beta memrain_tenant_beta
  printf 'postgres://acme_owner:%s@127.0.0.1:%s/tenant_acme' "pw-secret" "$(port rds)" > "$S/pg_url"
  rm -rf "$TMPROOT/secret_mode"
  list acme:active beta:active
  echo AccessDeniedException > "$TMPROOT/secrets_mode"
  echo 5f0c9a8e-1b2d-4c3e-9f4a-0123456789ab > "$S/boot_id"
}

# Defaults every run: Bedrock is the local listener, IMDS a refused port, and
# the neighbour's service port one nobody listens on.
run_smoke() {
  RC=0
  (cd "$WS" && env -i PATH="$S/bin:$PATH" HOME="$WS" STUB_DIR="$S" MEMRAIN_DIR="$MEMRAIN_DIR" \
    SMOKE_BEDROCK_ADDR="127.0.0.1:$(port bedrock)" SMOKE_IMDS_ADDR="127.0.0.1:$(port closed)" \
    SMOKE_SERVICE_PORT="$(port closed)" SMOKE_BOOT_ID_FILE="$S/boot_id" "$@" \
    timeout 120 bash scripts/tenant-isolation-smoke.sh acme ${SMOKE_ARGS:+"$SMOKE_ARGS"}) > "$WS/out.log" 2>&1 || RC=$?
}
called() { grep -qF -- "$1" "$S/calls.log" 2>/dev/null; }
show() { sed 's/^/      /' "$WS/out.log"; }

echo "== tenant-isolation-smoke.sh =="

ws_new; run_smoke
if [ "$RC" -eq 0 ]; then pass "an isolated tenant passes"; else die "isolated tenant failed (rc=$RC)"; show; fi
if called 'tenant smoke-record acme'; then pass "a pass is recorded in control"; else die "no smoke-record after a pass"; fi
# The container admits traffic only for a record with its own boot id and
# image stamp, made after it started: the record must carry all three.
if called 'tenant smoke-record acme --boot-id 5f0c9a8e-1b2d-4c3e-9f4a-0123456789ab --image-stamp v9.9.9 --started-at 2026-11-18T09:30:00.123Z'; then
  pass "the record carries the container's boot id, image stamp and start time"
else die "smoke-record lacks the container's stamp"; grep smoke-record "$S/calls.log" | sed 's/^/      /'; fi
if grep -q 'pw-secret' "$WS/out.log"; then die "the database password reached the output"; else pass "no secret in the output"; fi
if called 'inspect memrain-beta'; then pass "the neighbour comes from deploy/tenants/"; else die "neighbour not looked up"; fi
probed=1
for id in hst/tenants/beta/postgres-url hst/tenants/beta/control-url hst/tenants/beta/internal-token hst/hosting/control-admin-url; do
  grep -q "ok secrets ($id:" "$WS/out.log" || { probed=0; echo "      not probed: $id"; }
done
if [ "$probed" = 1 ]; then pass "every neighbour secret and the control admin URL are probed"; else die "foreign secrets not all probed"; show; fi

ws_new; SMOKE_ARGS=--no-record run_smoke
if [ "$RC" -eq 0 ] && ! called 'smoke-record'; then pass "--no-record checks without recording"; else die "--no-record: rc=$RC"; fi

ws_new; run_smoke SMOKE_SERVICE_PORT="$(port neighbour)"
if [ "$RC" -ne 0 ] && ! called 'smoke-record' && grep -q 'FAIL neighbour' "$WS/out.log"; then pass "a reachable neighbour fails the smoke"; else die "reachable neighbour passed (rc=$RC)"; show; fi

ws_new; run_smoke SMOKE_IMDS_ADDR="127.0.0.1:$(port imds)"
if [ "$RC" -ne 0 ] && ! called 'smoke-record' && grep -q 'FAIL imds' "$WS/out.log"; then pass "a reachable IMDS fails the smoke"; else die "reachable IMDS passed (rc=$RC)"; show; fi

ws_new; printf 'postgres://u:%s@127.0.0.1:%s/db' "pw-secret" "$(port closed)" > "$S/pg_url"; run_smoke
if [ "$RC" -ne 0 ] && grep -q 'FAIL rds' "$WS/out.log" && ! grep -q 'pw-secret' "$WS/out.log"; then pass "an unreachable RDS fails the smoke"; else die "unreachable RDS passed (rc=$RC)"; show; fi

ws_new; run_smoke SMOKE_BEDROCK_ADDR="127.0.0.1:$(port closed)"
if [ "$RC" -ne 0 ] && grep -q 'FAIL bedrock' "$WS/out.log"; then pass "an unreachable Bedrock fails the smoke"; else die "unreachable Bedrock passed (rc=$RC)"; show; fi

# With credentials in the container, a foreign secret must be refused.
creds() {
  printf 'AWS_ACCESS_KEY_ID=AKIDSTUBSTUBSTUB\nAWS_SECRET_ACCESS_KEY=stub\nAWS_ENDPOINT_URL_SECRETS_MANAGER=http://127.0.0.1:%s\n' "$(port secrets)" > "$S/probe_env"
}
ws_new; creds; echo readable > "$TMPROOT/secrets_mode"; run_smoke
if [ "$RC" -ne 0 ] && grep -q 'FAIL secrets' "$WS/out.log" && ! grep -q leaked "$WS/out.log"; then pass "a readable foreign secret fails the smoke"; else die "readable foreign secret passed (rc=$RC)"; show; fi
ws_new; creds; echo ResourceNotFoundException > "$TMPROOT/secrets_mode"; run_smoke
if [ "$RC" -ne 0 ] && grep -q 'FAIL secrets' "$WS/out.log"; then pass "NotFound (the role may read the prefix) fails the smoke"; else die "NotFound passed (rc=$RC)"; show; fi
ws_new; creds; echo AccessDeniedException > "$TMPROOT/secrets_mode"; run_smoke
if [ "$RC" -eq 0 ]; then pass "AccessDenied on the foreign secret passes"; else die "AccessDenied failed (rc=$RC)"; show; fi

# Credentials denied the first neighbour's secret may still read a later
# neighbour's, or the control admin URL; each one must be refused.
readable_one() { # SECRET_ID
  mkdir -p "$TMPROOT/secret_mode"
  echo readable > "$TMPROOT/secret_mode/${1//\//__}"
}
ws_new; creds
printf 'services: {}\n' > "$WS/deploy/tenants/gamma.yml"; container_json memrain-gamma memrain_tenant_gamma
readable_one hst/tenants/gamma/internal-token
run_smoke
if [ "$RC" -ne 0 ] && grep -q 'FAIL secrets: hst/tenants/gamma/internal-token' "$WS/out.log" && ! called 'smoke-record'; then
  pass "a readable secret of the third tenant fails the smoke"
else
  die "third tenant's readable secret passed (rc=$RC)"; show
fi
ws_new; creds; readable_one hst/hosting/control-admin-url; run_smoke
if [ "$RC" -ne 0 ] && grep -q 'FAIL secrets: hst/hosting/control-admin-url' "$WS/out.log"; then
  pass "a readable control admin URL fails the smoke"
else
  die "readable control admin URL passed (rc=$RC)"; show
fi

# The SDK's own IMDS timeout does not hold under bun: a metadata endpoint that
# swallows the connection hung the credential lookup for minutes. The
# `imds` check covers the instance role; the secrets check must still finish.
ws_new
printf 'AWS_EC2_METADATA_SERVICE_ENDPOINT=http://127.0.0.1:%s\n' "$(port blackhole)" > "$S/probe_env"
started=$SECONDS
run_smoke
if [ "$RC" -eq 0 ] && [ $((SECONDS - started)) -lt 60 ]; then
  pass "a metadata endpoint that never answers does not hang the smoke ($((SECONDS - started))s)"
else
  die "silent metadata endpoint: rc=$RC after $((SECONDS - started))s"; show
fi

ws_new
printf 'AWS_ACCESS_KEY_ID=AKIDSTUBSTUBSTUB\nAWS_SECRET_ACCESS_KEY=stub\nAWS_ENDPOINT_URL_SECRETS_MANAGER=http://127.0.0.1:%s\n' "$(port blackhole)" > "$S/probe_env"
started=$SECONDS
run_smoke
if [ "$RC" -ne 0 ] && grep -q 'FAIL secrets' "$WS/out.log" && [ $((SECONDS - started)) -lt 60 ]; then
  pass "a Secrets Manager that never answers fails the smoke in bounded time ($((SECONDS - started))s)"
else
  die "silent Secrets Manager: rc=$RC after $((SECONDS - started))s"; show
fi

ws_new
printf '{"Name":"/memrain-acme","State":{"Running":true},"Mounts":[],"NetworkSettings":{"Networks":{"memrain_tenant_acme":{},"memrain_tenant_beta":{}}}}\n' > "$S/inspect/memrain-acme.json"
run_smoke
if [ "$RC" -ne 0 ] && ! called 'exec memrain-acme' && ! called 'smoke-record'; then pass "a container on a second network fails before probing"; else die "two networks passed (rc=$RC)"; show; fi

ws_new; container_json memrain-acme memrain_tenant_acme /opt/memrain/deploy/.secrets/tenants
run_smoke
if [ "$RC" -ne 0 ] && ! called 'smoke-record'; then pass "a mounted secrets directory fails the smoke"; else die "secrets mount passed (rc=$RC)"; fi
ws_new; container_json memrain-acme memrain_tenant_acme /home/ec2-user/.aws
run_smoke
if [ "$RC" -ne 0 ]; then pass "a mounted AWS config fails the smoke"; else die "aws mount passed"; fi

ws_new; container_json memrain-acme memrain_tenant_acme /opt/memrain/deploy/.bedrock/beta
run_smoke
if [ "$RC" -ne 0 ] && ! called 'smoke-record'; then pass "another tenant's Bedrock credentials mounted fail the smoke"; else die "foreign bedrock mount passed (rc=$RC)"; fi
ws_new; container_json memrain-acme memrain_tenant_acme /opt/memrain/deploy/.bedrock/acme
run_smoke
if ! grep -q 'mounts /opt/memrain/deploy/.bedrock/acme' "$WS/out.log"; then pass "its own Bedrock credentials directory is allowed"; else die "own bedrock mount refused"; show; fi

ws_new; rm -f "$S/inspect/memrain-acme.json"; run_smoke
if [ "$RC" -ne 0 ] && ! called 'smoke-record'; then pass "a missing container fails the smoke"; else die "missing container passed"; fi

ws_new; RC=0
(cd "$WS" && env -i PATH="$S/bin:$PATH" STUB_DIR="$S" bash scripts/tenant-isolation-smoke.sh 'acme;id') > "$WS/out.log" 2>&1 || RC=$?
if [ "$RC" -ne 0 ] && [ ! -s "$S/calls.log" ]; then pass "an invalid tenant id is refused before any docker call"; else die "invalid id: rc=$RC"; fi

ws_new; rm -f "$WS/deploy/tenants/beta.yml"; list acme:active; run_smoke
if [ "$RC" -eq 0 ] && grep -q 'hst/tenants/smoke-probe/postgres-url' "$WS/out.log"; then pass "a lone tenant probes a made-up neighbour secret"; else die "lone tenant: rc=$RC"; show; fi

# Neighbours whose container file does not exist yet still have secrets.
ws_new; creds; list acme:active beta:active delta:provisioning
readable_one hst/tenants/delta/internal-token
run_smoke
if [ "$RC" -ne 0 ] && grep -q 'FAIL secrets: hst/tenants/delta/internal-token' "$WS/out.log" && ! called 'smoke-record'; then
  pass "a tenant known only to control is probed too"
else
  die "control-only tenant not probed (rc=$RC)"; show
fi
ws_new; mkdir -p "$WS/deploy/.secrets/tenants"; : > "$WS/deploy/.secrets/tenants/epsilon.env"; run_smoke
if [ "$RC" -eq 0 ] && grep -q 'ok secrets (hst/tenants/epsilon/internal-token:' "$WS/out.log"; then
  pass "a tenant with staged secrets but no container file is probed too"
else
  die "staged-only tenant not probed (rc=$RC)"; show
fi
ws_new; touch "$S/list_fail"; run_smoke
if [ "$RC" -ne 0 ] && ! called 'exec memrain-acme' && ! called 'smoke-record'; then
  pass "an unreadable tenant list fails the smoke before probing"
else
  die "list failure: rc=$RC"; show
fi
