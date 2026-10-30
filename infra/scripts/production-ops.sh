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
#   OPS_ACTION=trader-report EMAIL_SHA=... REPORT_PUBKEY_B64=... [REPORT_HOURS]
#                           a trader's whole Nova AI picture over the window
#                           (profit per player, the market by hour and day
#                           in REPORT_TZ, default Asia/Jerusalem, pace, risk
#                           signals, settings), as CSV sections, encrypted
#                           like session-report
#   OPS_ACTION=gallery-report [EMAIL_SHA=...] REPORT_PUBKEY_B64=... [REPORT_HOURS]
#                           [REPORT_TZ]: a trader's whole Gallery mode picture
#                           (the list, every Set's progress, the completed
#                           Sets newest first, the cards uncompleted Sets
#                           still need, the window's buys, the completed
#                           log); EMAIL_SHA empty = the trader most recently
#                           active. Encrypted like session-report
#   OPS_ACTION=admin-panels the data behind the admin dashboard's Overview,
#                           Activity and System pages (row counts, latest
#                           timestamps, versions) and the API's failed
#                           /api/v1/admin/ requests; counts and versions
#                           only, never an email, IP or user id; changes
#                           nothing
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
# Prints "$1/report.txt" encrypted to "$1/pub.pem" (session-report,
# trader-report): an RSA-OAEP-wrapped random key ("$1/key"), then the
# gzipped report under AES-256-CBC with that key.
print_encrypted_report() {
  echo "encrypted report ($(wc -l <"$1/report.txt") lines)"
  echo "key: $(openssl pkeyutl -encrypt -pubin -inkey "$1/pub.pem" \
    -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -in "$1/key" | base64 -w0)"
  # gzip first: the operator copies the ciphertext out of the log by hand.
  echo "data (gzip): $(gzip -9c "$1/report.txt" |
    openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$1/key" | base64 -w0)"
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
\echo '== buy attempts by outcome (latency = round trip of the buy request to EA, ms)'
SELECT outcome, count(*) AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::int AS p50_ms,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY latency_ms)::int AS p90_ms,
       min(latency_ms) AS min_ms, max(latency_ms) AS max_ms,
       round(avg(target_price)) AS avg_target, round(avg(listed_price)) AS avg_listed
  FROM sa GROUP BY 1 ORDER BY 2 DESC;
\echo '== where the time went before each buy, ms (Nova AI bot builds that report it)'
\echo '   search = search sent -> listing arrived; react = listing arrived -> buy sent; buy = buy round trip'
SELECT outcome, count(search_ms) AS timed,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY search_ms)::int AS search_p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY search_ms)::int AS search_p90,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY reaction_ms)::int AS react_p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY reaction_ms)::int AS react_p90,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::int AS buy_p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY latency_ms)::int AS buy_p90
  FROM sa WHERE outcome <> 'blocked' GROUP BY 1 ORDER BY 2 DESC;
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
\echo '== search pace per hour (Nova AI bot builds that report it, every 2 minutes)'
\echo '   pct_* = share of the time spent in the search delay, EA backoff, a limit, a break or rest, the pause after a buy'
WITH p AS (
  SELECT occurred_at, metadata->'bot' AS b
    FROM user_activity
   WHERE user_id = :'uid' AND type = 'heartbeat' AND metadata ? 'bot'
     AND occurred_at > now() - make_interval(hours => :hours))
SELECT to_char(date_trunc('hour', occurred_at AT TIME ZONE :'tz'), 'Mon DD HH24:00') AS hour,
       sum((b->>'searches')::int) AS searches,
       round(sum((b->>'searches')::numeric) * 60000 / nullif(sum((b->>'windowMs')::numeric), 0), 1) AS per_min,
       sum((b->>'withResults')::int) AS with_results,
       sum((b->>'failed')::int) AS failed,
       round(avg((b->>'searchMsP50')::numeric)) AS search_p50_ms,
       max((b->>'searchMsP90')::int) AS search_p90_max_ms,
       round(100 * sum((b->>'waitingMs')::numeric) / nullif(sum((b->>'windowMs')::numeric), 0)) AS pct_delay,
       round(100 * sum((b->>'backoffMs')::numeric) / nullif(sum((b->>'windowMs')::numeric), 0)) AS pct_backoff,
       round(100 * sum((b->>'blockedMs')::numeric) / nullif(sum((b->>'windowMs')::numeric), 0)) AS pct_limit,
       round(100 * sum((b->>'breakMs')::numeric) / nullif(sum((b->>'windowMs')::numeric), 0)) AS pct_break,
       round(100 * sum((b->>'cooldownMs')::numeric) / nullif(sum((b->>'windowMs')::numeric), 0)) AS pct_cooldown
  FROM p GROUP BY 1 ORDER BY 1;
\echo '== searches that found listings (searches with none are only in the pace above)'
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
\echo
\echo '== Gallery mode: the account''s saved list (not a snapshot in time; the whole current list)'
\echo '   collected = a card that is through your club (in the club, listed, or owned already); to_buy = still to find/buy; skipped = none listed yet'
WITH g AS (SELECT state AS st FROM user_gallery WHERE user_id = :'uid'),
     cd AS (SELECT jsonb_array_elements(coalesce((SELECT st FROM g) -> 'cards', '[]'::jsonb)) AS c),
     st AS (SELECT jsonb_array_elements(coalesce((SELECT st FROM g) -> 'sets', '[]'::jsonb)) AS s),
     cp AS (SELECT jsonb_array_elements_text(coalesce((SELECT st FROM g) -> 'completed', '[]'::jsonb)) AS cid)
SELECT s ->> 'name' AS set, s ->> 'grade' AS grade,
       (SELECT count(*) FROM cd WHERE c -> 'setIds' @> to_jsonb((s ->> 'id')::bigint) AND c ->> 'status' IN ('owned', 'club', 'listed')) AS collected,
       (SELECT count(*) FROM cd WHERE c -> 'setIds' @> to_jsonb((s ->> 'id')::bigint)) AS total,
       (SELECT count(*) FROM cd WHERE c -> 'setIds' @> to_jsonb((s ->> 'id')::bigint) AND c ->> 'status' = 'todo') AS to_buy,
       (SELECT count(*) FROM cd WHERE c -> 'setIds' @> to_jsonb((s ->> 'id')::bigint) AND c ->> 'status' = 'skipped') AS skipped,
       EXISTS (SELECT 1 FROM cp WHERE cid = s ->> 'id') AS completed
  FROM st ORDER BY completed, set;
\echo '== Gallery list totals'
WITH g AS (SELECT state AS st FROM user_gallery WHERE user_id = :'uid'),
     cd AS (SELECT jsonb_array_elements(coalesce((SELECT st FROM g) -> 'cards', '[]'::jsonb)) AS c)
