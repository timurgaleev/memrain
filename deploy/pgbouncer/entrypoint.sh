#!/bin/sh
# Write the config from the environment (render.sh), then run PgBouncer as
# PID 1's child-free replacement so signals reach it.
set -eu
/etc/pgbouncer/render.sh
exec pgbouncer "${PGBOUNCER_RUN_DIR:-/run/pgbouncer}/pgbouncer.ini"
