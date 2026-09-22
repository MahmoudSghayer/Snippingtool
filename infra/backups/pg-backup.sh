#!/usr/bin/env bash
# pg-backup.sh — full logical Postgres backup (pg_dump custom format),
# gzip'd, sha256-checksummed, with 7 daily / 4 weekly / 6 monthly retention
# tiers and an optional S3(-compatible) upload via rclone.
#
# Run by infra/docker/backup.crontab (02:00 UTC daily, inside the `backup`
# service of infra/docker-compose.staging.yml / .prod.yml — see
# infra/docker/backup.Dockerfile), or by hand for an ad hoc backup. See
# docs/11-devops.md "Backup / restore runbook" for the full operational
# picture (drill checklist, PITR notes) and infra/backups/verify-backup.sh
# for the restore-sanity check that runs right after this on the same
# schedule.
#
# Connection: standard libpq env vars (PGHOST/PGPORT/PGUSER/PGDATABASE/
# PGPASSWORD), the same ones infra/docker-compose.{staging,prod}.yml's
# `backup` service sets and pg_dump reads automatically — no -h/-U flags
# needed. Defaults below match local (no-compose) dev, per
# infra/env/.env.development.example.
#
# S3 upload (optional — skipped, not failed, if unset): BACKUP_S3_REMOTE is
# an rclone "on-the-fly" remote spec, e.g. `s3,provider=AWS,env_auth=true`
# (reads AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY automatically) or
# `s3,provider=Cloudflare,endpoint=https://<acct>.r2.cloudflarestorage.com,env_auth=true`
# for R2; BACKUP_S3_BUCKET is `bucket[/prefix]`. See
# infra/env/.env.{staging,production}.example.
#
# Usage: pg-backup.sh
# Exit codes: 0 success, 1 pg_dump/gzip/checksum failure, 2 usage/env error.

set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-sl}"
PGDATABASE="${PGDATABASE:-sniper_ledger}"
export PGHOST PGPORT PGUSER PGDATABASE
# PGPASSWORD intentionally not defaulted here — either it's already in the
# environment (compose's `backup` service, or exported by hand before
# running this script locally) or libpq falls through to ~/.pgpass /
# trust-auth, whichever applies. A script default would too easily end up
# the *real* password in a production container's process list otherwise.

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETAIN_DAILY="${BACKUP_RETAIN_DAILY:-7}"
RETAIN_WEEKLY="${BACKUP_RETAIN_WEEKLY:-4}"
RETAIN_MONTHLY="${BACKUP_RETAIN_MONTHLY:-6}"

DAILY_DIR="$BACKUP_DIR/postgres/daily"
WEEKLY_DIR="$BACKUP_DIR/postgres/weekly"
MONTHLY_DIR="$BACKUP_DIR/postgres/monthly"
mkdir -p "$DAILY_DIR" "$WEEKLY_DIR" "$MONTHLY_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
base_name="${PGDATABASE}_${timestamp}"
tmp_dump="$DAILY_DIR/.tmp-${base_name}.dump"
final_dump="$DAILY_DIR/${base_name}.dump.gz"

cleanup() { rm -f "$tmp_dump"; }
trap cleanup EXIT

echo "[pg-backup] dumping ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE} -> ${tmp_dump}"
# -Fc: custom format (compressed internally too, but we gzip the whole file
# below for a consistent .gz + .sha256 story with redis-backup.sh, and so
# `zcat`/`gunzip` alone is enough to inspect it without pg_restore).
# --no-owner/--no-privileges: restore target may have a different owning
# role (e.g. a scratch verify DB, or a differently-named prod role) —
# pg-restore.sh re-applies ownership itself if/when needed.
pg_dump -Fc --no-owner --no-privileges -f "$tmp_dump"

echo "[pg-backup] compressing"
gzip -9 -c "$tmp_dump" > "$final_dump"
rm -f "$tmp_dump"
sha256sum "$final_dump" | awk '{print $1"  "$2}' > "${final_dump}.sha256"
(cd "$DAILY_DIR" && sha256sum -c "$(basename "${final_dump}.sha256")" >/dev/null)
echo "[pg-backup] wrote $final_dump ($(du -h "$final_dump" | cut -f1))"