SELECT jsonb_array_length(coalesce((SELECT st FROM g) -> 'sets', '[]'::jsonb)) AS sets_on_list,
       jsonb_array_length(coalesce((SELECT st FROM g) -> 'completed', '[]'::jsonb)) AS sets_completed,
       count(*) FILTER (WHERE c ->> 'status' IN ('owned', 'club', 'listed')) AS cards_collected,
       count(*) FILTER (WHERE c ->> 'status' = 'todo') AS cards_to_buy,
       count(*) FILTER (WHERE c ->> 'status' = 'skipped') AS cards_skipped,
       count(*) AS cards_total,
       (SELECT st FROM g) ->> 'spent' AS spent,
       (SELECT st FROM g) ->> 'budget' AS budget
  FROM cd;
SQL
    print_encrypted_report "$work"
    ;;

  trader-report)
    # Everything a trader can learn from their own Nova AI history, for the
    # operator to turn into a report: profit and speed per player (named
    # from the player picked in the Nova AI page's recent searches, else
    # the cards catalogue), the market by hour of day and day of week in
    # REPORT_TZ, pace and the time the bot spends waiting, EA's limit
    # codes, the safety governor, settings and their changes, bot errors.
    # CSV sections ("## name" lines between them). It is the user's own
    # trading data, so encrypted exactly like session-report.
    sha="${EMAIL_SHA:?set EMAIL_SHA}"
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo 'EMAIL_SHA is not a sha256' >&2; exit 1; }
    hours="${REPORT_HOURS:-168}"
    [[ "$hours" =~ ^[0-9]{1,4}$ ]] || { echo 'REPORT_HOURS must be a number' >&2; exit 1; }
    tz="${REPORT_TZ:-Asia/Jerusalem}"
    [[ "$tz" =~ ^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$ ]] || { echo 'REPORT_TZ is not a time zone name' >&2; exit 1; }
    command -v openssl >/dev/null || { echo 'openssl is not installed on the server' >&2; exit 1; }
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    printf '%s' "${REPORT_PUBKEY_B64:?set REPORT_PUBKEY_B64}" | base64 -d >"$work/pub.pem"
    openssl pkey -pubin -in "$work/pub.pem" -noout 2>/dev/null ||
      { echo 'REPORT_PUBKEY_B64 is not a public key' >&2; exit 1; }
    openssl rand -hex 32 >"$work/key"
    pg="$(container postgres)"
    [ -n "$pg" ] || { echo "no running postgres container in $project" >&2; exit 1; }
    docker exec -i -e EMAIL_SHA="$sha" -e HOURS="$hours" -e TZNAME="$tz" "$pg" sh -c \
      'psql -X -q -v ON_ERROR_STOP=1 -P pager=off -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v email_sha="$EMAIL_SHA" -v hours="$HOURS" -v tz="$TZNAME"' \
      >"$work/report.txt" 2>&1 <<'SQL' || true
\pset footer off
\pset format csv
SELECT id AS uid FROM users
 WHERE encode(sha256(convert_to(lower(email::text), 'UTF8')), 'hex') = :'email_sha' \gset
CREATE TEMP TABLE w AS SELECT now() - make_interval(hours => :hours) AS since;
CREATE TEMP TABLE sa AS SELECT s.* FROM sniping_activity s
 WHERE s.user_id = :'uid' AND s.occurred_at > (SELECT since FROM w);
CREATE TEMP TABLE se AS SELECT s.* FROM search_activity s
 WHERE s.user_id = :'uid' AND s.occurred_at > (SELECT since FROM w);
CREATE TEMP TABLE tr AS SELECT t.* FROM trades t
 WHERE t.user_id = :'uid' AND t.deleted_at IS NULL
   AND (t.bought_at > (SELECT since FROM w) OR t.sold_at > (SELECT since FROM w));
CREATE TEMP TABLE hb AS SELECT occurred_at, device_id, metadata FROM user_activity
 WHERE user_id = :'uid' AND type = 'heartbeat' AND occurred_at > (SELECT since FROM w);
CREATE TEMP TABLE pace AS SELECT occurred_at, device_id, metadata -> 'bot' AS b FROM hb
 WHERE jsonb_typeof(metadata -> 'bot') = 'object';
CREATE TEMP TABLE rs AS
  SELECT it FROM user_recent_searches u
   CROSS JOIN LATERAL jsonb_array_elements(
     CASE WHEN jsonb_typeof(u.items) = 'array' THEN u.items ELSE '[]'::jsonb END) it
   WHERE u.user_id = :'uid';
-- Player names: the Nova AI page's recent searches (the player picked in
-- the form), then the cards catalogue.
CREATE TEMP TABLE names AS
  WITH ids AS (SELECT resource_id FROM sa UNION SELECT resource_id FROM tr
               UNION SELECT resource_id FROM se WHERE resource_id IS NOT NULL)
  SELECT i.resource_id, coalesce(r.player, c.player, 'card ' || i.resource_id) AS player,
         coalesce(r.rating, c.rating) AS rating, c.card_version
    FROM ids i
    LEFT JOIN LATERAL (
      SELECT it -> 'form' -> 'player' ->> 'name' AS player,
             nullif(it -> 'form' -> 'player' ->> 'rating', '')::int AS rating
        FROM rs WHERE it -> 'form' -> 'player' ->> 'id' = i.resource_id
       ORDER BY (it ->> 'at')::bigint DESC LIMIT 1) r ON true
    LEFT JOIN LATERAL (
      SELECT coalesce(common_name, name) AS player, rating, card_version FROM cards
       WHERE cards.resource_id = i.resource_id LIMIT 1) c ON true;

\echo '## meta'
SELECT :'tz' AS tz, :hours AS hours,
       to_char(now() AT TIME ZONE :'tz', 'YYYY-MM-DD HH24:MI') AS generated_local,
       to_char((SELECT since FROM w) AT TIME ZONE :'tz', 'YYYY-MM-DD HH24:MI') AS since_local;

\echo '## names'
SELECT resource_id, player, rating, card_version FROM names ORDER BY player;

\echo '## bot_settings'
SELECT to_char(updated_at AT TIME ZONE :'tz', 'YYYY-MM-DD HH24:MI') AS updated_local, settings::text AS settings
  FROM user_bot_settings WHERE user_id = :'uid';

\echo '## gallery_completed'
SELECT c.id AS set_id, s ->> 'name' AS set_name, s ->> 'grade' AS grade,
       to_char(to_timestamp((g.state -> 'completedAt' ->> c.id)::bigint / 1000.0) AT TIME ZONE :'tz',
               'YYYY-MM-DD HH24:MI') AS completed_local
  FROM user_gallery g
 CROSS JOIN LATERAL jsonb_array_elements_text(
   CASE WHEN jsonb_typeof(g.state -> 'completed') = 'array' THEN g.state -> 'completed' ELSE '[]'::jsonb END) c(id)
  LEFT JOIN LATERAL (
    SELECT s FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(g.state -> 'sets') = 'array' THEN g.state -> 'sets' ELSE '[]'::jsonb END) s
     WHERE s ->> 'id' = c.id LIMIT 1) n ON true
 WHERE g.user_id = :'uid'
 ORDER BY (g.state -> 'completedAt' ->> c.id)::bigint DESC NULLS LAST;

