#!/usr/bin/env bash
# Memory bench for tenant containers: how much RSS one brain needs under a
# mixed load, which sets MEMRAIN_TENANT_MEM_LIMIT and how many tenants fit a
# host. Local and free: a throwaway pgvector database per brain, keyword-only
# search (no AWS), everything on a private Docker network removed on exit.
#
#   bash scripts/tenant-rss-bench.sh [--image IMG] [--tenants 3] [--pages 2000]
#                                    [--minutes 5] [--host-mib 4096]
#
# --image defaults to memrain-bench:local; build it first with
#   docker build -t memrain-bench:local deploy/memrain
# On a hosting host pass the deployed memrain-hosting:<tag> instead. Never
# tag a bench build memrain-hosting:dev: that is the tag the hosting compose
# falls back to.
# Each brain gets --pages pages of five sections (~10k chunks at 2000), then
# --minutes of load from four workers per brain: 70% search, 20% page_get,
# 10% page_put, paced to the server's per-caller limit (about 10 requests a
# second). docker stats is sampled every 5 seconds during the load.
# Prints p50/p95/max RSS per brain, the largest Postgres connection count,
# the suggested MEMRAIN_TENANT_MEM_LIMIT (1.5 x the worst p95, rounded up to
# 64 MiB) and how many tenants fit --host-mib with 768 MiB kept for the
# system, Docker and cloudflared.
set -euo pipefail

# to_mib SIZE -> whole MiB from a docker stats size (B, KiB, MiB, GiB).
to_mib() {
  awk -v s="$1" 'BEGIN {
    n = s + 0; u = s; sub(/^[0-9.]+/, "", u)
    f = (u == "GiB") ? 1024 : (u == "MiB") ? 1 : (u == "KiB") ? 1 / 1024 : 1 / 1048576
    printf "%d\n", n * f + 0.5 }'
}

# bench_summary HOST_MIB RESERVED_MIB < "name<TAB>mib" lines -> one line per
# container (nearest-rank p50/p95), then the limit and tenants per host.
bench_summary() {
  sort -k1,1 -k2,2n | awk -F'\t' -v host="$1" -v reserved="$2" '
    function flush() {
      if (n == 0) return
      p50 = v[int(n * 0.50 + 0.999999)]; p95 = v[int(n * 0.95 + 0.999999)]
      printf "%s samples=%d p50=%d p95=%d max=%d\n", name, n, p50, p95, v[n]
      if (p95 > worst) worst = p95
      n = 0
    }
    $1 != name { flush(); name = $1 }
    { v[++n] = $2 }
    END {
      flush()
      if (worst == 0) exit
      limit = int((worst * 1.5 + 63) / 64) * 64
      printf "MEMRAIN_TENANT_MEM_LIMIT=%dm\n", limit
      printf "tenants_per_host=%d (host %d MiB, reserved %d MiB)\n", int((host - reserved) / limit), host, reserved
    }'
}

[ "${BENCH_LIB_ONLY:-}" = 1 ] && return 0

IMAGE="memrain-bench:local" TENANTS=3 PAGES=2000 MINUTES=5 HOST_MIB=4096 RESERVED_MIB=768
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --tenants) TENANTS="$2"; shift 2 ;;
    --pages) PAGES="$2"; shift 2 ;;
    --minutes) MINUTES="$2"; shift 2 ;;
    --host-mib) HOST_MIB="$2"; shift 2 ;;
    *) echo "usage: $0 [--image IMG] [--tenants N] [--pages N] [--minutes N] [--host-mib N]" >&2; exit 2 ;;
  esac
done
for n in "$TENANTS" "$PAGES" "$MINUTES" "$HOST_MIB"; do
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "FAIL: numbers must be positive integers" >&2; exit 2; }
done
docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || { echo "FAIL: image ${IMAGE} not found (docker build -t ${IMAGE} deploy/memrain)" >&2; exit 1; }

