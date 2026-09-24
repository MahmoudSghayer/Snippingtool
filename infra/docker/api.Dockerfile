# syntax=docker/dockerfile:1.7
#
# Multi-stage image for @sl/api. Two final targets share everything up to
# `runtime` and differ only in EXPOSE/HEALTHCHECK/CMD:
#   docker build -f infra/docker/api.Dockerfile --target server -t sl-api:tag .
#   docker build -f infra/docker/api.Dockerfile --target worker -t sl-worker:tag .
# Build context MUST be the repo root (pnpm workspace root).
#
# Build args:
#   BUILD_DATE   RFC3339 build timestamp, for OCI labels (set by CI)
#   VCS_REF      git commit SHA, for OCI labels (set by CI)
#   VERSION      app/image semver, for OCI labels (set by CI, e.g. from a git tag)

ARG NODE_VERSION=22-alpine
ARG PNPM_VERSION=12.5.1

# ---------------------------------------------------------------------------
# base — Node + tini + pnpm, pinned via corepack. No app code yet, so this
# layer is cached across every build regardless of source changes.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
# hadolint ignore=DL3018
# Alpine's repo doesn't retain old package versions the way Debian
# snapshots do, so pinning apk versions here would break rebuilds against a
# newer base image tag; the Alpine *release* itself (pinned via the
# node:${NODE_VERSION}/postgres:${PG_VERSION}-alpine tag) is the reproducible
# unit instead.
RUN apk add --no-cache tini libc6-compat \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ---------------------------------------------------------------------------
# build — the full monorepo (via .dockerignore-filtered COPY . .), installed
# as one workspace so `--frozen-lockfile` sees every project the lockfile
# was generated against (installing from only a subset of package.json
# files makes pnpm think projects were removed and refuses to honour a
# frozen lockfile). Builds @sl/api and everything it depends on
# (@sl/db, @sl/shared, @sl/config) via Turborepo's dependency graph, then
# prunes to a standalone, production-only deploy directory with `pnpm
# deploy` (workspace:* deps are resolved to real files, not symlinks — what
# makes the runtime stage below independent of the rest of the repo/pnpm).
# ---------------------------------------------------------------------------
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@sl/api...
RUN pnpm --filter=@sl/api deploy --prod /prod/api
# The downloadable extension (GET /api/v1/downloads/extension). Built once as
# a template with placeholder origins; the API fills in its own APP_ORIGIN,
# DASHBOARD_ORIGIN and entitlement key when it serves the zip
# (apps/api/src/lib/extension-download.ts), so this image needs no
# per-deployment build args for it.
RUN pnpm --filter=@sl/extension build:template \
 && mkdir -p /prod/api/downloads \
 && cp -r apps/extension/dist/ledger-auto-template /prod/api/downloads/extension-template

# ---------------------------------------------------------------------------
# runtime — shared base for server + worker: non-root user, tini as PID 1,
# only the pruned production output copied in (no pnpm, no workspace, no
# devDependencies, no source of other apps).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="sniper-ledger-api" \
      org.opencontainers.image.description="The Sniper's Ledger — Fastify REST/WS API and BullMQ worker runtime" \
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
RUN apk add --no-cache tini wget \
 && addgroup -g 10001 sl \
 && adduser -D -H -u 10001 -G sl -s /sbin/nologin sl
WORKDIR /app
COPY --from=build --chown=sl:sl /prod/api ./
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
USER sl
ENTRYPOINT ["/sbin/tini", "--"]

# ---------------------------------------------------------------------------
# server — the HTTP/WS role (src/server.ts).
# ---------------------------------------------------------------------------
FROM runtime AS server
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD sh -c 'wget --spider -q "http://127.0.0.1:${PORT:-3000}/health/live" || exit 1'
CMD ["node", "dist/server.js"]

# ---------------------------------------------------------------------------
# worker — the BullMQ role (src/worker.ts). No HTTP server, so the
# healthcheck can't hit /health/live like the server image does; it opens a
# raw TCP connection to Redis instead (same signal apps/api's own readiness
# check uses — Redis reachable — without needing an HTTP endpoint added to
# the worker process, which is out of this Dockerfile's ownership).
# ---------------------------------------------------------------------------
FROM runtime AS worker
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "\
    const { hostname, port } = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379'); \
    const net = require('node:net'); \
    const sock = net.createConnection(Number(port) || 6379, hostname); \
    sock.setTimeout(3000); \
    sock.on('connect', () => { sock.end(); process.exit(0); }); \
    sock.on('timeout', () => { sock.destroy(); process.exit(1); }); \
    sock.on('error', () => process.exit(1)); \
  "
CMD ["node", "dist/worker.js"]