\echo '## recent_searches'
SELECT to_char(to_timestamp((it ->> 'at')::bigint / 1000.0) AT TIME ZONE :'tz', 'YYYY-MM-DD HH24:MI') AS started_local,
       it ->> 'name' AS name, it -> 'form' -> 'player' ->> 'name' AS player,
       it -> 'form' -> 'player' ->> 'rating' AS rating, it -> 'form' ->> 'quality' AS quality,
       it -> 'form' ->> 'minOvr' AS min_ovr, it -> 'form' ->> 'maxOvr' AS max_ovr,
       it -> 'form' ->> 'minBuy' AS min_buy, it -> 'form' ->> 'maxBuy' AS max_buy
  FROM rs ORDER BY (it ->> 'at')::bigint DESC LIMIT 30;

\echo '## settings_changes'
SELECT to_char(occurred_at AT TIME ZONE :'tz', 'YYYY-MM-DD HH24:MI') AS at_local, metadata -> 'fields' AS fields
  FROM user_activity
 WHERE user_id = :'uid' AND type = 'settings_change' AND occurred_at > (SELECT since FROM w)
 ORDER BY occurred_at;

\echo '## totals'
SELECT count(*) AS bought, count(*) FILTER (WHERE status = 'sold') AS sold,
       count(*) FILTER (WHERE status IN ('bought', 'listed')) AS not_marked_sold,
       sum(buy_price) AS spent, sum(sell_price) FILTER (WHERE status = 'sold') AS revenue,
       sum(ea_tax) FILTER (WHERE status = 'sold') AS tax,
       sum(net_profit) FILTER (WHERE status = 'sold') AS profit,
       round(avg(net_profit) FILTER (WHERE status = 'sold')) AS profit_per_sale,
       round(100.0 * sum(net_profit) FILTER (WHERE status = 'sold')
             / nullif(sum(buy_price) FILTER (WHERE status = 'sold'), 0), 1) AS roi_pct
  FROM tr;

\echo '## races'
SELECT count(*) FILTER (WHERE outcome = 'success') AS won,
       count(*) FILTER (WHERE outcome IN ('failed', 'too_slow')) AS lost,
       count(*) FILTER (WHERE outcome = 'blocked') AS blocked,
       count(*) FILTER (WHERE outcome = 'error') AS errors,
       count(*) FILTER (WHERE outcome = 'attempted') AS unknown
  FROM sa;

\echo '## per_player'
WITH t AS (
  SELECT resource_id, count(*) AS bought, count(*) FILTER (WHERE status = 'sold') AS sold,
         count(*) FILTER (WHERE status IN ('bought', 'listed')) AS not_marked_sold,
         round(avg(buy_price)) AS avg_buy, round(avg(sell_price) FILTER (WHERE status = 'sold')) AS avg_sell,
         sum(net_profit) FILTER (WHERE status = 'sold') AS profit,
         round(avg(net_profit) FILTER (WHERE status = 'sold')) AS profit_per_sale,
         round(100.0 * sum(net_profit) FILTER (WHERE status = 'sold')
               / nullif(sum(buy_price) FILTER (WHERE status = 'sold'), 0), 1) AS roi_pct,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM sold_at - bought_at) / 60)
                FILTER (WHERE status = 'sold'))::numeric) AS median_min_to_sell
    FROM tr GROUP BY 1),
r AS (
  SELECT resource_id, count(*) FILTER (WHERE outcome = 'success') AS won,
         count(*) FILTER (WHERE outcome IN ('failed', 'too_slow')) AS lost,
         count(*) FILTER (WHERE outcome = 'blocked') AS blocked,
         round(avg(listed_price) FILTER (WHERE outcome = 'success')) AS avg_price_won,
         round(avg(listed_price) FILTER (WHERE outcome IN ('failed', 'too_slow'))) AS avg_price_lost
    FROM sa GROUP BY 1),
s AS (
  SELECT resource_id, count(*) AS listings_seen, min(floor_price) AS lowest_seen, round(avg(floor_price)) AS avg_floor
    FROM se WHERE resource_id IS NOT NULL GROUP BY 1)
SELECT n.player, n.rating, n.resource_id, t.bought, t.sold, t.not_marked_sold, t.avg_buy, t.avg_sell,
       t.profit, t.profit_per_sale, t.roi_pct, t.median_min_to_sell, r.won, r.lost, r.blocked,
       round(100.0 * r.won / nullif(r.won + r.lost, 0)) AS win_pct, r.avg_price_won, r.avg_price_lost,
       s.listings_seen, s.lowest_seen, s.avg_floor
  FROM names n LEFT JOIN t USING (resource_id) LEFT JOIN r USING (resource_id) LEFT JOIN s USING (resource_id)
 ORDER BY coalesce(t.profit, 0) DESC, coalesce(r.won, 0) DESC;

\echo '## hour_of_day'
WITH h AS (SELECT generate_series(0, 23) AS hour),
p AS (
  SELECT extract(hour FROM occurred_at AT TIME ZONE :'tz')::int AS hour,
         sum((b ->> 'searches')::numeric) AS searches, sum((b ->> 'withResults')::numeric) AS with_results,
         sum((b ->> 'windowMs')::numeric) AS window_ms, sum((b ->> 'backoffMs')::numeric) AS backoff_ms
    FROM pace GROUP BY 1),
act AS (
  SELECT extract(hour FROM ts AT TIME ZONE :'tz')::int AS hour, count(DISTINCT date_trunc('hour', ts)) AS active_hours
    FROM (SELECT occurred_at AS ts FROM hb UNION ALL SELECT occurred_at FROM se UNION ALL SELECT occurred_at FROM sa) x
   GROUP BY 1),
l AS (
  SELECT extract(hour FROM occurred_at AT TIME ZONE :'tz')::int AS hour, count(*) AS listings, round(avg(floor_price)) AS avg_floor
    FROM se GROUP BY 1),
r AS (
  SELECT extract(hour FROM occurred_at AT TIME ZONE :'tz')::int AS hour,
         count(*) FILTER (WHERE outcome = 'success') AS won,
         count(*) FILTER (WHERE outcome IN ('failed', 'too_slow')) AS lost
    FROM sa GROUP BY 1),
b AS (
  SELECT extract(hour FROM bought_at AT TIME ZONE :'tz')::int AS hour, count(*) AS bought,
         round(avg(net_profit) FILTER (WHERE status = 'sold')) AS avg_profit,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM sold_at - bought_at) / 60)
                FILTER (WHERE status = 'sold'))::numeric) AS median_min_to_sell
    FROM tr WHERE bought_at IS NOT NULL GROUP BY 1),
