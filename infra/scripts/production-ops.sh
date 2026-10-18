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
#                           its email, clear 2FA, make it a super_admin, and clear
#                           the login rate limits. The email itself is never
#                           sent or printed.
#   OPS_ACTION=ea-probe     where EA's transfer market server is (addresses,
#                           Google Cloud region) and how long reaching it
#                           takes from this server; changes nothing
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
    || ' admin_role=' || coalesce((SELECT a.admin_role::text FROM admin_users a
                                   WHERE a.user_id = u.id AND a.deleted_at IS NULL), 'none')
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
    # The admin pages are gated on an admin_users role, not just users.role.
    psql_prod -e EMAIL_SHA="$sha" >/dev/null <<SQL
INSERT INTO admin_users (user_id, admin_role)
SELECT id, 'super_admin' FROM users WHERE $match
ON CONFLICT (user_id) DO UPDATE SET admin_role = 'super_admin', deleted_at = NULL;
SQL
    rc="$(container redis)"
    if [ -n "$rc" ]; then
      cleared="$(docker exec -e REDISCLI_AUTH="$(env_value REDIS_PASSWORD)" "$rc" sh -c \
        'c="redis-cli --tls --cacert /certs/ca.crt --no-auth-warning"; $c --scan --pattern "*ratelimit:login:*" | while read -r k; do $c del "$k" >/dev/null; echo x; done | wc -l')"
      echo "login rate limits cleared: $cleared"
    fi
    echo 'password set; unlocked; email verified; 2FA cleared; admin (super_admin)'
    echo "now: $(report)"
    ;;

  session-report)
    # A user's recent Nova AI session (buy attempts, failures and their
    # speed, trades, profit), optionally for one player. The report holds
    # the user's own trading data and these logs are public, so it is
    # printed only encrypted to REPORT_PUBKEY_B64 (a PEM public key whose
    # private half never leaves the operator): an RSA-OAEP-wrapped random
    # key, then the gzipped report under AES-256-CBC with that key.
    sha="${EMAIL_SHA:?set EMAIL_SHA}"
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo 'EMAIL_SHA is not a sha256' >&2; exit 1; }
    hours="${REPORT_HOURS:-36}"
    [[ "$hours" =~ ^[0-9]{1,4}$ ]] || { echo 'REPORT_HOURS must be a number' >&2; exit 1; }
    player="${REPORT_PLAYER:-}"
    [[ "$player" =~ ^[A-Za-z0-9\ .-]{0,40}$ ]] || { echo 'REPORT_PLAYER has odd characters' >&2; exit 1; }
    command -v openssl >/dev/null || { echo 'openssl is not installed on the server' >&2; exit 1; }
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    printf '%s' "${REPORT_PUBKEY_B64:?set REPORT_PUBKEY_B64}" | base64 -d >"$work/pub.pem"
    openssl pkey -pubin -in "$work/pub.pem" -noout 2>/dev/null ||
      { echo 'REPORT_PUBKEY_B64 is not a public key' >&2; exit 1; }
    openssl rand -hex 32 >"$work/key"
    pg="$(container postgres)"
    [ -n "$pg" ] || { echo "no running postgres container in $project" >&2; exit 1; }
    docker exec -i -e EMAIL_SHA="$sha" -e HOURS="$hours" -e PLAYER="$player" "$pg" sh -c \
      'psql -X -q -v ON_ERROR_STOP=1 -P pager=off -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v email_sha="$EMAIL_SHA" -v hours="$HOURS" -v player="$PLAYER"' \
      >"$work/report.txt" 2>&1 <<'SQL' || true
\pset footer off
SELECT id AS uid, timezone AS tz FROM users
 WHERE encode(sha256(convert_to(lower(email::text), 'UTF8')), 'hex') = :'email_sha' \gset
\echo 'window: last' :hours 'hours, times in' :tz ', player filter:' :'player'
CREATE TEMP TABLE pc AS
  SELECT DISTINCT resource_id, coalesce(common_name, name) AS player, rating, card_version
    FROM cards
   WHERE :'player' <> ''
     AND (name ILIKE '%' || :'player' || '%' OR common_name ILIKE '%' || :'player' || '%');
CREATE TEMP TABLE sa AS
  SELECT s.* FROM sniping_activity s
   WHERE s.user_id = :'uid' AND s.occurred_at > now() - make_interval(hours => :hours)
     AND (:'player' = '' OR s.resource_id IN (SELECT resource_id FROM pc));
\echo
\echo '== cards matching the player'
SELECT * FROM pc ORDER BY rating DESC NULLS LAST;
\echo '== buy attempts by outcome (latency = ms from seeing the listing to EA answering the buy)'
SELECT outcome, count(*) AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::int AS p50_ms,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY latency_ms)::int AS p90_ms,
       min(latency_ms) AS min_ms, max(latency_ms) AS max_ms,
       round(avg(target_price)) AS avg_target, round(avg(listed_price)) AS avg_listed
  FROM sa GROUP BY 1 ORDER BY 2 DESC;
