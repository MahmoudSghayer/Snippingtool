#!/usr/bin/env bash
# vm-rollback.sh: put back the images vm-deploy.sh tagged before a deploy.
#
# Usage: infra/scripts/vm-rollback.sh [stamp]
#   stamp  printed by vm-deploy.sh; defaults to the last deploy's
#
# Only the application images are rolled back (api, worker, dashboard).
# Migrations are not: every migration in a release is additive (new tables
# and columns, repriced plan rows), so the previous code runs on the newer
# schema. docs/runbooks/go-live.md lists what each release's migrations do.

set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$INFRA_DIR/.env.production"
PROJECT=sniper-ledger-prod
STAMP="${1:-$(cat "$INFRA_DIR/.last-rollback-stamp" 2>/dev/null || true)}"
[ -n "$STAMP" ] || { echo "usage: $0 <stamp>   (no previous deploy recorded)"; exit 2; }

for image in api worker dashboard; do
  docker image inspect "local/$image:rollback-$STAMP" >/dev/null 2>&1 \
    || { echo "local/$image:rollback-$STAMP not found"; exit 2; }
done

echo "Rolling back api, worker and dashboard to $STAMP"
for image in api worker dashboard; do
  docker tag "local/$image:rollback-$STAMP" "local/$image:local"
done

docker compose -p "$PROJECT" \
  -f "$INFRA_DIR/docker-compose.prod.yml" \
  -f "$INFRA_DIR/docker-compose.localbuild.yml" \
  --env-file "$ENV_FILE" \
  up -d --no-build --no-deps api worker dashboard

echo "Done. Check: docker ps --filter name=$PROJECT-api"