s AS (
  SELECT extract(hour FROM sold_at AT TIME ZONE :'tz')::int AS hour, count(*) AS sold, round(avg(sell_price)) AS avg_sell
    FROM tr WHERE status = 'sold' AND sold_at IS NOT NULL GROUP BY 1)
SELECT h.hour, coalesce(act.active_hours, 0) AS active_hours, round(p.searches) AS searches,
       round(p.searches * 60000 / nullif(p.window_ms, 0), 1) AS searches_per_min,
       round(p.with_results) AS searches_with_listings,
       round(100 * p.with_results / nullif(p.searches, 0), 2) AS pct_with_listings,
       coalesce(l.listings, 0) AS listings_found,
       round(coalesce(l.listings, 0)::numeric / nullif(act.active_hours, 0), 1) AS listings_per_active_hour,
       l.avg_floor, coalesce(r.won, 0) AS won, coalesce(r.lost, 0) AS lost,
       round(100.0 * r.won / nullif(r.won + r.lost, 0)) AS win_pct,
       coalesce(b.bought, 0) AS bought, b.avg_profit, b.median_min_to_sell, coalesce(s.sold, 0) AS sold, s.avg_sell,
       round(100 * p.backoff_ms / nullif(p.window_ms, 0), 1) AS pct_backoff
  FROM h LEFT JOIN p USING (hour) LEFT JOIN act USING (hour) LEFT JOIN l USING (hour)
  LEFT JOIN r USING (hour) LEFT JOIN b USING (hour) LEFT JOIN s USING (hour)
 ORDER BY h.hour;

\echo '## day_of_week'
WITH act AS (
  SELECT extract(isodow FROM ts AT TIME ZONE :'tz')::int AS dow, count(DISTINCT date_trunc('hour', ts)) AS active_hours
    FROM (SELECT occurred_at AS ts FROM hb UNION ALL SELECT occurred_at FROM se UNION ALL SELECT occurred_at FROM sa) x
   GROUP BY 1),
l AS (SELECT extract(isodow FROM occurred_at AT TIME ZONE :'tz')::int AS dow, count(*) AS listings FROM se GROUP BY 1),
r AS (
  SELECT extract(isodow FROM occurred_at AT TIME ZONE :'tz')::int AS dow,
         count(*) FILTER (WHERE outcome = 'success') AS won,
         count(*) FILTER (WHERE outcome IN ('failed', 'too_slow')) AS lost
    FROM sa GROUP BY 1),
s AS (
  SELECT extract(isodow FROM sold_at AT TIME ZONE :'tz')::int AS dow, count(*) AS sold, sum(net_profit) AS profit
    FROM tr WHERE status = 'sold' AND sold_at IS NOT NULL GROUP BY 1)
SELECT d.dow, to_char(date '2024-01-01' + (d.dow - 1), 'Dy') AS day, coalesce(act.active_hours, 0) AS active_hours,
       coalesce(l.listings, 0) AS listings_found,
       round(coalesce(l.listings, 0)::numeric / nullif(act.active_hours, 0), 1) AS listings_per_active_hour,
       coalesce(r.won, 0) AS won, coalesce(r.lost, 0) AS lost,
       round(100.0 * r.won / nullif(r.won + r.lost, 0)) AS win_pct, coalesce(s.sold, 0) AS sold, s.profit
  FROM (SELECT generate_series(1, 7) AS dow) d LEFT JOIN act USING (dow) LEFT JOIN l USING (dow)
  LEFT JOIN r USING (dow) LEFT JOIN s USING (dow)
 ORDER BY d.dow;

\echo '## daily'
WITH days AS (
  SELECT DISTINCT to_char(ts AT TIME ZONE :'tz', 'YYYY-MM-DD') AS day
    FROM (SELECT occurred_at AS ts FROM hb UNION ALL SELECT occurred_at FROM se UNION ALL SELECT occurred_at FROM sa
          UNION ALL SELECT bought_at FROM tr WHERE bought_at IS NOT NULL) x),
act AS (
  SELECT to_char(ts AT TIME ZONE :'tz', 'YYYY-MM-DD') AS day, count(DISTINCT date_trunc('hour', ts)) AS active_hours
    FROM (SELECT occurred_at AS ts FROM hb UNION ALL SELECT occurred_at FROM se UNION ALL SELECT occurred_at FROM sa) x
   GROUP BY 1),
p AS (SELECT to_char(occurred_at AT TIME ZONE :'tz', 'YYYY-MM-DD') AS day, sum((b ->> 'searches')::numeric) AS searches FROM pace GROUP BY 1),
l AS (SELECT to_char(occurred_at AT TIME ZONE :'tz', 'YYYY-MM-DD') AS day, count(*) AS listings FROM se GROUP BY 1),
r AS (
  SELECT to_char(occurred_at AT TIME ZONE :'tz', 'YYYY-MM-DD') AS day,
         count(*) FILTER (WHERE outcome = 'success') AS won,
         count(*) FILTER (WHERE outcome IN ('failed', 'too_slow')) AS lost,
         count(*) FILTER (WHERE outcome = 'blocked') AS blocked,
         count(*) FILTER (WHERE error_code ~ 'status (429|426|458|460|461|512|521)') AS ea_limit_codes
    FROM sa GROUP BY 1),
b AS (SELECT to_char(bought_at AT TIME ZONE :'tz', 'YYYY-MM-DD') AS day, count(*) AS bought, sum(buy_price) AS spent FROM tr WHERE bought_at IS NOT NULL GROUP BY 1),
s AS (SELECT to_char(sold_at AT TIME ZONE :'tz', 'YYYY-MM-DD') AS day, count(*) AS sold, sum(net_profit) AS profit FROM tr WHERE status = 'sold' AND sold_at IS NOT NULL GROUP BY 1),
e AS (
  SELECT to_char(occurred_at AT TIME ZONE :'tz', 'YYYY-MM-DD') AS day, count(*) AS bot_errors
    FROM user_activity WHERE user_id = :'uid' AND type = 'error' AND occurred_at > (SELECT since FROM w) GROUP BY 1)
SELECT days.day, coalesce(act.active_hours, 0) AS active_hours, round(p.searches) AS searches,
       coalesce(l.listings, 0) AS listings_found, coalesce(r.won, 0) AS won, coalesce(r.lost, 0) AS lost,
       coalesce(r.blocked, 0) AS blocked, coalesce(b.bought, 0) AS bought, b.spent, coalesce(s.sold, 0) AS sold,
       s.profit, coalesce(r.ea_limit_codes, 0) AS ea_limit_codes, coalesce(e.bot_errors, 0) AS bot_errors
  FROM days LEFT JOIN act USING (day) LEFT JOIN p USING (day) LEFT JOIN l USING (day) LEFT JOIN r USING (day)
  LEFT JOIN b USING (day) LEFT JOIN s USING (day) LEFT JOIN e USING (day)
 ORDER BY days.day;