\echo '== failure reasons'
SELECT outcome, coalesce(error_code, '-') AS error_code, count(*) AS n
  FROM sa WHERE outcome <> 'success' GROUP BY 1, 2 ORDER BY 3 DESC;
\echo '== buy attempts by hour'
SELECT to_char(date_trunc('hour', occurred_at AT TIME ZONE :'tz'), 'Mon DD HH24:00') AS hour,
       count(*) AS attempts, count(*) FILTER (WHERE outcome = 'success') AS won,
       count(*) FILTER (WHERE outcome IN ('failed', 'too_slow')) AS lost,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::int AS p50_ms
  FROM sa GROUP BY 1 ORDER BY 1;
\echo '== latency of won vs lost buys (ms buckets)'
SELECT CASE WHEN latency_ms IS NULL THEN 'unknown'
            WHEN latency_ms < 150 THEN 'a <150' WHEN latency_ms < 300 THEN 'b 150-299'
            WHEN latency_ms < 500 THEN 'c 300-499' WHEN latency_ms < 1000 THEN 'd 500-999'
            ELSE 'e 1000+' END AS bucket,
       count(*) FILTER (WHERE outcome = 'success') AS won,
       count(*) FILTER (WHERE outcome IN ('failed', 'too_slow')) AS lost
  FROM sa GROUP BY 1 ORDER BY 1;
\echo '== searches'
WITH s AS (
  SELECT occurred_at, results_count, floor_price,
         extract(epoch FROM occurred_at - lag(occurred_at) OVER (ORDER BY occurred_at)) AS gap_s
    FROM search_activity
   WHERE user_id = :'uid' AND occurred_at > now() - make_interval(hours => :hours)
     AND (:'player' = '' OR resource_id IN (SELECT resource_id FROM pc) OR resource_id IS NULL))
SELECT count(*) AS searches,
       count(*) FILTER (WHERE results_count > 0) AS with_results,
       round(avg(results_count), 2) AS avg_results,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_s))::numeric, 2) AS median_gap_s,
       round(avg(floor_price)) AS avg_floor
  FROM s;
\echo '== trades'
SELECT to_char(t.bought_at AT TIME ZONE :'tz', 'Mon DD HH24:MI') AS bought, t.buy_price,
       t.status, t.sell_price, to_char(t.sold_at AT TIME ZONE :'tz', 'Mon DD HH24:MI') AS sold,
       t.ea_tax, t.net_profit, coalesce(pc.player, t.resource_id) AS player
  FROM trades t LEFT JOIN pc ON pc.resource_id = t.resource_id
 WHERE t.user_id = :'uid' AND t.deleted_at IS NULL
   AND (t.bought_at > now() - make_interval(hours => :hours)
        OR t.sold_at > now() - make_interval(hours => :hours))
   AND (:'player' = '' OR t.resource_id IN (SELECT resource_id FROM pc))
 ORDER BY t.bought_at;
\echo '== trade totals'
SELECT count(*) AS bought, count(*) FILTER (WHERE t.status = 'sold') AS sold,
       count(*) FILTER (WHERE t.status IN ('bought', 'listed')) AS still_held,
       sum(t.buy_price) AS spent,
       sum(t.sell_price) FILTER (WHERE t.status = 'sold') AS revenue,
       sum(t.net_profit) FILTER (WHERE t.status = 'sold') AS net_profit
  FROM trades t
 WHERE t.user_id = :'uid' AND t.deleted_at IS NULL
   AND (t.bought_at > now() - make_interval(hours => :hours)
        OR t.sold_at > now() - make_interval(hours => :hours))
   AND (:'player' = '' OR t.resource_id IN (SELECT resource_id FROM pc));
\echo '== safety governor (risk_budget_events: the bot holding itself back)'
SELECT kind, count(*) AS n, min(value) AS min_value, max(value) AS max_value,
       max(threshold) AS threshold,
       to_char(min(occurred_at) AT TIME ZONE :'tz', 'Mon DD HH24:MI') AS first,
       to_char(max(occurred_at) AT TIME ZONE :'tz', 'Mon DD HH24:MI') AS last
  FROM risk_budget_events
 WHERE user_id = :'uid' AND occurred_at > now() - make_interval(hours => :hours)
 GROUP BY 1 ORDER BY 2 DESC;
\echo '== other bot events (user_activity: errors, settings changes, other)'
SELECT type, left(metadata::text, 160) AS what, count(*) AS n,
       to_char(min(occurred_at) AT TIME ZONE :'tz', 'Mon DD HH24:MI') AS first,
       to_char(max(occurred_at) AT TIME ZONE :'tz', 'Mon DD HH24:MI') AS last
  FROM user_activity
 WHERE user_id = :'uid' AND occurred_at > now() - make_interval(hours => :hours)
   AND type IN ('error', 'settings_change', 'other', 'kill_switch_triggered')
 GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 25;
\echo '== buy attempts per resource, by outcome and error code'
SELECT s.resource_id, s.outcome, coalesce(s.error_code, '-') AS error_code, count(*) AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY s.latency_ms)::int AS p50_ms,
       round(avg(s.target_price)) AS avg_target, round(avg(s.listed_price)) AS avg_listed
  FROM sniping_activity s
 WHERE s.user_id = :'uid' AND s.occurred_at > now() - make_interval(hours => :hours)
 GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 25;
