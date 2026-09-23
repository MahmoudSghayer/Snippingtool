#!/usr/bin/env bash
# publish-userscript.sh — build the Tampermonkey userscript and publish it
# behind Caddy at https://dashboard.$DOMAIN/userscript/.
#
# Everyone who installed the script from that URL gets the new version on
# Tampermonkey's next update check: each build carries a fresh `@version`
# (apps/extension/scripts/build.mjs), and the `.meta.js` published next to
# it is what Tampermonkey polls.
#
# The files go into the running Caddy container's /data/userscript (the
# caddy_data volume, see infra/caddy/Caddyfile), so no restart is needed.
#
# Usage: DOMAIN=46.62.142.29.sslip.io infra/scripts/publish-userscript.sh
#   DOMAIN          required; the api./dashboard. hosts hang off it
#   CADDY_CONTAINER default sniper-ledger-prod-caddy-1
set -euo pipefail

: "${DOMAIN:?set DOMAIN, e.g. DOMAIN=46.62.142.29.sslip.io}"
caddy="${CADDY_CONTAINER:-sniper-ledger-prod-caddy-1}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
base_url="https://dashboard.${DOMAIN}/userscript"
dist="$repo/apps/extension/dist/userscript"

(
  cd "$repo/apps/extension"
  VITE_API_ORIGIN="https://api.${DOMAIN}" \
    VITE_DASHBOARD_ORIGIN="https://dashboard.${DOMAIN}" \
    USERSCRIPT_DOWNLOAD_URL="${base_url}/sniper-ledger.user.js" \
    node scripts/build.mjs userscript
)

docker exec "$caddy" mkdir -p /data/userscript
# The .user.js before the .meta.js: a client that sees the new version in the
# meta file must find the matching script already in place.
docker cp "$dist/sniper-ledger.user.js" "$caddy:/data/userscript/sniper-ledger.user.js"
docker cp "$dist/sniper-ledger.meta.js" "$caddy:/data/userscript/sniper-ledger.meta.js"

version="$(sed -n 's|^// @version *||p' "$dist/sniper-ledger.meta.js")"
echo "published ${version}"
echo "install: ${base_url}/sniper-ledger.user.js"
