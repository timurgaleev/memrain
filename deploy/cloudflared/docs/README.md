# cloudflared — public ingress sidecar

Routes `https://brain.<domain>/mcp` from the Cloudflare edge to the
internal `memrain` container so MCP-compatible AI clients (Claude Code,
Cursor, Codex) can reach the brain over HTTPS without exposing any
EC2 port. Single-purpose container running the upstream
`cloudflare/cloudflared:2025.4.0` image — no custom build.

## What it does

- Holds an outbound HTTP/2 connection (4 connections by default,
  one per Cloudflare edge POP) to Cloudflare.
- Reads `TUNNEL_TOKEN` from `deploy/.secrets/cloudflared.env` (written
  by `fetch-secrets.sh` from the
  `<secrets_prefix>/cloudflared-tunnel-token` AWS secret).
- Routes traffic per the **dashboard-side ingress rule** (NOT this
  repo): `brain.<domain>` → `http://memrain:18790`. The old origin
  `http://memex:18790` still resolves through a network alias in 0.1.x.

## Why this directory exists

There's no Dockerfile, no entrypoint, no custom build. The image is
pulled directly. This dir holds documentation only.

## Why `--protocol http2`

The EC2 security group only allows TCP egress on 7844. cloudflared's
default first-attempt is QUIC over UDP/7844, which times out forever
without falling back gracefully. Forcing http2 in the compose
`command:` field is what makes the tunnel converge from minute one.

## Why `TUNNEL_TOKEN` env var, not `--token "$VAR"`

docker-compose interpolates `${VAR}` at parse time, BEFORE `env_file`
loads. So `command: ... --token "${CLOUDFLARE_TUNNEL_TOKEN}"` got an
empty string and the tunnel looped on registration. Switching to a
bare `command: tunnel run` and letting cloudflared read `TUNNEL_TOKEN`
from env at runtime fixed it.

## Read more

- `OPERATIONS.md` — restart, rotate token, change ingress
