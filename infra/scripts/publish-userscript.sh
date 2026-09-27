#!/usr/bin/env bash
# publish-userscript.sh: publish the Tampermonkey build to the VM's
# dashboard.{$DOMAIN}/userscript/* static path (infra/caddy/Caddyfile's
# handle_path block), which serves the caddy_data Docker volume directly —
# entirely separate from the API's on-demand /api/v1/downloads/userscript
# zip, which needs no publish step (it rebuilds from the api image on every
# deploy).
#
# This script never restarts anything: it only copies two files into a
# volume a running container already serves, and Tampermonkey polls
# nova-trade.meta.js for updates on its own schedule (no-cache is set on
# that path in the Caddyfile).
#
# Usage: infra/scripts/publish-userscript.sh [--dry-run]
#
# Requires the extension to already be built for `userscript` (not
# `--template`: a live deployment ships the real API/dashboard origins and
# license key baked in, not the download-time-substituted placeholders), with
# USERSCRIPT_DOWNLOAD_URL set to this exact published URL so Tampermonkey's
# own @downloadURL/@updateURL point back at it for future update checks:
#   USERSCRIPT_DOWNLOAD_URL=https://dashboard.<DOMAIN>/userscript/nova-trade.user.js \
#     pnpm --filter @sl/extension build:userscript
#
# Reads USERSCRIPT_BUILD_DIR (default apps/extension/dist/userscript) and
# CADDY_CONTAINER (default sniper-ledger-prod-caddy-1).

set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$INFRA_DIR/.." && pwd)"
BUILD_DIR="${USERSCRIPT_BUILD_DIR:-$ROOT_DIR/apps/extension/dist/userscript}"
CONTAINER="${CADDY_CONTAINER:-sniper-ledger-prod-caddy-1}"
DEST_DIR=/data/userscript
DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

say() { printf '\n==> %s\n' "$*"; }

# --- preflight ----------------------------------------------------------------
USER_JS="$BUILD_DIR/nova-trade.user.js"
META_JS="$BUILD_DIR/nova-trade.meta.js"
for f in "$USER_JS" "$META_JS"; do
  [ -f "$f" ] || {
    echo "Missing $f — build it first: pnpm --filter @sl/extension build:userscript"
    exit 2
  }
done

VERSION="$(grep -m1 -oE '@version[[:space:]]+[^[:space:]]+' "$USER_JS" | awk '{print $2}')"
[ -n "$VERSION" ] || {
  echo "Could not read @version from $USER_JS"
  exit 2
}
say "Publishing nova-trade.user.js @version $VERSION"

docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  echo "Container $CONTAINER is not running (set CADDY_CONTAINER to override)."
  exit 2
}

if $DRY_RUN; then
  echo "  (dry run) would copy:"
  echo "    $USER_JS -> $CONTAINER:$DEST_DIR/nova-trade.user.js"
  echo "    $META_JS -> $CONTAINER:$DEST_DIR/nova-trade.meta.js"
  echo "  @version: $VERSION"
  exit 0
fi

# --- atomic publish -------------------------------------------------------
# Write to a temp name inside the destination directory (same filesystem, so
# the final `mv` is a rename, not a copy), then rename into place — a
# Tampermonkey poll landing mid-copy would otherwise see a truncated file.
# The two files are switched in this order (script body, then metadata) so
# a poll that only reads the meta file never points at a body that isn't
# there yet.
#
# Also published under the pre-rebrand legacy names
# (sniper-ledger.user.js/.meta.js), byte-identical to the nova-trade.*
# files, purely so an install pointed at the old URL keeps fetching
# something rather than 404ing. THIS DOES NOT MAKE TAMPERMONKEY TREAT IT AS
# AN UPDATE to an existing "Sniper's Ledger" install: Tampermonkey keys a
# script on @namespace + @name together, @namespace is unchanged
# (https://snipersledger.app/) but the header inside every published file
# now declares @name "Nova Trade" — a different identity — so the old
# install will not silently update itself. The only reliable path for an
# existing install is to remove it and add the new URL once.
docker exec "$CONTAINER" mkdir -p "$DEST_DIR"
STAMP="$$-$(date +%s)"

for pair in "$USER_JS:nova-trade.user.js" "$META_JS:nova-trade.meta.js" "$USER_JS:sniper-ledger.user.js" "$META_JS:sniper-ledger.meta.js"; do
  src="${pair%%:*}"
  name="${pair##*:}"
  tmp="$DEST_DIR/.$name.$STAMP.tmp"
  docker cp "$src" "$CONTAINER:$tmp"
  docker exec "$CONTAINER" mv -f "$tmp" "$DEST_DIR/$name"
done

say "Published. @version $VERSION is live at dashboard.{\$DOMAIN}/userscript/nova-trade.user.js (and the legacy sniper-ledger.* names, see the note above)."