RUN="bench$$"
NET="memrain_${RUN}"
PG="memrain-${RUN}-pg"
WORK="$(mktemp -d)"
PW="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
TOKEN="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
NAMES=()
cleanup() {
  docker rm -f "${NAMES[@]+"${NAMES[@]}"}" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> ${TENANTS} brain(s) from ${IMAGE}, ${PAGES} pages each, ${MINUTES} min of load"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD="$PW" pgvector/pgvector:pg16 >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
sleep 2

TARGETS=""
for i in $(seq 1 "$TENANTS"); do
  name="memrain-${RUN}-t${i}"
  docker exec "$PG" psql -U postgres -qc "CREATE DATABASE bench${i}" >/dev/null
  (umask 077; printf 'MEMRAIN_POSTGRES_URL=postgres://postgres:%s@%s:5432/bench%s?sslmode=disable\nMEMRAIN_INTERNAL_TOKEN=%s\n' \
    "$PW" "$PG" "$i" "$TOKEN" > "$WORK/t${i}.env")
  docker run -d --name "$name" --network "$NET" --env-file "$WORK/t${i}.env" \
    -e MEMRAIN_REQUIRE_POSTGRES=1 -e MEMRAIN_KEYWORD_ONLY=1 -e MEMRAIN_PG_POOL_MAX=4 \
    -e MEMRAIN_PG_APPLICATION_NAME="memrain:t${i}:serve" -e AWS_REGION= -e AWS_PROFILE= \
    --cap-drop ALL --security-opt no-new-privileges:true "$IMAGE" >/dev/null
  NAMES+=("$name")
  TARGETS="${TARGETS:+$TARGETS,}http://${name}:18790"
done
for name in "${NAMES[@]}"; do
  for _ in $(seq 1 90); do
    [ "$(docker inspect "$name" --format '{{.State.Health.Status}}')" = healthy ] && break
    sleep 2
  done
  [ "$(docker inspect "$name" --format '{{.State.Health.Status}}')" = healthy ] \
    || { docker logs --tail 30 "$name" >&2; echo "FAIL: ${name} did not become healthy" >&2; exit 1; }
done

# shellcheck disable=SC2016
LOADER='
const env = process.env;
const targets = env.TARGETS.split(",");
const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${env.TOKEN}` };
const pages = Number(env.PAGES);
const started = Date.now();
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const syl = ["ka", "lo", "mi", "ren", "tas", "vo", "qui", "zan", "pel", "dor", "fi", "gu", "hap", "jen", "sul", "bri"];
const vocab = Array.from({ length: 400 }, (_, i) => syl[i % 16] + syl[(i * 7) % 16] + syl[(i * 13 + 3) % 16]);
const words = (n) => Array.from({ length: n }, () => vocab[Math.floor(rnd() * vocab.length)]).join(" ");
const body = (i) => `# Bench page ${i}\n\n` + Array.from({ length: 5 }, (_, s) => `## Section ${s}\n\n${words(120)}.\n`).join("\n");
const stats = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The server caps one caller at about 10 requests a second; a 429 waits and
// tries again, so the brain runs at that ceiling instead of answering 429s.
async function call(base, name, args) {
  const s = (stats[base] ??= { ok: 0, err: 0, limited: 0 });
  for (;;) {
    try {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      if (res.status === 429) { s.limited++; await res.body?.cancel(); await sleep(500); continue; }
      const rpc = await res.json();
      if (rpc.error || rpc.result?.isError) s.err++; else s.ok++;
    } catch { s.err++; }
    return;
  }
}
async function workers(n, fn) { await Promise.all(Array.from({ length: n }, (_, w) => fn(w))); }
if (env.PHASE === "seed") {
  await Promise.all(targets.map((t) => workers(4, async (w) => {
    for (let i = w; i < pages; i += 4) await call(t, "page_put", { slug: `bench/p-${i}`, markdown_body: body(i) });
  })));
} else {
  const until = Date.now() + Number(env.LOAD_SECONDS) * 1000;
  await Promise.all(targets.map((t) => workers(4, async () => {
    while (Date.now() < until) {
      const r = rnd(), i = Math.floor(rnd() * pages);
      if (r < 0.7) await call(t, "search", { q: words(2) });
      else if (r < 0.9) await call(t, "page_get", { slug: `bench/p-${i}` });
      else await call(t, "page_put", { slug: `bench/p-${i}`, markdown_body: body(i + pages) });
    }
  })));
}
const secs = (Date.now() - started) / 1000;
for (const [t, s] of Object.entries(stats)) {
  console.log(`${env.PHASE} ${t.replace(/^http:\/\//, "")} ok=${s.ok} err=${s.err} limited=${s.limited} rate=${(s.ok / secs).toFixed(1)}/s`);
}
'
loader() {
  docker run --rm --network "$NET" --entrypoint bun -e TARGETS="$TARGETS" -e TOKEN="$TOKEN" \
    -e PAGES="$PAGES" -e PHASE="$1" -e LOAD_SECONDS="$((MINUTES * 60))" "$IMAGE" -e "$LOADER"
}

echo "==> seeding"
loader seed

echo "==> load for ${MINUTES} min, sampling every 5 s"
SAMPLES="$WORK/samples.tsv" CONNS="$WORK/conns.txt"
: > "$SAMPLES"; : > "$CONNS"
(
  while :; do
    docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}' "${NAMES[@]}" 2>/dev/null |
      while IFS=$'\t' read -r name usage; do printf '%s\t%s\n' "${name##*-}" "$(to_mib "${usage%% *}")"; done >> "$SAMPLES"
    docker exec "$PG" psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'bench%'" >> "$CONNS" 2>/dev/null
    sleep 5
  done
) &
SAMPLER=$!
loader load
kill "$SAMPLER" 2>/dev/null; wait "$SAMPLER" 2>/dev/null || true

echo "==> result (${IMAGE}, ${TENANTS} brains, ${PAGES} pages x 5 sections, ${MINUTES} min)"
bench_summary "$HOST_MIB" "$RESERVED_MIB" < "$SAMPLES"
echo "max_pg_connections=$(sort -n "$CONNS" | tail -1) (pool 4 per brain)"
