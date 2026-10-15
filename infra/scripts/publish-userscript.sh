#!/usr/bin/env bash
# publish-userscript.sh: publish the Tampermonkey userscript on the VM, to
# both places installs update from:
#
#   1. dashboard.{$DOMAIN}/userscript/* — a static path (infra/caddy/
#      Caddyfile's handle_path block) that Caddy serves from the caddy_data
#      Docker volume. Gets the `userscript` build.
#   2. The API's per-user download behind the dashboard's install button,
#      GET /api/v1/downloads/userscript/:token/nova-trade.user.js, and the
#      nova-trade.meta.js next to it that Tampermonkey polls. The API fills
#      in a `userscript --template` build per request
#      (apps/api/src/lib/extension-download.ts). This script installs that
#      template into the host directory the api containers mount read-only
#      at /app/downloads/userscript-published, their USERSCRIPT_TEMPLATE_DIR
#      (infra/docker-compose.prod.yml), and the API serves the new file from
#      its next request on. While that directory is empty, the API serves
#      the template baked into its image.
#
# .github/workflows/publish-userscript.yml runs this on the VM on every push
# to main that changes the userscript; running it by hand still works.
#
# This script never restarts or recreates anything: it only swaps files into
# a volume and a directory that running containers already serve, and
# Tampermonkey polls nova-trade.meta.js for updates on its own schedule
# (no-cache is set on that path in the Caddyfile; the API sends no-store).
# If the api containers don't mount the template directory yet, it installs
# the template there anyway and warns: recreating them once, so they get the
# mount, is left to the operator (docs/11-devops.md, "Publishing the
# userscript", says why and how).
#
# Usage: infra/scripts/publish-userscript.sh [--dry-run]
#
# Requires both builds, with the same @version. The `userscript` build (not
# `--template`: a live deployment ships the real API/dashboard origins and
# license key baked in), with USERSCRIPT_DOWNLOAD_URL set to this exact
# published URL so Tampermonkey's own @downloadURL/@updateURL point back at
# it for future update checks; then the template, given that build's
# @version (build.mjs stamps the first; the template takes the bare package
# version unless told otherwise):
#   USERSCRIPT_DOWNLOAD_URL=https://dashboard.<DOMAIN>/userscript/nova-trade.user.js \
#     pnpm --filter @sl/extension build:userscript
#   USERSCRIPT_VERSION=<its @version> pnpm --filter @sl/extension build:userscript-template
#
# Reads USERSCRIPT_BUILD_DIR (default apps/extension/dist/userscript),
# USERSCRIPT_TEMPLATE_BUILD_DIR (default apps/extension/dist/userscript-template)
# and CADDY_CONTAINER (default sniper-ledger-prod-caddy-1).

set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$INFRA_DIR/.." && pwd)"
BUILD_DIR="${USERSCRIPT_BUILD_DIR:-$ROOT_DIR/apps/extension/dist/userscript}"
TEMPLATE_BUILD_DIR="${USERSCRIPT_TEMPLATE_BUILD_DIR:-$ROOT_DIR/apps/extension/dist/userscript-template}"
CONTAINER="${CADDY_CONTAINER:-sniper-ledger-prod-caddy-1}"
DEST_DIR=/data/userscript
# Where the api containers read the template (USERSCRIPT_TEMPLATE_DIR in
# docker-compose.prod.yml), and the host directory that file mounts there.
# The host directory is read from the running containers' mount whenever
# they have it, so this writes exactly where the API reads; the default is
# for before they do, and matches the compose file.
TEMPLATE_MOUNT=/app/downloads/userscript-published
TEMPLATE_HOST_DIR_DEFAULT=/var/lib/nova-trade/userscript-template
TOKEN_PLACEHOLDER=NOVA_USERSCRIPT_TOKEN_PLACEHOLDER
DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

say() { printf '\n==> %s\n' "$*"; }
# A warning, which the publish workflow shows as an annotation on its run.
warn() {
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::warning title=userscript publish::$*"
  else
    echo "WARNING: $*"
  fi
}
version_of() { grep -m1 -oE '@version[[:space:]]+[^[:space:]]+' "$1" | awk '{print $2}' || true; }

