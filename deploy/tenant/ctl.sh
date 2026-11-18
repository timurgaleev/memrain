#!/usr/bin/env bash
# Run one control-plane command on a hosting host, in the one-shot tenant-ctl
# container with the whole hosting file set, as the deploy does:
#
#   bash deploy/tenant/ctl.sh [--build] tenant <command> [args...]
#
# --build first builds the image, stamped with `git describe` like a deploy.
# A fresh stack needs it once, before any tenant runs; afterwards the command
# runs from the image the tenants run (deploy/tenant/lib.sh). Run from the
# repo root, like deploy/deploy.sh.
set -euo pipefail

# shellcheck source=deploy/tenant/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
hosting_files

if [ "${1:-}" = "--build" ]; then
  shift
  if [ -z "${MEMRAIN_VERSION:-}" ]; then
    MEMRAIN_VERSION="$(git describe --tags --match 'v[0-9]*' --always --dirty)"
  fi
  export MEMRAIN_VERSION
  hosting_compose build tenant-ctl
fi
hosting_ctl "$@"