\echo '## time_to_sell'
SELECT n.player, count(*) AS sold,
       count(*) FILTER (WHERE m < 15) AS under_15m, count(*) FILTER (WHERE m >= 15 AND m < 60) AS m15_60,
       count(*) FILTER (WHERE m >= 60 AND m < 180) AS h1_3, count(*) FILTER (WHERE m >= 180 AND m < 720) AS h3_12,
       count(*) FILTER (WHERE m >= 720) AS over_12h,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY m))::numeric) AS median_min
  FROM (SELECT resource_id, extract(epoch FROM sold_at - bought_at) / 60 AS m FROM tr
         WHERE status = 'sold' AND sold_at IS NOT NULL AND bought_at IS NOT NULL) x
  JOIN names n USING (resource_id)
 GROUP BY 1 ORDER BY 2 DESC;

\echo '## price_trend'
SELECT n.player, d.day, d.listings, d.lowest_seen, d.avg_floor, t.bought, t.avg_buy, t.avg_sell
  FROM (SELECT resource_id, to_char(occurred_at AT TIME ZONE :'tz', 'YYYY-MM-DD') AS day, count(*) AS listings,
               min(floor_price) AS lowest_seen, round(avg(floor_price)) AS avg_floor
          FROM se WHERE resource_id IS NOT NULL GROUP BY 1, 2) d
  FULL JOIN (SELECT resource_id, to_char(bought_at AT TIME ZONE :'tz', 'YYYY-MM-DD') AS day, count(*) AS bought,
                    round(avg(buy_price)) AS avg_buy, round(avg(sell_price) FILTER (WHERE status = 'sold')) AS avg_sell
               FROM tr WHERE bought_at IS NOT NULL GROUP BY 1, 2) t USING (resource_id, day)
  JOIN names n USING (resource_id)
 ORDER BY 1, 2;

