#!/usr/bin/env bash
# Run Memrain on this machine without AWS: PGLite in a Docker volume,
# keyword-only search, the MCP endpoint on 127.0.0.1.
#
#   scripts/local-up.sh              build, start, print the MCP URL and token
#   scripts/local-up.sh token NAME   mint a personal access token (restarts the container)
#   scripts/local-up.sh down         stop; the pages stay in the volume
#
# MEMRAIN_LOCAL_PORT changes the host port (default 18790).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/deploy/local.env"
PORT="${MEMRAIN_LOCAL_PORT:-18790}"
URL="http://127.0.0.1:$PORT"

command -v docker >/dev/null 2>&1 || {
  echo "[local] docker is required (https://docs.docker.com/get-docker/)" >&2
  exit 1
}

# The internal token is the local operator credential. Created once, kept out
# of git by the *.env ignore rule, readable only by you.
if [ ! -f "$ENV_FILE" ]; then
  (umask 077 && printf 'MEMRAIN_INTERNAL_TOKEN=%s\n' "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')" >"$ENV_FILE")
fi
TOKEN="$(sed -n 's/^MEMRAIN_INTERNAL_TOKEN=//p' "$ENV_FILE")"

compose() {
  docker compose -f "$ROOT/deploy/docker-compose.local.yml" --env-file "$ENV_FILE" "$@"
}

case "${1:-up}" in
  up)
    compose up -d --build --wait
    cat <<EOF

Memrain is running locally (keyword-only: no AWS, no embeddings, no model calls).

  MCP URL:  $URL/mcp
  Token:    $TOKEN
            (stored in deploy/local.env)

Connect Claude Code:
  claude mcp add --transport http memrain $URL/mcp --header "Authorization: Bearer $TOKEN"

A personal access token for one client instead:  scripts/local-up.sh token <name>
Stop (pages are kept):                           scripts/local-up.sh down
EOF
    ;;
  token)
    name="${2:?usage: scripts/local-up.sh token <name>}"
    # PGLite admits one process: the server steps aside while the CLI writes.
    compose stop memrain
    compose run --rm --no-deps --entrypoint bun memrain run src/cli.ts auth create "$name"
    compose up -d --wait
    ;;
  down)
    compose down
    ;;
  *)
    echo "usage: scripts/local-up.sh [up|token <name>|down]" >&2
    exit 2
    ;;
esac
