# syntax=docker/dockerfile:1.7
#
# One-shot job image: runs @sl/db's migrator (always) and seed (optional,
# via RUN_SEED=true) against DATABASE_URL. Used by the `migrator` service in
# every compose file (dev/staging/prod) and by release.yml before a staging
# deploy. Build context MUST be the repo root.

ARG NODE_VERSION=22-alpine
ARG PNPM_VERSION=12.5.1

FROM node:${NODE_VERSION} AS build
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@sl/db...
RUN pnpm --filter=@sl/db deploy --prod /prod/db

FROM node:${NODE_VERSION} AS runtime
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="sniper-ledger-db-migrator" \
      org.opencontainers.image.description="The Sniper's Ledger — one-shot @sl/db migrate + optional seed job" \
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
RUN apk add --no-cache tini \
 && addgroup -g 10001 sl && adduser -D -H -u 10001 -G sl sl
WORKDIR /app
COPY --from=build --chown=sl:sl /prod/db ./
COPY --chown=sl:sl infra/docker/db-migrator-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
ENV NODE_ENV=production
USER sl
# No HEALTHCHECK: this is a one-shot batch job (exits after migrate/seed),
# not a long-running service — compose/CI check its exit code instead.
ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
