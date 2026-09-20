# syntax=docker/dockerfile:1.7
#
# Caddy + the caddy-ratelimit plugin (edge rate limiting, `rate_limit`
# directive used by infra/caddy/Caddyfile — not built into Caddy core, so
# the stock caddy:2.9-alpine image can't run that Caddyfile as-is). Build
# context can be repo root or infra/ — this Dockerfile copies nothing else
# in, only builds the binary.

ARG CADDY_VERSION=2.9
ARG CADDY_RATELIMIT_VERSION=v0.2.1

FROM caddy:${CADDY_VERSION}-builder-alpine AS build
ARG CADDY_RATELIMIT_VERSION
RUN xcaddy build \
    --with github.com/mholt/caddy-ratelimit@${CADDY_RATELIMIT_VERSION}

FROM caddy:${CADDY_VERSION}-alpine AS runtime
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="sniper-ledger-caddy" \
      org.opencontainers.image.description="Caddy reverse proxy (+ caddy-ratelimit) fronting api/dashboard for the single-VM deployment" \
      org.opencontainers.image.vendor="The Sniper's Ledger" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/sniper-ledger/sniper-ledger"
COPY --from=build /usr/bin/caddy /usr/bin/caddy
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["caddy", "version"]
