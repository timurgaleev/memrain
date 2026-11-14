#!/usr/bin/env bash
# Smoke test for the no-AWS local quickstart (deploy/docker-compose.local.yml).
#
# Builds the image, then runs it in a throwaway project on a Docker network
# with no route out, so AWS endpoints are unreachable. Over MCP it writes a
# page, finds it with search and reads it back; restarts the container and
# reads it again from the volume; mints a personal access token and writes a
# page with it; and checks the spend ledger booked no model call. Everything
# it creates (container, network, volume) is removed on exit.
#
# Needs Docker Compose 2.24 or newer: the sealed-network override uses !reset.
#
#   scripts/local-smoke.sh
set -euo pipefail

# Compose before 2.24 rejects `!reset`, and older ones may ignore it and keep
# the host port, so the sealed network would not be sealed.
compose_version="$(docker compose version --short 2>/dev/null || true)"
compose_version="${compose_version#v}"
IFS=. read -r cv_major cv_minor _ <<<"$compose_version"
if ! [[ "${cv_major:-}" =~ ^[0-9]+$ && "${cv_minor:-}" =~ ^[0-9]+$ ]] \
  || ((cv_major < 2 || (cv_major == 2 && cv_minor < 24))); then
  echo "[smoke] FAIL: Docker Compose 2.24 or newer is required (found: ${compose_version:-none}); upgrade Docker or the compose plugin" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="memrain-smoke-$$"
WORK="$(mktemp -d)"
ENV_FILE="$WORK/smoke.env"
OVERRIDE="$WORK/sealed.yml"
TOKEN="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"

(umask 077 && printf 'MEMRAIN_INTERNAL_TOKEN=%s\n' "$TOKEN" >"$ENV_FILE")
cat >"$OVERRIDE" <<'EOF'
services:
  memrain:
    ports: !reset []
    networks: [sealed]
networks:
  sealed:
    internal: true
EOF

compose() {
  docker compose -p "$PROJECT" -f "$ROOT/deploy/docker-compose.local.yml" -f "$OVERRIDE" \
    --env-file "$ENV_FILE" "$@"
}

cleanup() {
  compose down -v >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Runs inside the container: MCP over loopback, with the token from the env.
# shellcheck disable=SC2016
MCP_CLIENT='
const step = process.argv[1];
const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${process.env.SMOKE_TOKEN}` };
async function call(name, args) {
  const res = await fetch("http://127.0.0.1:18790/mcp", { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const rpc = await res.json();
  if (rpc.error || rpc.result?.isError) throw new Error(`${name}: ${JSON.stringify(rpc.error ?? rpc.result.content)}`);
  return JSON.parse(rpc.result.content[0].text);
}
const slug = "smoke/quokka-ledger";
if (step === "egress") {
  const reached = await fetch("https://bedrock-runtime.eu-west-1.amazonaws.com/", { signal: AbortSignal.timeout(5000) })
    .then(() => true, () => false);
  if (reached) throw new Error("the sealed network reached AWS; egress is not blocked");
  console.log("ok egress blocked");
} else if (step === "write") {
  await call("page_put", { slug, markdown_body: "# Quokka ledger\n\nThe marsupialsmoke audit closed on Friday.\n\n```ts\nexport const marsupialTotal = (a: number) => a * 2;\n```\n" });
  console.log("ok page_put");
}
if (step === "write" || step === "read") {
  const found = await call("search", { q: "marsupialsmoke" });
  if (!found.hits.some((h) => h.sourcePath === `page://${slug}`)) throw new Error(`search missed the page: ${JSON.stringify(found)}`);
  if (found.meta.vectorEnabled !== false) throw new Error("search used a vector arm in keyword-only mode");
  const page = await call("page_get", { slug });
  if (!JSON.stringify(page).includes("marsupialsmoke audit")) throw new Error(`page_get lost the body: ${JSON.stringify(page)}`);
  console.log(`ok search + page_get (${step})`);
}
if (step === "pat-write") {
  const patSlug = "smoke/quokka-pat";
  await call("page_put", { slug: patSlug, markdown_body: "# PAT page\n\nWritten with a personal access token: wombatsmoke.\n" });
  const page = await call("page_get", { slug: patSlug });
  if (!JSON.stringify(page).includes("wombatsmoke")) throw new Error(`page_get lost the PAT write: ${JSON.stringify(page)}`);
  console.log("ok page_put + page_get with a personal access token");
}
'

# $1 is the step; $2 the bearer, the internal token unless given.
mcp() {
  compose exec -T -e SMOKE_TOKEN="${2:-$TOKEN}" memrain bun -e "$MCP_CLIENT" "$1"
}

echo "[smoke] building and starting $PROJECT on a sealed network"
compose up -d --build --wait

health="$(compose exec -T memrain wget -qO- http://127.0.0.1:18790/health)"
echo "[smoke] /health: $health"
case "$health" in
  *'"keyword_only":true'*) ;;
  *) echo "[smoke] FAIL: /health does not report keyword_only" >&2; exit 1 ;;
esac

mcp egress
mcp write

echo "[smoke] restarting the container"
compose restart memrain
compose up -d --wait
mcp read

# The quickstart tells people to connect a client with a personal access
# token (scripts/local-up.sh token <name>), so prove one can write. PGLite
# admits one process: the server steps aside while the CLI mints it.
echo "[smoke] minting a personal access token"
compose stop memrain
minted="$(compose run --rm --no-deps --entrypoint bun memrain run src/cli.ts auth create smoke-writer)"
pat="$(printf '%s\n' "$minted" | sed -n 's/^  "token": "\(memrain_[0-9a-f]*\)",$/\1/p')"
if [ -z "$pat" ]; then
  echo "[smoke] FAIL: auth create printed no token" >&2
  exit 1
fi
compose up -d --wait
mcp pat-write "$pat"

echo "[smoke] checking the spend ledger"
compose stop memrain
spend="$(compose run --rm --no-deps --entrypoint bun memrain run src/cli.ts spend --days 1)"
calls="$(printf '%s' "$spend" | sed -n 's/^  "calls": \([0-9]*\),$/\1/p')"
if [ "$calls" != "0" ]; then
  echo "[smoke] FAIL: the spend ledger booked ${calls:-an unknown number of} model call(s)" >&2
  exit 1
fi
echo "ok no model call booked"
echo "[smoke] PASS"