\echo '## devices'
SELECT coalesce(d.os, '?') || ' / ' || coalesce(d.browser, '?') AS device, d.extension_version AS version,
       count(*) FILTER (WHERE s.outcome = 'success') AS won,
       count(*) FILTER (WHERE s.outcome IN ('failed', 'too_slow')) AS lost,
       round(100.0 * count(*) FILTER (WHERE s.outcome = 'success')
             / nullif(count(*) FILTER (WHERE s.outcome IN ('success', 'failed', 'too_slow')), 0)) AS win_pct,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY s.latency_ms)::int AS buy_p50_ms,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY s.search_ms)::int AS search_p50_ms,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY s.reaction_ms)::int AS react_p50_ms,
       to_char(min(s.occurred_at) AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS first_local,
       to_char(max(s.occurred_at) AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS last_local
  FROM sa s LEFT JOIN devices d ON d.id = s.device_id
 WHERE s.outcome <> 'blocked'
 GROUP BY 1, 2 ORDER BY max(s.occurred_at);

\echo '## speed_buckets'
SELECT CASE WHEN latency_ms IS NULL THEN 'unknown'
            WHEN latency_ms < 150 THEN 'a <150' WHEN latency_ms < 300 THEN 'b 150-299'
            WHEN latency_ms < 500 THEN 'c 300-499' WHEN latency_ms < 1000 THEN 'd 500-999'
            ELSE 'e 1000+' END AS bucket,
       count(*) FILTER (WHERE outcome = 'success') AS won,
       count(*) FILTER (WHERE outcome IN ('failed', 'too_slow')) AS lost
  FROM sa WHERE outcome <> 'blocked' GROUP BY 1 ORDER BY 1;

\echo '## pace_daily'
WITH ph AS (
  SELECT date_trunc('hour', occurred_at AT TIME ZONE :'tz') AS hr,
         sum((b ->> 'searches')::numeric) AS searches, sum((b ->> 'windowMs')::numeric) AS window_ms,
         sum((b ->> 'backoffMs')::numeric) AS backoff_ms, sum((b ->> 'blockedMs')::numeric) AS limit_ms,
         sum((b ->> 'breakMs')::numeric) AS break_ms, sum((b ->> 'cooldownMs')::numeric) AS cooldown_ms,
         sum((b ->> 'waitingMs')::numeric) AS waiting_ms, sum((b ->> 'failed')::numeric) AS failed,
         avg((b ->> 'searchMsP50')::numeric) AS search_p50, max((b ->> 'searchMsP90')::numeric) AS search_p90_max
    FROM pace GROUP BY 1)
SELECT to_char(hr, 'YYYY-MM-DD') AS day, round(sum(searches)) AS searches,
       round(max(searches)) AS max_searches_in_an_hour, round(sum(window_ms) / 3600000, 1) AS bot_hours,
       round(sum(searches) * 3600000 / nullif(sum(window_ms), 0)) AS searches_per_bot_hour,
       round(100 * sum(waiting_ms) / nullif(sum(window_ms), 0), 1) AS pct_delay,
       round(sum(backoff_ms) / 60000, 1) AS backoff_min, round(sum(limit_ms) / 60000, 1) AS limit_min,
       round(100 * sum(break_ms) / nullif(sum(window_ms), 0), 1) AS pct_break,
       round(100 * sum(cooldown_ms) / nullif(sum(window_ms), 0), 1) AS pct_cooldown,
       round(sum(failed)) AS failed_searches, round(avg(search_p50)) AS search_p50_ms,
       round(max(search_p90_max)) AS search_p90_max_ms
  FROM ph GROUP BY 1 ORDER BY 1;

\echo '## ea_codes'
SELECT to_char(occurred_at AT TIME ZONE :'tz', 'YYYY-MM-DD') AS day,
       coalesce(substring(error_code from 'status ([0-9]{3})'), error_code) AS code, outcome, count(*) AS n
  FROM sa WHERE outcome <> 'success' AND error_code IS NOT NULL
 GROUP BY 1, 2, 3 ORDER BY 1, 4 DESC;

\echo '## safety_governor'
SELECT kind, count(*) AS n, min(value) AS min_value, max(value) AS max_value, max(threshold) AS threshold,
       to_char(min(occurred_at) AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS first_local,
       to_char(max(occurred_at) AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS last_local
  FROM risk_budget_events WHERE user_id = :'uid' AND occurred_at > (SELECT since FROM w)
 GROUP BY 1 ORDER BY 2 DESC;

\echo '## blocked_reasons'
SELECT n.player, s.error_code AS reason, count(*) AS n,
       to_char(min(s.occurred_at) AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS first_local,
       to_char(max(s.occurred_at) AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS last_local
  FROM sa s JOIN names n USING (resource_id) WHERE s.outcome = 'blocked'
 GROUP BY 1, 2 ORDER BY 3 DESC;

\echo '## recent_races'
SELECT to_char(s.occurred_at AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS at_local, n.player, s.outcome,
       s.listed_price, s.search_ms, s.reaction_ms, s.latency_ms,
       coalesce(substring(s.error_code from 'status ([0-9]{3})'), s.error_code) AS code
  FROM sa s JOIN names n USING (resource_id) WHERE s.outcome <> 'blocked'
 ORDER BY s.occurred_at DESC LIMIT 60;

\echo '## not_marked_sold'
SELECT n.player, count(*) AS n, round(avg(buy_price)) AS avg_buy,
       to_char(min(bought_at) AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS first_bought_local,
       to_char(max(bought_at) AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS last_bought_local
  FROM tr JOIN names n USING (resource_id) WHERE status IN ('bought', 'listed')
 GROUP BY 1 ORDER BY 2 DESC;

\echo '## bot_errors'
SELECT metadata ->> 'context' AS context, left(metadata ->> 'message', 140) AS message,
       metadata ->> 'extensionVersion' AS version, count(*) AS n,
       to_char(min(occurred_at) AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS first_local,
       to_char(max(occurred_at) AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS last_local
  FROM user_activity WHERE user_id = :'uid' AND type = 'error' AND occurred_at > (SELECT since FROM w)
 GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 25;

\echo '## market_prices'
SELECT n.player, po.source, po.platform, po.price_kind, po.price,
       to_char(po.observed_at AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS observed_local
  FROM names n JOIN cards c ON c.resource_id = n.resource_id
  CROSS JOIN LATERAL (SELECT * FROM price_observations p WHERE p.card_id = c.id
                       ORDER BY p.observed_at DESC LIMIT 3) po
 ORDER BY 1, po.observed_at DESC;
SQL
    print_encrypted_report "$work"
    ;;

  gallery-report)
    # A trader's whole Gallery mode picture, to pick a session up on another
    # browser or to finish Sets in the game: the account's list as it
    # stands (when it was last saved, each Set's progress), the Sets marked
    # completed newest first, every card a Set not completed still needs
    # (to buy, not on the market, SBC/Objective, on its way), the window's
    # buys matched to the list's cards, the cards clubbed for the Gallery,
    # and the completed-Sets log (user_gallery_completions, 0043) where the
    # database has it. EMAIL_SHA picks the account; empty, the trader most
    # recently active (the last heartbeat, buy attempt or trade in 30 days).
    # The trader's own data, so encrypted exactly like session-report.
    sha="${EMAIL_SHA:-}"
    [ -z "$sha" ] || [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo 'EMAIL_SHA is not a sha256' >&2; exit 1; }
    hours="${REPORT_HOURS:-48}"
    [[ "$hours" =~ ^[0-9]{1,4}$ ]] || { echo 'REPORT_HOURS must be a number' >&2; exit 1; }
    tz="${REPORT_TZ:-Asia/Jerusalem}"
    [[ "$tz" =~ ^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$ ]] || { echo 'REPORT_TZ is not a time zone name' >&2; exit 1; }
    command -v openssl >/dev/null || { echo 'openssl is not installed on the server' >&2; exit 1; }
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    printf '%s' "${REPORT_PUBKEY_B64:?set REPORT_PUBKEY_B64}" | base64 -d >"$work/pub.pem"
    openssl pkey -pubin -in "$work/pub.pem" -noout 2>/dev/null ||
      { echo 'REPORT_PUBKEY_B64 is not a public key' >&2; exit 1; }
    openssl rand -hex 32 >"$work/key"
    pg="$(container postgres)"
    [ -n "$pg" ] || { echo "no running postgres container in $project" >&2; exit 1; }
    docker exec -i -e EMAIL_SHA="$sha" -e HOURS="$hours" -e TZNAME="$tz" "$pg" sh -c \
      'psql -X -q -v ON_ERROR_STOP=1 -P pager=off -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v email_sha="$EMAIL_SHA" -v hours="$HOURS" -v tz="$TZNAME"' \
      >"$work/report.txt" 2>&1 <<'SQL' || true
\pset footer off
SELECT u.id AS uid, coalesce(u.timezone, 'UTC') AS tz,
       CASE WHEN :'email_sha' <> '' THEN 'the account with that email' ELSE 'the trader most recently active' END AS how
  FROM users u
 WHERE u.deleted_at IS NULL
   AND CASE WHEN :'email_sha' <> ''
            THEN encode(sha256(convert_to(lower(u.email::text), 'UTF8')), 'hex') = :'email_sha'
            ELSE u.id = (SELECT a.user_id FROM user_activity a
                          WHERE a.occurred_at > now() - interval '30 days'
                            AND a.type IN ('heartbeat', 'login')
                          ORDER BY a.occurred_at DESC LIMIT 1)
       END
 LIMIT 1 \gset
\if :{?uid}
\echo 'account:' :how '· window: last' :hours 'hours · times in' :tz
\else
\echo 'no account: no user with that email, or no trader active in the last 30 days'
\quit
\endif

\echo
\echo '== the account''s Gallery list (as last saved to the account)'
SELECT to_char(g.updated_at AT TIME ZONE :'tz', 'YYYY-MM-DD HH24:MI') AS last_saved_local,
       jsonb_array_length(CASE WHEN jsonb_typeof(g.state -> 'sets') = 'array' THEN g.state -> 'sets' ELSE '[]'::jsonb END) AS sets_on_list,
       jsonb_array_length(CASE WHEN jsonb_typeof(g.state -> 'completed') = 'array' THEN g.state -> 'completed' ELSE '[]'::jsonb END) AS sets_completed,
       jsonb_array_length(CASE WHEN jsonb_typeof(g.state -> 'cards') = 'array' THEN g.state -> 'cards' ELSE '[]'::jsonb END) AS cards,
       g.state ->> 'spent' AS spent, g.state ->> 'budget' AS budget
  FROM user_gallery g WHERE g.user_id = :'uid';

\echo '== Sets on the list: progress (collected = through your club: in the club, listed, or owned already)'
WITH g AS (SELECT state AS st FROM user_gallery WHERE user_id = :'uid'),
     cd AS (SELECT jsonb_array_elements(CASE WHEN jsonb_typeof((SELECT st FROM g) -> 'cards') = 'array' THEN (SELECT st FROM g) -> 'cards' ELSE '[]'::jsonb END) AS c),
     st AS (SELECT jsonb_array_elements(CASE WHEN jsonb_typeof((SELECT st FROM g) -> 'sets') = 'array' THEN (SELECT st FROM g) -> 'sets' ELSE '[]'::jsonb END) AS s),
     cp AS (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof((SELECT st FROM g) -> 'completed') = 'array' THEN (SELECT st FROM g) -> 'completed' ELSE '[]'::jsonb END) AS cid)
SELECT s ->> 'name' AS set, s ->> 'grade' AS grade, s ->> 'tokens' AS tokens,
       (SELECT count(*) FROM cd WHERE c -> 'setIds' @> to_jsonb((s ->> 'id')::bigint) AND c ->> 'status' IN ('owned', 'club', 'listed')) AS collected,
       (SELECT count(*) FROM cd WHERE c -> 'setIds' @> to_jsonb((s ->> 'id')::bigint)) AS total,
       (SELECT count(*) FROM cd WHERE c -> 'setIds' @> to_jsonb((s ->> 'id')::bigint) AND c ->> 'status' = 'todo') AS to_buy,
       (SELECT count(*) FROM cd WHERE c -> 'setIds' @> to_jsonb((s ->> 'id')::bigint) AND c ->> 'status' IN ('bought', 'club')) AS on_the_way,
       (SELECT count(*) FROM cd WHERE c -> 'setIds' @> to_jsonb((s ->> 'id')::bigint) AND c ->> 'status' = 'skipped') AS skipped,
       (SELECT count(*) FROM cd WHERE c -> 'setIds' @> to_jsonb((s ->> 'id')::bigint) AND c ->> 'status' = 'sbc') AS sbc,
       EXISTS (SELECT 1 FROM cp WHERE cid = s ->> 'id') AS completed,
       CASE WHEN ((SELECT st FROM g) -> 'completedAt' ->> (s ->> 'id')) ~ '^[0-9]{1,16}$'
            THEN to_char(to_timestamp(((SELECT st FROM g) -> 'completedAt' ->> (s ->> 'id'))::bigint / 1000.0) AT TIME ZONE :'tz', 'MM-DD HH24:MI')
            END AS completed_local
  FROM st ORDER BY completed, set;

\echo '== completed Sets, newest first (the list''s own record; a Set the list no longer describes shows by its id)'
WITH g AS (SELECT state AS st FROM user_gallery WHERE user_id = :'uid'),
     cp AS (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof((SELECT st FROM g) -> 'completed') = 'array' THEN (SELECT st FROM g) -> 'completed' ELSE '[]'::jsonb END) AS cid),
     st AS (SELECT jsonb_array_elements(CASE WHEN jsonb_typeof((SELECT st FROM g) -> 'sets') = 'array' THEN (SELECT st FROM g) -> 'sets' ELSE '[]'::jsonb END) AS s)
SELECT cp.cid AS set_id,
       coalesce((SELECT s ->> 'name' FROM st WHERE s ->> 'id' = cp.cid LIMIT 1), 'Set #' || cp.cid) AS set,
       coalesce((SELECT st FROM g) -> 'completedGrade' ->> cp.cid, (SELECT s ->> 'grade' FROM st WHERE s ->> 'id' = cp.cid LIMIT 1)) AS grade,
       (SELECT s ->> 'tokens' FROM st WHERE s ->> 'id' = cp.cid LIMIT 1) AS tokens,
       CASE WHEN ((SELECT st FROM g) -> 'completedAt' ->> cp.cid) ~ '^[0-9]{1,16}$'
            THEN to_char(to_timestamp(((SELECT st FROM g) -> 'completedAt' ->> cp.cid)::bigint / 1000.0) AT TIME ZONE :'tz', 'YYYY-MM-DD HH24:MI')
            END AS completed_local
  FROM cp
 ORDER BY CASE WHEN ((SELECT st FROM g) -> 'completedAt' ->> cp.cid) ~ '^[0-9]{1,16}$'
               THEN ((SELECT st FROM g) -> 'completedAt' ->> cp.cid)::bigint END DESC NULLS LAST;

\echo '== cards Sets not completed still need (todo = to buy; skipped = nobody lists it; sbc = collect it in the game; bought/club = on its way)'
WITH g AS (SELECT state AS st FROM user_gallery WHERE user_id = :'uid'),
     cd AS (SELECT jsonb_array_elements(CASE WHEN jsonb_typeof((SELECT st FROM g) -> 'cards') = 'array' THEN (SELECT st FROM g) -> 'cards' ELSE '[]'::jsonb END) AS c),
     st AS (SELECT jsonb_array_elements(CASE WHEN jsonb_typeof((SELECT st FROM g) -> 'sets') = 'array' THEN (SELECT st FROM g) -> 'sets' ELSE '[]'::jsonb END) AS s),
     cp AS (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof((SELECT st FROM g) -> 'completed') = 'array' THEN (SELECT st FROM g) -> 'completed' ELSE '[]'::jsonb END) AS cid)
SELECT s ->> 'name' AS set, c ->> 'name' AS player, c ->> 'rating' AS rating, c ->> 'version' AS version,
       c ->> 'status' AS status, c ->> 'guide' AS futgg_price, c ->> 'market' AS market_price, c ->> 'price' AS paid,
       left(c ->> 'note', 90) AS note
  FROM st, cd
 WHERE c -> 'setIds' @> to_jsonb((s ->> 'id')::bigint)
   AND NOT EXISTS (SELECT 1 FROM cp WHERE cid = s ->> 'id')
   AND coalesce(c ->> 'status', '') NOT IN ('owned', 'club', 'listed')
 ORDER BY set, status, (c ->> 'rating')::int DESC NULLS LAST;

\echo '== buys in the window (every trade; matched to the list''s cards by card id where it is on the list)'
WITH g AS (SELECT state AS st FROM user_gallery WHERE user_id = :'uid'),
     cd AS (SELECT jsonb_array_elements(CASE WHEN jsonb_typeof((SELECT st FROM g) -> 'cards') = 'array' THEN (SELECT st FROM g) -> 'cards' ELSE '[]'::jsonb END) AS c)
SELECT to_char(t.bought_at AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS bought_local, t.buy_price, t.status, t.sell_price,
       coalesce(x.c ->> 'name', (SELECT coalesce(k.common_name, k.name) FROM cards k WHERE k.resource_id = t.resource_id LIMIT 1), t.resource_id) AS player,
       coalesce(x.c ->> 'rating', t.rating::text) AS rating, x.c ->> 'set' AS set, x.c ->> 'status' AS card_status
  FROM trades t
  LEFT JOIN LATERAL (SELECT c FROM cd WHERE (c ->> 'resourceId') = t.resource_id LIMIT 1) x ON true
 WHERE t.user_id = :'uid' AND t.deleted_at IS NULL
   AND t.bought_at > now() - make_interval(hours => :hours)
 ORDER BY t.bought_at;

\echo '== cards clubbed for the Gallery (user_gallery_owned): in the window, and ever'
SELECT count(*) FILTER (WHERE first_seen_at > now() - make_interval(hours => :hours)) AS clubbed_in_window,
       to_char(max(first_seen_at) AT TIME ZONE :'tz', 'MM-DD HH24:MI') AS last_local,
       count(*) AS clubbed_ever
  FROM user_gallery_owned WHERE user_id = :'uid';

SELECT to_regclass('public.user_gallery_completions') IS NOT NULL AS has_log \gset
\if :has_log
\echo '== completed Sets log (user_gallery_completions: kept after the list is cleared), newest first'
SELECT set_id, set_name, grade, tokens,
       to_char(completed_at AT TIME ZONE :'tz', 'YYYY-MM-DD HH24:MI') AS completed_local,
       to_char(undone_at AT TIME ZONE :'tz', 'YYYY-MM-DD HH24:MI') AS undone_local
  FROM user_gallery_completions WHERE user_id = :'uid'
 ORDER BY completed_at DESC LIMIT 100;
\else
\echo '== completed Sets log: not in this database yet (migration 0043 comes with the next deploy)'
\endif
SQL
    print_encrypted_report "$work"
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

  admin-panels)
    # What the admin dashboard's Overview (versions donut, retention, live
    # tiles), Activity tabs and System page are drawn from, to check them
    # after a deploy. Aggregates only: counts, versions, latest timestamps.
    # No email, IP, user id or device id is selected or printed, and the
    # log section below scrubs ids, emails and addresses from what it shows.
    psql_prod <<'SQL'
\echo '== users'
SELECT 'users: ' || count(*) FILTER (WHERE deleted_at IS NULL)
    || ' (deleted ' || count(deleted_at) || ', admins ' || count(*) FILTER (WHERE role = 'admin')
    || '), signups last 7d ' || count(*) FILTER (WHERE created_at > now() - interval '7 days')
    || ', newest signup ' || coalesce(to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), '-')
  FROM users;
\echo '== user_activity by type, last 7 days (count, latest occurred_at, latest received)'
SELECT type || ': ' || count(*)
    || ', latest ' || to_char(max(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')
    || ', received ' || to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')
  FROM user_activity
 WHERE occurred_at > now() - interval '7 days'
 GROUP BY type ORDER BY count(*) DESC;
SELECT 'heartbeats carrying bot pace, last 7d: ' || count(*)
  FROM user_activity
 WHERE occurred_at > now() - interval '7 days' AND type = 'heartbeat' AND metadata ? 'bot';
\echo '== sniping_activity (buy attempts) by outcome, last 7 days'
SELECT outcome || ': ' || count(*)
    || ', latest ' || to_char(max(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')
  FROM sniping_activity
 WHERE occurred_at > now() - interval '7 days'
 GROUP BY outcome ORDER BY count(*) DESC;
SELECT 'received in the last minute (the live tile): ' || count(*)
  FROM sniping_activity
 WHERE occurred_at > now() - interval '10 minutes' AND created_at > now() - interval '1 minute';
\echo '== search_activity, last 7 days'
SELECT 'searches: ' || count(*) || ' (with listings ' || count(*) FILTER (WHERE results_count > 0)
    || '), latest ' || coalesce(to_char(max(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), '-')
  FROM search_activity
 WHERE occurred_at > now() - interval '7 days';
\echo '== devices by status'
SELECT status || CASE WHEN deleted_at IS NULL THEN '' ELSE ' (deleted)' END || ': ' || count(*)
    || ', latest seen ' || coalesce(to_char(max(last_seen_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), '-')
  FROM devices
 GROUP BY status, deleted_at IS NULL ORDER BY count(*) DESC;
\echo '== active devices by extension_version (none = a dashboard sign-in)'
SELECT coalesce(extension_version, 'none') || ': ' || count(*)
  FROM devices
 WHERE status = 'active' AND deleted_at IS NULL
 GROUP BY extension_version ORDER BY count(*) DESC LIMIT 25;
\echo '== extension_installs (Overview donut / System chart: live = seen in the last 14 days)'
SELECT 'rows: ' || count(*) || ', live ' || count(*) FILTER (WHERE uninstalled_at IS NULL AND last_seen > now() - interval '14 days')
    || ', latest seen ' || coalesce(to_char(max(last_seen) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), '-')
  FROM extension_installs;
SELECT version || ' (' || coalesce(browser, 'unknown') || '): ' || count(*)
  FROM extension_installs
 WHERE uninstalled_at IS NULL AND last_seen > now() - interval '14 days'
 GROUP BY version, browser ORDER BY count(*) DESC LIMIT 25;
\echo '== ip_activity'
SELECT 'rows: ' || count(*) || ' (flagged ' || count(*) FILTER (WHERE flagged) || '), latest seen '
    || coalesce(to_char(max(last_seen) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), '-')
  FROM ip_activity;
SQL
    api="$(container api)"
    if [ -z "$api" ]; then
      echo "no running api container in $project"
      exit 0
    fi
    # One pass over the API's JSON log lines: Fastify logs the method and
    # URL on "incoming request" and the status on "request completed", tied
    # by reqId. Query strings are dropped; ids, emails and IPv4 addresses
    # are replaced before anything is printed.
    scrub() {
      sed -E -e 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/<id>/g' \
        -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g' \
        -e 's/\b([0-9]{1,3}\.){3}[0-9]{1,3}\b/<ip>/g' \
        -e 's/\b[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{0,4}){4,7}\b/<ip>/g' | cut -c1-300
    }
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    docker logs --timestamps --since 24h "$api" 2>&1 | tail -n 100000 | awk '
      function str(line, key,    re) {
        re = "\"" key "\":\"[^\"]*\""
        if (!match(line, re)) return ""
        return substr(line, RSTART + length(key) + 4, RLENGTH - length(key) - 5)
      }
      function num(line, key,    re) {
        re = "\"" key "\":[0-9.]+"
        if (!match(line, re)) return ""
        return substr(line, RSTART + length(key) + 3, RLENGTH - length(key) - 3)
      }
      {
        id = str($0, "reqId")
        if (index($0, "\"msg\":\"incoming request\"")) {
          url = str($0, "url")
          sub(/\?.*/, "", url)
          if (index(url, "/api/v1/admin/") == 1) path[id] = str($0, "method") " " url
          next
        }
        if (index($0, "\"msg\":\"request completed\"")) {
          if (id in path) {
            status = num($0, "statusCode")
            summary[status " " path[id]]++
            if (status + 0 >= 400)
              print "FAIL " substr($1, 1, 19) "Z " status " " path[id] " " int(num($0, "responseTime")) "ms"
            delete path[id]
          }
          next
        }
        level = num($0, "level")
        if (level + 0 >= 50)
          print "ERROR " substr($1, 1, 19) "Z level=" level " " ((id in path) ? path[id] " " : "") \
            "type=" str($0, "type") " code=" str($0, "code") " msg=" str($0, "msg")
      }
      END { for (k in summary) print "COUNT " summary[k] " x " k }
    ' | scrub >"$work/api.txt" || true
    echo '== API responses to /api/v1/admin/ requests, last 24h (count x status method path)'
    grep '^COUNT ' "$work/api.txt" | cut -c7- | sort -k5,5 -k3,3 | head -n 60 || true
    echo '== failed /api/v1/admin/ requests (>= 400) and error log lines, last 24h, newest 200'
    grep -E '^(FAIL|ERROR) ' "$work/api.txt" | tail -n 200 || true
    ;;

  *)
    echo "unknown OPS_ACTION: $ACTION" >&2
    exit 1
    ;;
esac
