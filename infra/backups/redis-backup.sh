#!/usr/bin/env bash
# redis-backup.sh — snapshot Redis via `redis-cli --rdb` (a replica-style
# RDB transfer over the wire — no filesystem access to the Redis
# container/volume needed, which is why this works from the separate
# `backup` service/container in infra/docker-compose.{staging,prod}.yml),
# gzip'd, sha256-checksummed, same 7 daily / 4 weekly / 6 monthly retention
# tiers as pg-backup.sh, and the same optional S3 upload via rclone. Run by
# infra/docker/backup.crontab at 02:30 UTC. See docs/11-devops.md "Backup /
# restore runbook".
#
# Redis's own BullMQ queue state and rate-limit counters are disposable
# operational data, not a source of truth (Postgres is) — this snapshot
# exists for faster warm restart after a crash/migration, not as a
# recovery-of-record; there's no equivalent of verify-backup.sh for it.
#
# Connection: REDIS_HOST/REDIS_PORT/REDIS_PASSWORD (matches the `backup`
# service's environment in infra/docker-compose.{staging,prod}.yml).
#
# Usage: redis-backup.sh
# Exit codes: 0 success, 1 redis-cli/gzip/checksum failure.

set -euo pipefail

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_AUTH_ARGS=()
if [ -n "${REDIS_PASSWORD:-}" ]; then
  REDIS_AUTH_ARGS=(-a "$REDIS_PASSWORD" --no-auth-warning)
fi
# The production stack runs Redis with a TLS-only listener, so `redis-cli`
# has to speak TLS and verify against the stack CA (REDIS_CA_FILE, wired in
# infra/docker-compose.prod.yml). Unset elsewhere — dev/staging Redis is
# still plaintext — which leaves the invocation below byte-identical to
# what it was before TLS.
REDIS_TLS_ARGS=()
REDIS_SCHEME='redis'
if [ -n "${REDIS_CA_FILE:-}" ]; then
  REDIS_TLS_ARGS=(--tls --cacert "$REDIS_CA_FILE")
  REDIS_SCHEME='rediss'
fi

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETAIN_DAILY="${BACKUP_RETAIN_DAILY:-7}"
RETAIN_WEEKLY="${BACKUP_RETAIN_WEEKLY:-4}"
RETAIN_MONTHLY="${BACKUP_RETAIN_MONTHLY:-6}"

DAILY_DIR="$BACKUP_DIR/redis/daily"
WEEKLY_DIR="$BACKUP_DIR/redis/weekly"
MONTHLY_DIR="$BACKUP_DIR/redis/monthly"
mkdir -p "$DAILY_DIR" "$WEEKLY_DIR" "$MONTHLY_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
base_name="redis_${timestamp}"
tmp_rdb="$DAILY_DIR/.tmp-${base_name}.rdb"
final_rdb="$DAILY_DIR/${base_name}.rdb.gz"

cleanup() { rm -f "$tmp_rdb"; }
trap cleanup EXIT

echo "[redis-backup] snapshotting ${REDIS_SCHEME}://${REDIS_HOST}:${REDIS_PORT} -> ${tmp_rdb}"
redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" \
  "${REDIS_TLS_ARGS[@]}" "${REDIS_AUTH_ARGS[@]}" --rdb "$tmp_rdb"

echo "[redis-backup] compressing"
gzip -9 -c "$tmp_rdb" > "$final_rdb"
rm -f "$tmp_rdb"
sha256sum "$final_rdb" | awk '{print $1"  "$2}' > "${final_rdb}.sha256"
(cd "$DAILY_DIR" && sha256sum -c "$(basename "${final_rdb}.sha256")" >/dev/null)
echo "[redis-backup] wrote $final_rdb ($(du -h "$final_rdb" | cut -f1))"

prune_tier() {
  local dir="$1" keep="$2"
  local files total drop
  files=$(find "$dir" -maxdepth 1 -name '*.rdb.gz' -printf '%f\n' | sort)
  total=$(echo "$files" | grep -c . || true)
  if [ "$total" -le "$keep" ]; then return; fi
  drop=$((total - keep))
  echo "$files" | head -n "$drop" | while IFS= read -r f; do
    echo "[redis-backup] pruning $dir/$f (retention: keep $keep)"
    rm -f "$dir/$f" "$dir/$f.sha256"
  done
}

dow="$(date -u +%w)"
dom="$(date -u +%d)"
if [ "$dow" = "0" ]; then
  cp -p "$final_rdb" "${final_rdb}.sha256" "$WEEKLY_DIR/"
  echo "[redis-backup] copied to weekly tier (Sunday)"
fi
if [ "$dom" = "01" ]; then
  cp -p "$final_rdb" "${final_rdb}.sha256" "$MONTHLY_DIR/"
  echo "[redis-backup] copied to monthly tier (1st of month)"
fi

prune_tier "$DAILY_DIR" "$RETAIN_DAILY"
prune_tier "$WEEKLY_DIR" "$RETAIN_WEEKLY"
prune_tier "$MONTHLY_DIR" "$RETAIN_MONTHLY"

if [ -n "${BACKUP_S3_REMOTE:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "[redis-backup] uploading to :${BACKUP_S3_REMOTE}:${BACKUP_S3_BUCKET}/redis/daily/"
    if ! rclone copyto "$final_rdb" ":${BACKUP_S3_REMOTE}:${BACKUP_S3_BUCKET}/redis/daily/$(basename "$final_rdb")" 2>&1; then
      echo "[redis-backup] WARNING: S3 upload failed — local backup is still valid" >&2
    else
      rclone copyto "${final_rdb}.sha256" ":${BACKUP_S3_REMOTE}:${BACKUP_S3_BUCKET}/redis/daily/$(basename "${final_rdb}.sha256")" 2>&1 || true
    fi
  else
    echo "[redis-backup] WARNING: BACKUP_S3_REMOTE/BACKUP_S3_BUCKET set but rclone not found on PATH — skipping upload" >&2
  fi
fi

metrics_tmp="$(mktemp "${BACKUP_DIR}/.backup_redis.prom.XXXXXX")"
size_bytes="$(stat -c%s "$final_rdb" 2>/dev/null || stat -f%z "$final_rdb")"
cat > "$metrics_tmp" <<EOF
# HELP sl_backup_last_success_timestamp_seconds Unix time of the last successful backup for this type.
# TYPE sl_backup_last_success_timestamp_seconds gauge
sl_backup_last_success_timestamp_seconds{type="redis"} $(date -u +%s)
# HELP sl_backup_last_size_bytes Size in bytes of the last successful backup file.
# TYPE sl_backup_last_size_bytes gauge
sl_backup_last_size_bytes{type="redis"} ${size_bytes}
EOF
mv "$metrics_tmp" "${BACKUP_DIR}/backup_redis.prom"

echo "[redis-backup] done"
