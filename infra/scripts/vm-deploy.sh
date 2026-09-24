#!/usr/bin/env bash
# vm-deploy.sh: deploy the checked-out code to the production VM.
#
# Production runs images built on this machine
# (docker-compose.prod.yml + docker-compose.localbuild.yml, project
# `sniper-ledger-prod`). This script is the whole deploy, in the order that's
# safe to interrupt:
#
#   1. preflight   compose config valid, required settings present
#   2. backup      a fresh Postgres backup (uploaded to S3 when configured)
#   3. rollback    tags the images running now as local/<name>:rollback-<stamp>
#   4. build       api, worker, migrator, dashboard, backup from this checkout
#   5. migrate     applies pending migrations (additive; see the runbook)
#   6. start       recreates whatever changed; Caddy, Postgres and Redis keep
#                  running because their config didn't change
#   7. verify      waits for the API to be healthy and checks the plans
#
# Undo with: infra/scripts/vm-rollback.sh <stamp>   (the stamp is printed)
#
# Usage: infra/scripts/vm-deploy.sh [--yes]
#   --yes   don't ask before building and migrating
# Full procedure, including the Vercel side: docs/runbooks/go-live.md

set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$INFRA_DIR/.env.production"
PROJECT=sniper-ledger-prod
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
IMAGES=(api worker db-migrator dashboard)
ASSUME_YES=false
[ "${1:-}" = "--yes" ] && ASSUME_YES=true

compose() {
  docker compose -p "$PROJECT" \
    -f "$INFRA_DIR/docker-compose.prod.yml" \
    -f "$INFRA_DIR/docker-compose.localbuild.yml" \
    --env-file "$ENV_FILE" "$@"
}
say() { printf '\n==> %s\n' "$*"; }
env_value() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }

confirm() {
  $ASSUME_YES && return 0
  read -r -p "$1 [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || { echo "Stopped."; exit 1; }
}

# --- 1. preflight -------------------------------------------------------------
say "Preflight"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 2; }
compose config -q
for required in APP_ORIGIN DASHBOARD_ORIGIN POSTGRES_PASSWORD JWT_PRIVATE_KEY ENTITLEMENT_SIGNING_KEY; do
  [ -n "$(env_value "$required")" ] || { echo "$required is empty in $ENV_FILE"; exit 2; }
done
for optional in ALERT_DISCORD_WEBHOOK_URL PAYMENTS_DISCORD_WEBHOOK_URL BACKUP_S3_REMOTE; do
  [ -n "$(env_value "$optional")" ] || echo "  note: $optional is empty (the deploy works; that feature stays off)"
done
echo "  API:       $(env_value APP_ORIGIN)"
echo "  Dashboard: $(env_value DASHBOARD_ORIGIN)"
echo "  Code:      $(git -C "$INFRA_DIR/.." log -1 --format='%h %s')"
if ! git -C "$INFRA_DIR/.." diff --quiet -- apps packages infra/docker; then
  echo "  warning: the checkout has uncommitted changes under apps/, packages/ or infra/docker/;"
  echo "           they will be built into the images."
fi
confirm "Deploy this code to production?"

# --- 2. backup ----------------------------------------------------------------
say "Backing up Postgres"
docker exec "$PROJECT-backup-1" /app/pg-backup.sh

# --- 3. rollback tags ---------------------------------------------------------
say "Tagging the running images for rollback ($STAMP)"
for image in "${IMAGES[@]}"; do
  if docker image inspect "local/$image:local" >/dev/null 2>&1; then
    docker tag "local/$image:local" "local/$image:rollback-$STAMP"
    echo "  local/$image:rollback-$STAMP"
  fi
done
echo "$STAMP" > "$INFRA_DIR/.last-rollback-stamp"

# --- 4. build -----------------------------------------------------------------
say "Building images"
compose build api worker migrator dashboard backup

# --- 5. migrate ---------------------------------------------------------------
say "Applying migrations"
compose --profile migrate run --rm migrator

# --- 6. start -----------------------------------------------------------------
say "Starting the new version"
compose up -d --no-build

# --- 7. verify ----------------------------------------------------------------
say "Waiting for the API"
for _ in $(seq 1 40); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-api-1" 2>/dev/null || echo missing)"
  [ "$status" = healthy ] && break
  sleep 3
done
[ "$status" = healthy ] || { echo "API is $status. Roll back with: infra/scripts/vm-rollback.sh $STAMP"; exit 1; }

api="$(env_value APP_ORIGIN)"
curl -fsS "$api/health/ready" >/dev/null && echo "  /health/ready ok"
if curl -fsS "$api/api/v1/plans" | grep -q '"Monthly"'; then
  echo "  plans ok (Monthly is listed)"
else
  echo "  warning: /api/v1/plans doesn't list Monthly; check that migration 0031 ran"
fi

say "Deployed. To undo: infra/scripts/vm-rollback.sh $STAMP"
