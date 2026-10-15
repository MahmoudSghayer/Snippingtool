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
#   OPS_ACTION=deploy       DEPLOY_SHA=<commit on main>: fast-forward the
#                           server's checkout to it and run vm-deploy.sh
#                           (backup, rollback tags, build, migrate, restart)
#   OPS_ACTION=admin-login  HASH_B64=<base64 argon2id hash>: set the one admin
#                           account's password, unlock it, clear its 2FA
#   OPS_ACTION=account      EMAIL_SHA=<sha256 hex of the lowercased email>:
#                           report why that account can't log in; with
#                           HASH_B64 also set its password, unlock it, verify
#                           its email, clear 2FA, make it the admin, and clear
#                           the login rate limits. The email itself is never
#                           sent or printed.
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
    'psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v hash="${HASH:-}" -v email_sha="${EMAIL_SHA:-}"'
}
env_value() { [ -f "$env_file" ] && sed -n "s/^$1=//p" "$env_file" | tail -n1 | tr -d '"' || true; }
is_set() { [ -n "$(env_value "$1")" ] && echo set || echo 'not set'; }

case "$ACTION" in
  diagnose)
    echo "project:        $project"
    echo "compose file:   $compose_file"
    echo "env file:       $([ -f "$env_file" ] && echo present || echo missing)"
    echo "checkout:       $(git -C "$infra_dir/.." log -1 --format='%h %s' 2>/dev/null || echo 'not a git checkout')"
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
    # The documented deploy (docs/runbooks/go-live.md): bring the server's
    # checkout up to the commit, then infra/scripts/vm-deploy.sh, which backs
    # up Postgres, tags the running images for rollback, builds, migrates,
    # restarts and checks health.
    want="${DEPLOY_SHA:?set DEPLOY_SHA}"
    cd "$infra_dir/.."
    echo "checkout was: $(git log -1 --format='%h %s')"
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
      git status --short --untracked-files=no
      echo 'the checkout has local changes: nothing changed' >&2
      exit 1
    fi
    git fetch -q "${REPO_URL:-https://github.com/MahmoudSghayer/Snippingtool.git}" main
    git merge -q --ff-only "$want" || { echo "can't fast-forward to $want: nothing changed" >&2; exit 1; }
    echo "checkout now: $(git log -1 --format='%h %s')"
    infra/scripts/vm-deploy.sh --yes
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

  account)
    sha="${EMAIL_SHA:?set EMAIL_SHA}"
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo 'EMAIL_SHA is not a sha256' >&2; exit 1; }
    match="encode(sha256(convert_to(lower(email::text), 'UTF8')), 'hex') = :'email_sha'"
    report() {
      psql_prod -e EMAIL_SHA="$sha" <<SQL
SELECT 'account: role=' || role || ' status=' || status
    || ' email_verified=' || (email_verified_at IS NOT NULL)
    || ' locked=' || (locked_until IS NOT NULL AND locked_until > now())
    || ' failed_logins=' || failed_login_count
    || ' 2fa=' || (totp_enabled_at IS NOT NULL)
    || ' pw=' || left(md5(password_hash), 8)
    || ' account_bans=' || (SELECT count(*) FROM bans b
                             WHERE b.user_id = u.id AND b.lifted_at IS NULL)
  FROM users u WHERE $match;
SQL
    }
    found="$(report)"
    echo "${found:-account: no user with that email}"
    echo "admins: $(echo "SELECT count(*) || ' (this email: ' || count(*) FILTER (WHERE $match) || ')' FROM users WHERE role = 'admin';" | psql_prod -e EMAIL_SHA="$sha")"
    api="$(container api)"
    if [ -n "$api" ]; then
      echo 'login responses, last 3h:'
      docker logs --since 3h "$api" 2>&1 | grep '/api/v1/auth/login' \
        | grep -o '"statusCode":[0-9]*' | sort | uniq -c || true
      echo 'error codes, last 3h:'
      docker logs --since 3h "$api" 2>&1 | grep -o '"code":"[A-Z_]*"' | sort | uniq -c || true
    fi
    [ -n "${HASH_B64:-}" ] || exit 0
    [ -n "$found" ] || { echo 'no such account: nothing changed' >&2; exit 1; }

    hash="$(printf '%s' "$HASH_B64" | base64 -d)"
    case "$hash" in
      '$argon2id$'*) ;;
      *) echo 'HASH_B64 is not an argon2id hash' >&2; exit 1 ;;
    esac
    changed="$(psql_prod -e HASH="$hash" -e EMAIL_SHA="$sha" <<SQL
UPDATE users
   SET password_hash = :'hash',
       failed_login_count = 0,
       locked_until = NULL,
       totp_secret_enc = NULL,
       totp_enabled_at = NULL,
       email_verified_at = COALESCE(email_verified_at, now()),
       status = 'active',
       role = 'admin'
 WHERE $match
RETURNING 1;
SQL
)"
    [ "$changed" = 1 ] || { echo 'the account was not updated' >&2; exit 1; }
    rc="$(container redis)"
    if [ -n "$rc" ]; then
      cleared="$(docker exec -e REDISCLI_AUTH="$(env_value REDIS_PASSWORD)" "$rc" sh -c \
        'c="redis-cli --tls --cacert /certs/ca.crt --no-auth-warning"; $c --scan --pattern "*ratelimit:login:*" | while read -r k; do $c del "$k" >/dev/null; echo x; done | wc -l')"
      echo "login rate limits cleared: $cleared"
    fi
    echo 'password set; unlocked; email verified; 2FA cleared; admin'
    echo "now: $(report)"
    ;;

  *)
    echo "unknown OPS_ACTION: $ACTION" >&2
    exit 1
    ;;
esac
