# syntax=docker/dockerfile:1.7
#
# Postgres backup image: postgres16 client tools + the infra/backups/*.sh
# scripts, run on a schedule by supercronic (a cron replacement built for
# containers — runs fine as a non-root PID 1, unlike busybox crond, which
# expects to run as root and setuid per crontab-file-owner). Optional S3
# upload via rclone (works against AWS S3 and any S3-compatible endpoint;
# picked over the AWS CLI because AWS CLI v2's official build requires glibc
# and this image is musl/Alpine). Build context MUST be the repo root (it
# needs infra/backups/*.sh).

ARG PG_VERSION=16
ARG RCLONE_VERSION=v1.70.0
ARG RCLONE_SHA256=bc6ae0c3f19ea4bf24fa265804fd38a4ad8cf4e5013db228d3d6e09ca20bf6cf
ARG SUPERCRONIC_VERSION=v0.2.34
ARG SUPERCRONIC_SHA256=a51b340a83c5bd035742f0d7191555f9663876405e494dbf824537d64f3e39c6

FROM postgres:${PG_VERSION}-alpine AS tools
ARG RCLONE_VERSION
ARG RCLONE_SHA256
ARG SUPERCRONIC_VERSION
ARG SUPERCRONIC_SHA256
SHELL ["/bin/ash", "-o", "pipefail", "-c"]
# hadolint ignore=DL3018
# Alpine's repo doesn't retain old package versions the way Debian
# snapshots do, so pinning apk versions here would break rebuilds against a
# newer base image tag; the Alpine *release* itself (pinned via the
# node:${NODE_VERSION}/postgres:${PG_VERSION}-alpine tag) is the reproducible
# unit instead.
RUN apk add --no-cache curl unzip \
 && curl -fsSL -o /tmp/rclone.zip "https://github.com/rclone/rclone/releases/download/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-linux-amd64.zip" \
 && echo "${RCLONE_SHA256}  /tmp/rclone.zip" | sha256sum -c - \
 && unzip -q /tmp/rclone.zip -d /tmp/rclone-extract \
 && mv /tmp/rclone-extract/rclone-*-linux-amd64/rclone /usr/local/bin/rclone \
 && chmod +x /usr/local/bin/rclone \
 && curl -fsSL -o /usr/local/bin/supercronic "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
 && echo "${SUPERCRONIC_SHA256}  /usr/local/bin/supercronic" | sha256sum -c - \
 && chmod +x /usr/local/bin/supercronic

FROM postgres:${PG_VERSION}-alpine AS runtime
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="sniper-ledger-backup" \
      org.opencontainers.image.description="The Sniper's Ledger — scheduled pg_dump backups (+ optional S3 upload via rclone) and Redis RDB snapshots" \
      org.opencontainers.image.vendor="The Sniper's Ledger" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/sniper-ledger/sniper-ledger"

# hadolint ignore=DL3018
# Alpine's repo doesn't retain old package versions the way Debian
# snapshots do, so pinning apk versions here would break rebuilds against a
# newer base image tag; the Alpine *release* itself (pinned via the
# node:${NODE_VERSION}/postgres:${PG_VERSION}-alpine tag) is the reproducible
# unit instead.
RUN apk add --no-cache tini bash coreutils gzip tzdata redis procps \
 && addgroup -g 10001 sl && adduser -D -H -u 10001 -G sl sl

COPY --from=tools /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=tools /usr/local/bin/supercronic /usr/local/bin/supercronic

WORKDIR /app
COPY --chown=sl:sl infra/backups/pg-backup.sh infra/backups/pg-restore.sh infra/backups/verify-backup.sh infra/backups/redis-backup.sh ./
COPY --chown=sl:sl infra/docker/backup.crontab ./crontab
RUN chmod +x /app/*.sh \
 && mkdir -p /backups && chown -R sl:sl /backups

VOLUME ["/backups"]
ENV BACKUP_DIR=/backups \
    TZ=UTC
USER sl

# No HTTP surface, so no HEALTHCHECK hitting an endpoint. Liveness instead
# checks supercronic's own process is running and that a backup has landed
# within the last 25 hours (a stale/absent recent dump under a daily
# schedule is the actionable failure — see docs/11-devops.md's "backup age"
# alert, which reads the same freshness signal from Prometheus rather than
# this container's health state).
HEALTHCHECK --interval=5m --timeout=10s --start-period=1m --retries=1 \
  CMD sh -c 'pgrep -f supercronic >/dev/null && find "${BACKUP_DIR}" -maxdepth 1 -name "*.dump.gz" -mmin -1500 | grep -q . || exit 1'

ENTRYPOINT ["/sbin/tini", "--"]
# -no-reap: tini (PID 1 via ENTRYPOINT above) already reaps zombie children,
# so supercronic (PID 2 here, not PID 1) doesn't need to.
CMD ["supercronic", "-no-reap", "/app/crontab"]
