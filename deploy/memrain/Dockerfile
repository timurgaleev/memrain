# memrain — Bun runtime, multi-stage build
# Base image: oven/bun:1.3.13-alpine (preferred).
# Fallback: oven/bun:1.3.13 (non-alpine) if the alpine tag is unavailable.

# --- admin SPA builder ----------------------------------------------------
# Builds the Vite/React admin dashboard (admin/) into static assets. Kept in a
# separate stage so React/Vite + node_modules never reach the runtime image —
# only the built dist/ is copied across.
FROM oven/bun:1.3.13-alpine AS admin-builder
WORKDIR /admin
COPY admin/package.json admin/bun.lock ./
RUN bun install --frozen-lockfile
COPY admin/vite.config.ts admin/tsconfig.json admin/index.html ./
COPY admin/src ./src
RUN bun run build

# --- runtime --------------------------------------------------------------
FROM oven/bun:1.3.13-alpine

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
# patchedDependencies: bun applies these during install, so they must be in place first.
COPY patches/ ./patches/
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY templates/ ./templates/
# Tree-sitter grammar WASM blobs for the code chunkers. Vendored into
# the repo (deploy/memrain/wasm/) so the container build doesn't depend
# on resolving them out of node_modules at runtime — keeps the boot
# path deterministic and bun build (future) traversal-free.
COPY wasm/ ./wasm/
# Built admin SPA (static dist) from the builder stage — served at /admin by
# http/admin-static.ts (resolves to /app/admin/dist).
COPY --from=admin-builder /admin/dist ./admin/dist
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Non-root: bun base image already provides uid 1000 (`bun`). Owning
# /app to bun lets the entrypoint write logs / cache files. The
# bind-mounted vault + workspace/memory paths are read-only and the
# bootstrap script `chown -R 1000:1000` the EFS vault/* + memrain dir,
# so non-root reads work without per-file chmod gymnastics. Defence
# in depth: an RCE in the Bun process no longer lands as root, so a
# kernel bug or a host-mount oversight cannot escalate to the host
# AWS profile dir or IMDS without an additional privilege exploit.
RUN chown -R bun:bun /app

# Build-time version stamp — the deploy host passes `git describe` via compose;
# a plain `docker build` falls back to 'dev'. Read at runtime by src/version.ts.
ARG MEMRAIN_VERSION=dev

ENV NODE_ENV=production \
    AWS_REGION=eu-west-1 \
    AWS_PROFILE=default \
    MEMRAIN_HOST=0.0.0.0 \
    BRAIN_PORT=18790 \
    MEMRAIN_VERSION=$MEMRAIN_VERSION \
    HOME=/home/bun

EXPOSE 18790

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:18790/health | grep -q '"ok":true' || exit 1

USER bun

ENTRYPOINT ["/app/entrypoint.sh"]