prune_tier() {
  local dir="$1" keep="$2"
  # Filenames are `${PGDATABASE}_<UTC timestamp>.dump.gz[.sha256]`, so a
  # lexicographic sort is also chronological. Keep the newest $keep, remove
  # everything older (dump + its sidecar checksum together).
  local files
  files=$(find "$dir" -maxdepth 1 -name '*.dump.gz' | sed 's|.*/||' | sort)
  local count total
  total=$(echo "$files" | grep -c . || true)
  if [ "$total" -le "$keep" ]; then return; fi
  local drop=$((total - keep))
  echo "$files" | head -n "$drop" | while IFS= read -r f; do
    echo "[pg-backup] pruning $dir/$f (retention: keep $keep)"
    rm -f "$dir/$f" "$dir/$f.sha256"
  done
}

# Weekly tier: every Sunday (date +%w == 0). Monthly tier: the 1st of the
# month. Both are plain copies of today's daily dump — kept in their own
# directory/retention count so daily pruning above never touches them.
dow="$(date -u +%w)"
dom="$(date -u +%d)"
if [ "$dow" = "0" ]; then
  cp -p "$final_dump" "${final_dump}.sha256" "$WEEKLY_DIR/"
  echo "[pg-backup] copied to weekly tier (Sunday)"
fi
if [ "$dom" = "01" ]; then
  cp -p "$final_dump" "${final_dump}.sha256" "$MONTHLY_DIR/"
  echo "[pg-backup] copied to monthly tier (1st of month)"
fi

prune_tier "$DAILY_DIR" "$RETAIN_DAILY"
prune_tier "$WEEKLY_DIR" "$RETAIN_WEEKLY"
prune_tier "$MONTHLY_DIR" "$RETAIN_MONTHLY"

# --- optional S3(-compatible) upload -----------------------------------
if [ -n "${BACKUP_S3_REMOTE:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "[pg-backup] uploading to :${BACKUP_S3_REMOTE}:${BACKUP_S3_BUCKET}/postgres/daily/"
    if ! rclone copyto "$final_dump" ":${BACKUP_S3_REMOTE}:${BACKUP_S3_BUCKET}/postgres/daily/$(basename "$final_dump")" 2>&1; then
      # Non-fatal: the local dump (this run's actual deliverable) already
      # succeeded and is verified below/by verify-backup.sh; a network/S3
      # blip shouldn't flip the BackupTooOld alert red when a good local
      # backup exists. Surfaced as a loud warning in the cron log instead.
      echo "[pg-backup] WARNING: S3 upload failed — local backup is still valid" >&2
    else
      rclone copyto "${final_dump}.sha256" ":${BACKUP_S3_REMOTE}:${BACKUP_S3_BUCKET}/postgres/daily/$(basename "${final_dump}.sha256")" 2>&1 || true
    fi
  else
    echo "[pg-backup] WARNING: BACKUP_S3_REMOTE/BACKUP_S3_BUCKET set but rclone not found on PATH — skipping upload" >&2
  fi
fi

# --- Prometheus textfile metric (node-exporter --collector.textfile.directory) ---
# Written directly to $BACKUP_DIR (not a subdirectory) because node-exporter's
# textfile collector only scans the top level of its configured directory;
# infra/docker-compose.{staging,prod}.yml mount the same `backupdata` volume
# read-only into node-exporter at /textfile for exactly this file. Written
# atomically (tmp + mv on the same filesystem) so node-exporter never scrapes
# a half-written file.
metrics_tmp="$(mktemp "${BACKUP_DIR}/.backup_postgres.prom.XXXXXX")"
size_bytes="$(stat -c%s "$final_dump" 2>/dev/null || stat -f%z "$final_dump")"
cat > "$metrics_tmp" <<EOF
# HELP sl_backup_last_success_timestamp_seconds Unix time of the last successful backup for this type.
# TYPE sl_backup_last_success_timestamp_seconds gauge
sl_backup_last_success_timestamp_seconds{type="postgres"} $(date -u +%s)
# HELP sl_backup_last_size_bytes Size in bytes of the last successful backup's compressed dump.
# TYPE sl_backup_last_size_bytes gauge
sl_backup_last_size_bytes{type="postgres"} ${size_bytes}
EOF
mv "$metrics_tmp" "${BACKUP_DIR}/backup_postgres.prom"

echo "[pg-backup] done"
