#!/usr/bin/env bash
# production-ops.sh — maintenance on the production server, run there over
# SSH by .github/workflows/production-ops.yml (manual-only).
#
# The repository and its Actions logs are public: nothing secret is ever an
# argument or printed. An admin's new password arrives only as its argon2id
# hash, and env values are reported as set / not set, never shown.
#
# Finds the production stack from the running Caddy container's Compose
# labels (the same container publish-userscript.sh uses), so it needs no
# path or project name of its own.
#
#   OPS_ACTION=diagnose     what runs where; changes nothing
#   OPS_ACTION=deploy       IMAGE_TAG=<tag>: pull the api / worker / migrator
#                           images at that tag, run the migrations, restart
#                           api + worker, check health, roll back on failure;
#                           records the tag in .env.production
#   OPS_ACTION=admin-login  HASH_B64=<base64 argon2id hash>: set the one admin
#                           account's password, unlock it, clear its 2FA
set -euo pipefail

ACTION="${OPS_ACTION:?set OPS_ACTION}"
CADDY_CONTAINER="${CADDY_CONTAINER:-sniper-ledger-prod-caddy-1}"

label() { docker inspect -f "{{ index .Config.Labels \"$1\" }}" "$CADDY_CONTAINER"; }
project="$(label com.docker.compose.project)"
config_files="$(label com.docker.compose.project.config_files)"
compose_file="${config_files%%,*}"
infra_dir="$(dirname "$compose_file")"
env_file="$infra_dir/.env.production"

dc() {
  if [ -f "$env_file" ]; then
    docker compose -p "$project" -f "$compose_file" --env-file "$env_file" "$@"
  else
    docker compose -p "$project" -f "$compose_file" "$@"
  fi
}
container() {
  docker ps -q --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$1" | head -n1
}
# psql as the database owner inside the postgres container; extra args
# (e.g. -e HASH=...) go to `docker exec`.
psql_prod() {
  local pg
  pg="$(container postgres)"
  [ -n "$pg" ] || { echo "no running postgres container in $project" >&2; exit 1; }
  docker exec -i "$@" "$pg" sh -c \
    'psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v hash="${HASH:-}"'
}
env_value() { [ -f "$env_file" ] && sed -n "s/^$1=//p" "$env_file" | tail -n1 | tr -d '"' || true; }
is_set() { [ -n "$(env_value "$1")" ] && echo set || echo 'not set'; }
api_healthy() {
  local api
  api="$(container api)"
  [ -n "$api" ] && docker exec "$api" sh -c 'wget -q --spider "http://127.0.0.1:${PORT:-3000}/health/ready"'
}

case "$ACTION" in
  diagnose)
    echo "project:        $project"
    echo "compose file:   $compose_file"
    echo "env file:       $([ -f "$env_file" ] && echo present || echo missing)"
    echo "IMAGE_TAG:      $(env_value IMAGE_TAG)"
    echo "REGISTRY:       $(env_value REGISTRY)"
    echo "api image:      $(docker inspect -f '{{.Config.Image}}' "$(container api)" 2>/dev/null || echo 'not running')"
    echo "SMTP_HOST:      $(is_set SMTP_HOST)"
    echo "MFA_ENABLED:    $(env_value MFA_ENABLED)"
    if [ -n "${REPO_COMPOSE_SHA:-}" ]; then
      server_sha="$(sha256sum "$compose_file" | cut -d' ' -f1)"
      echo "compose file matches this commit's: $([ "$server_sha" = "$REPO_COMPOSE_SHA" ] && echo yes || echo no)"
    fi
    echo "admins (with 2FA on): $(echo "SELECT count(*) || ' (' || count(totp_enabled_at) || ')' FROM users WHERE role = 'admin';" | psql_prod)"
    echo "services:"
    dc ps --format '  {{.Service}}: {{.State}} {{.Status}}' 2>/dev/null || dc ps
    ;;

  deploy)
    tag="${IMAGE_TAG:?set IMAGE_TAG}"
    old="$(env_value IMAGE_TAG)"
    echo "deploying $tag (was ${old:-unset})"
    IMAGE_TAG="$tag" dc pull api worker migrator
    IMAGE_TAG="$tag" dc run --rm migrator
    IMAGE_TAG="$tag" dc up -d api worker
    healthy=no
    for _ in $(seq 1 30); do
      if api_healthy; then healthy=yes; break; fi
      sleep 4
    done
    if [ "$healthy" != yes ]; then
      echo "api not healthy on $tag: rolling api + worker back to ${old:-the previous images}" >&2
      [ -n "$old" ] && IMAGE_TAG="$old" dc up -d api worker
      exit 1
    fi
    if [ -f "$env_file" ]; then
      if grep -q '^IMAGE_TAG=' "$env_file"; then
        sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$tag/" "$env_file"
      else
        printf 'IMAGE_TAG=%s\n' "$tag" >>"$env_file"
      fi
    fi
    echo "deployed $tag: api healthy"
    ;;

  admin-login)
    hash="$(printf '%s' "${HASH_B64:?set HASH_B64}" | base64 -d)"
    case "$hash" in
      '$argon2id$'*) ;;
      *) echo 'HASH_B64 is not an argon2id hash' >&2; exit 1 ;;
    esac
    admins="$(echo "SELECT count(*) FROM users WHERE role = 'admin';" | psql_prod)"
    if [ "$admins" != 1 ]; then
      echo "expected exactly one admin account, found $admins: nothing changed" >&2
      exit 1
    fi
    changed="$(psql_prod -e HASH="$hash" <<'SQL'
UPDATE users
   SET password_hash = :'hash',
       failed_login_count = 0,
       locked_until = NULL,
       totp_secret_enc = NULL,
       totp_enabled_at = NULL,
       email_verified_at = COALESCE(email_verified_at, now()),
       status = 'active'
 WHERE role = 'admin'
RETURNING 1;
SQL
)"
    [ "$changed" = 1 ] || { echo 'the admin account was not updated' >&2; exit 1; }
    echo 'admin password set; account unlocked; 2FA cleared'
    ;;

  *)
    echo "unknown OPS_ACTION: $ACTION" >&2
    exit 1
    ;;
esac
