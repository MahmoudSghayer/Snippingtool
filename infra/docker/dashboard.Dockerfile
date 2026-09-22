# syntax=docker/dockerfile:1.7
#
# Static build of @sl/dashboard (React + Vite), served by nginx. This image
# is for SELF-HOSTING only — Vercel (see /vercel.json) is the primary
# dashboard host; this Dockerfile exists for infra/docker-compose.*.yml's
# single-VM deployment path documented in docs/11-devops.md.
# Build context MUST be the repo root.
#
# Build args:
#   VITE_API_ORIGIN  baked into the static bundle at build time (Vite only
#                     reads import.meta.env.VITE_* at build time, not
#                     runtime) — the origin the dashboard calls for the API.
#   BUILD_DATE / VCS_REF / VERSION  OCI labels, set by CI.

ARG NODE_VERSION=22-alpine
ARG PNPM_VERSION=12.5.1
ARG NGINX_BROTLI_TAG=v1.28.3

# ---------------------------------------------------------------------------
# build — same whole-workspace-install pattern as api.Dockerfile, for the
# same frozen-lockfile reason.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
ARG PNPM_VERSION
ARG VITE_API_ORIGIN=https://api.example.com
ENV VITE_API_ORIGIN=${VITE_API_ORIGIN}
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@sl/dashboard...

# ---------------------------------------------------------------------------
# runtime — nginx compiled with brotli (fholzer/nginx-brotli; stock
# nginx:alpine has no brotli module) serving the prebuilt static bundle.
# Runs fully non-root: nginx listens on 8080 and every path it writes to
# (pid, client body temp, cache) is owned by the `sl` user, so the master
# process never needs root the way port-80 nginx normally would.
# ---------------------------------------------------------------------------
FROM fholzer/nginx-brotli:${NGINX_BROTLI_TAG} AS runtime
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="sniper-ledger-dashboard" \
      org.opencontainers.image.description="The Sniper's Ledger — dashboard static build, self-host nginx image (Vercel is the primary host)" \
      org.opencontainers.image.vendor="The Sniper's Ledger" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/sniper-ledger/sniper-ledger"

RUN addgroup -g 10001 sl \
 && adduser -D -H -u 10001 -G sl sl \
 && rm -rf /usr/share/nginx/html/* \
 && mkdir -p /var/cache/nginx/client_temp /var/cache/nginx/proxy_temp \
      /var/cache/nginx/fastcgi_temp /var/cache/nginx/uwsgi_temp /var/cache/nginx/scgi_temp \
 && chown -R sl:sl /var/cache/nginx /usr/share/nginx/html /etc/nginx

COPY --chown=sl:sl infra/docker/dashboard.nginx.conf /etc/nginx/nginx.conf
COPY --from=build --chown=sl:sl /repo/apps/dashboard/dist /usr/share/nginx/html

USER sl
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:8080/healthz || exit 1
STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