# --- preflight ----------------------------------------------------------------
USER_JS="$BUILD_DIR/nova-trade.user.js"
META_JS="$BUILD_DIR/nova-trade.meta.js"
TEMPLATE_JS="$TEMPLATE_BUILD_DIR/nova-trade.user.js"
TEMPLATE_META_JS="$TEMPLATE_BUILD_DIR/nova-trade.meta.js"
for f in "$USER_JS" "$META_JS"; do
  [ -f "$f" ] || {
    echo "Missing $f — build it first: pnpm --filter @sl/extension build:userscript"
    exit 2
  }
done
for f in "$TEMPLATE_JS" "$TEMPLATE_META_JS"; do
  [ -f "$f" ] || {
    echo "Missing $f — build it first: USERSCRIPT_VERSION=<the script's @version> pnpm --filter @sl/extension build:userscript-template"
    exit 2
  }
done

VERSION="$(version_of "$USER_JS")"
[ -n "$VERSION" ] || {
  echo "Could not read @version from $USER_JS"
  exit 2
}
# Tampermonkey only updates to a higher @version. A template built without
# USERSCRIPT_VERSION carries the bare package version, which installs from
# the dashboard already have, so they would stop updating again.
TEMPLATE_VERSION="$(version_of "$TEMPLATE_JS")"
[ "$TEMPLATE_VERSION" = "$VERSION" ] || {
  echo "$TEMPLATE_JS has @version ${TEMPLATE_VERSION:-(none)}, but the script has $VERSION."
  echo "Rebuild it: USERSCRIPT_VERSION=$VERSION pnpm --filter @sl/extension build:userscript-template"
  exit 2
}
grep -q "$TOKEN_PLACEHOLDER" "$TEMPLATE_JS" || {
  echo "$TEMPLATE_JS is not a --template build (it has no download token placeholder)."
  exit 2
}
say "Publishing nova-trade.user.js @version $VERSION"

docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  echo "Container $CONTAINER is not running (set CADDY_CONTAINER to override)."
  exit 2
}

# The api containers of Caddy's compose project, and the host directory they
# mount at $TEMPLATE_MOUNT.
PROJECT="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER")"
API_CONTAINERS=()
if [ -n "$PROJECT" ]; then
  mapfile -t API_CONTAINERS < <(docker ps -q \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter label=com.docker.compose.service=api)
fi
MOUNTED=()
UNMOUNTED=()
TEMPLATE_HOST_DIR=""
for c in ${API_CONTAINERS[@]+"${API_CONTAINERS[@]}"}; do
  src="$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$TEMPLATE_MOUNT\"}}{{.Source}}{{end}}{{end}}" "$c")"
  if [ -z "$src" ]; then
    UNMOUNTED+=("$c")
    continue
  fi
  if [ -n "$TEMPLATE_HOST_DIR" ] && [ "$src" != "$TEMPLATE_HOST_DIR" ]; then
    echo "The api containers mount different directories at $TEMPLATE_MOUNT ($TEMPLATE_HOST_DIR and $src)."
    exit 2
  fi
  TEMPLATE_HOST_DIR="$src"
  MOUNTED+=("$c")
done
TEMPLATE_HOST_DIR="${TEMPLATE_HOST_DIR:-$TEMPLATE_HOST_DIR_DEFAULT}"
ONE_TIME_STEP="once, from the VM's checkout of a docker-compose.prod.yml that mounts it (the stack vm-deploy.sh deploys): docker compose -p ${PROJECT:-sniper-ledger-prod} -f infra/docker-compose.prod.yml -f infra/docker-compose.localbuild.yml --env-file infra/.env.production up -d --no-build api. The next deploy does it too; see docs/11-devops.md, \"Publishing the userscript\"."

