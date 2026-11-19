FROM alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412

# Transaction mode with postgres-js's named prepared statements needs
# max_prepared_statements, which PgBouncer has since 1.21: the build fails on
# anything older.
RUN apk add --no-cache pgbouncer=1.24.0-r0 \
 && v="$(pgbouncer --version | sed -n 's/^PgBouncer \([0-9]*\)\.\([0-9]*\).*/\1 \2/p')" \
 && set -- $v \
 && { [ "${1:-0}" -gt 1 ] || { [ "${1:-0}" -eq 1 ] && [ "${2:-0}" -ge 21 ]; }; } \
 || { echo "PgBouncer 1.21 or newer is required, got: $(pgbouncer --version | head -1)" >&2; exit 1; }

RUN addgroup -S -g 10070 pgbouncer \
 && adduser -S -D -H -u 10070 -G pgbouncer -h /nonexistent -s /sbin/nologin pgbouncer \
 && install -d -o pgbouncer -g pgbouncer -m 0700 /run/pgbouncer

COPY render.sh pgbouncer.ini.tmpl entrypoint.sh /etc/pgbouncer/
RUN chmod 0555 /etc/pgbouncer/render.sh /etc/pgbouncer/entrypoint.sh

# The config and userlist are written at start into /run/pgbouncer; compose
# mounts a tmpfs there (uid 10070) so the root filesystem stays read-only.
USER pgbouncer
EXPOSE 6432
ENTRYPOINT ["/etc/pgbouncer/entrypoint.sh"]