\echo '== whole window, every player (top 15 by attempts)'
SELECT coalesce(c.player, s.resource_id) AS player, count(*) AS attempts,
       count(*) FILTER (WHERE s.outcome = 'success') AS won,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY s.latency_ms)::int AS p50_ms
  FROM sniping_activity s
  LEFT JOIN LATERAL (SELECT coalesce(common_name, name) AS player FROM cards
                      WHERE cards.resource_id = s.resource_id LIMIT 1) c ON true
 WHERE s.user_id = :'uid' AND s.occurred_at > now() - make_interval(hours => :hours)
 GROUP BY 1 ORDER BY 2 DESC LIMIT 15;
SQL
    echo "encrypted report ($(wc -l <"$work/report.txt") lines)"
    echo "key: $(openssl pkeyutl -encrypt -pubin -inkey "$work/pub.pem" \
      -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -in "$work/key" | base64 -w0)"
    # gzip first: the operator copies the ciphertext out of the log by hand.
    echo "data (gzip): $(gzip -9c "$work/report.txt" |
      openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$work/key" | base64 -w0)"
    ;;

  ea-probe)
    # Where EA's transfer market server is, to choose where to run the bot:
    # what its name resolves to (also as seen from other parts of the world,
    # in case EA answers each region differently), which Google Cloud region
    # each address is in (Google's published ranges), and how long reaching
    # it takes from this server. Public facts only: this server's own
    # address is never printed.
    host=utas.mob.v4.prd.futc-ext.gcp.ea.com
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    echo "== $host, from this server"
    getent ahosts "$host" | awk '{print $1}' | sort -u | tee "$work/ips" || true
    echo
    echo "== as resolved for clients elsewhere (Google DNS, client subnet)"
    for where in 'US East=3.80.0.0/24' 'US West=13.56.0.0/24' 'Frankfurt=18.184.0.0/24' \
      'London=18.130.0.0/24' 'UAE=94.200.0.0/24' 'Saudi Arabia=37.224.0.0/24' 'Singapore=13.228.0.0/24'; do
      answer="$(curl -fsS --max-time 10 \
        "https://dns.google/resolve?name=$host&type=A&edns_client_subnet=${where#*=}" 2>/dev/null |
        grep -oE '"data": ?"[^"]+"' | sed -E 's/"data": ?"//; s/"$//' | tr '\n' ' ' || true)"
      printf '%-13s %s\n' "${where%%=*}:" "${answer:-no answer}"
      tr ' ' '\n' <<<"$answer" | grep -E '^[0-9.]+$' >>"$work/ips" || true
    done
    echo
    echo "== Google Cloud region of each address (gstatic.com/ipranges)"
    if curl -fsS --max-time 20 https://www.gstatic.com/ipranges/cloud.json -o "$work/cloud.json" &&
      curl -fsS --max-time 20 https://www.gstatic.com/ipranges/goog.json -o "$work/goog.json" &&
      command -v python3 >/dev/null; then
      mapfile -t ips < <(sort -u "$work/ips" | grep -E '^[0-9a-f.:]+$' || true)
      python3 - "$work/cloud.json" "$work/goog.json" ${ips[@]+"${ips[@]}"} <<'PY'
import ipaddress, json, sys

def prefixes(path):
    for p in json.load(open(path))["prefixes"]:
        net = p.get("ipv4Prefix") or p.get("ipv6Prefix")
        yield ipaddress.ip_network(net), p.get("scope"), p.get("service")

cloud = list(prefixes(sys.argv[1]))
goog = [n for n, _, _ in prefixes(sys.argv[2])]
for raw in sys.argv[3:]:
    ip = ipaddress.ip_address(raw)
    hits = [f"{scope} ({net}, {svc})" for net, scope, svc in cloud if ip.version == net.version and ip in net]
    if hits:
        print(f"{raw}: Google Cloud {', '.join(hits)}")
    elif any(ip.version == n.version and ip in n for n in goog):
        print(f"{raw}: Google's own network (global load balancer edge): no single region")
    else:
        print(f"{raw}: not a Google address")
PY
    else
      echo "could not fetch Google's IP ranges (or no python3 here)"
    fi
    echo
    echo "== reaching it from this server (5 tries; seconds from the start of each request)"
    for _ in 1 2 3 4 5; do
      curl -s -o /dev/null --max-time 10 \
        -w 'dns %{time_namelookup}  tcp %{time_connect}  tls %{time_appconnect}  first byte %{time_starttransfer}  (HTTP %{http_code})\n' \
        "https://$host/ut/game/fc26/" || echo 'failed'
    done
    echo
    echo "== what answers (selected response headers)"
    curl -sI --max-time 10 "https://$host/ut/game/fc26/" |
      grep -iE '^(HTTP/|server:|via:|alt-svc:|x-envoy-upstream-service-time:|x-served-by:|x-region:|x-gcp-region:)' || true
    ;;

  *)
    echo "unknown OPS_ACTION: $ACTION" >&2
    exit 1
    ;;
esac