if $DRY_RUN; then
  echo "  (dry run) would copy:"
  echo "    $USER_JS -> $CONTAINER:$DEST_DIR/nova-trade.user.js"
  echo "    $META_JS -> $CONTAINER:$DEST_DIR/nova-trade.meta.js"
  echo "    $TEMPLATE_JS -> $TEMPLATE_HOST_DIR/nova-trade.user.js"
  echo "    $TEMPLATE_META_JS -> $TEMPLATE_HOST_DIR/nova-trade.meta.js"
  echo "  api containers serving that template directory: ${#MOUNTED[@]}; not mounting it yet: ${#UNMOUNTED[@]}"
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
say "Published to dashboard.{\$DOMAIN}/userscript/nova-trade.user.js (and the legacy sniper-ledger.* names, see the note above)."

# --- the API's template -----------------------------------------------------
# Installed through a short-lived container: once Docker has created the
# host directory for the bind mount it belongs to root, and the user running
# this only needs to be able to run docker. The image is the Caddy
# container's, which is on the host already and has a shell, so nothing is
# pulled; the container gets no network.
#
# The same swap as above: both files are written into a temporary directory
# inside the mounted directory (the same filesystem), then each is renamed
# over the live one, so the API reads either the old file or the new one,
# never part of one. The API only reads nova-trade.user.js (it cuts meta.js
# out of that file's header), so that one rename is the whole switch. The
# mounted directory itself is never replaced by renaming a new one over it:
# a bind mount stays attached to the directory it was set up with, so the
# containers would keep seeing the old one. A leftover temporary directory
# from an interrupted run is cleared first; the API never looks inside one.
say "Installing the API's userscript template in $TEMPLATE_HOST_DIR"
HELPER_IMAGE="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
TEMPLATE_SRC="$(cd "$TEMPLATE_BUILD_DIR" && pwd)"
docker run --rm --network none --user 0:0 \
  -v "$TEMPLATE_HOST_DIR:/dest" -v "$TEMPLATE_SRC:/src:ro" \
  --entrypoint /bin/sh "$HELPER_IMAGE" -c '
    set -eu
    rm -rf /dest/.incoming-*
    tmp="/dest/.incoming-$1"
    trap "rm -rf \"\$tmp\"" EXIT
    mkdir "$tmp"
    cp /src/nova-trade.user.js /src/nova-trade.meta.js "$tmp/"
    chmod 0644 "$tmp/nova-trade.user.js" "$tmp/nova-trade.meta.js"
    chmod 0755 /dest
    mv -f "$tmp/nova-trade.user.js" /dest/nova-trade.user.js
    mv -f "$tmp/nova-trade.meta.js" /dest/nova-trade.meta.js
  ' sh "$STAMP"

# Check that every api container that mounts the directory now sees the new
# file, which is what its next download and update check will serve.
for c in ${MOUNTED[@]+"${MOUNTED[@]}"}; do
  seen="$(docker exec "$c" grep -m1 -E '^// @version' "$TEMPLATE_MOUNT/nova-trade.user.js" | awk '{print $3}' || true)"
  [ "$seen" = "$VERSION" ] || {
    echo "api container $c sees @version ${seen:-(none)} in $TEMPLATE_MOUNT, not $VERSION."
    exit 1
  }
done

if [ ${#API_CONTAINERS[@]} -eq 0 ]; then
  warn "No running api container found in compose project '${PROJECT:-?}'. The template is installed in $TEMPLATE_HOST_DIR, which docker-compose.prod.yml mounts into the api service, so it is served once the api is up with that file."
elif [ ${#MOUNTED[@]} -eq 0 ]; then
  warn "The api containers don't mount $TEMPLATE_HOST_DIR yet, so the dashboard's install links still serve the template baked into the API image (no updates). The new template is installed there; to serve it, recreate the api containers $ONE_TIME_STEP"
elif [ ${#UNMOUNTED[@]} -gt 0 ]; then
  warn "${#UNMOUNTED[@]} of ${#API_CONTAINERS[@]} api containers don't mount $TEMPLATE_HOST_DIR yet and still serve the template baked into the API image. Recreate them $ONE_TIME_STEP"
else
  say "Published. @version $VERSION is live at dashboard.{\$DOMAIN}/userscript/nova-trade.user.js and behind the dashboard's install links (${#MOUNTED[@]} api container(s) serve it from $TEMPLATE_HOST_DIR)."
fi
