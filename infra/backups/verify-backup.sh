#!/usr/bin/env bash
# verify-backup.sh — restore the latest pg-backup.sh dump into a disposable
# scratch database and run sanity queries against it, so a corrupt or
# incomplete dump is caught the same day it's taken rather than the day
# someone actually needs it. Run by infra/docker/backup.crontab at 03:30
# UTC, right after pg-backup.sh (02:00) and redis-backup.sh (02:30) — see
# docs/11-devops.md "Backup / restore runbook" / "Restore drill checklist".
#
# Usage: verify-backup.sh [dump-file.dump.gz]
#   With no argument, verifies the newest file in $BACKUP_DIR/postgres/daily.
#
# Writes ${BACKUP_DIR}/backup_verify.prom (sl_backup_last_verify_status,
# sl_backup_last_verify_timestamp_seconds{type="postgres"}) — read by
# node-exporter's textfile collector and alerted on by
# infra/monitoring/prometheus/alert-rules.yml's BackupVerifyFailed. The
# scratch database is always dropped afterwards, success or failure.
#
# Exit codes: 0 verification passed, 1 verification failed (restore error or
# a sanity check didn't pass — the .prom file is still written with status
# 0 before exiting non-zero, so the failure is visible in Prometheus even
# if nobody is watching the cron log at 03:30).

set -uo pipefail # deliberately not -e: we need to reach the metrics-write
                  # and cleanup steps even when a step below fails.

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-sl}"
export PGHOST PGPORT PGUSER

BACKUP_DIR="${BACKUP_DIR:-/backups}"
DAILY_DIR="$BACKUP_DIR/postgres/daily"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DUMP_FILE="${1:-}"
if [ -z "$DUMP_FILE" ]; then
  DUMP_FILE="$(find "$DAILY_DIR" -maxdepth 1 -name '*.dump.gz' 2>/dev/null | sed 's|.*/||' | sort | tail -n1)"
  if [ -z "$DUMP_FILE" ]; then
    echo "[verify-backup] no dump found in $DAILY_DIR — has pg-backup.sh run yet?" >&2
    exit 1
  fi
  DUMP_FILE="$DAILY_DIR/$DUMP_FILE"
fi
[ -f "$DUMP_FILE" ] || { echo "[verify-backup] no such file: $DUMP_FILE" >&2; exit 1; }

SCRATCH_DB="sniper_ledger_verify_$(date -u +%Y%m%dT%H%M%S)"
status=1 # pessimistic default; flipped to 0 only once every check passes

cleanup() {
  echo "[verify-backup] dropping scratch database $SCRATCH_DB"
  PGDATABASE=postgres psql -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" >/dev/null 2>&1 \
    || PGDATABASE=postgres psql -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" >/dev/null 2>&1 \
    || echo "[verify-backup] WARNING: failed to drop $SCRATCH_DB — drop it by hand" >&2

  metrics_tmp="$(mktemp "${BACKUP_DIR}/.backup_verify.prom.XXXXXX" 2>/dev/null || true)"
  if [ -n "$metrics_tmp" ]; then
    cat > "$metrics_tmp" <<EOF
# HELP sl_backup_last_verify_status 1 if the last restore-verification drill passed, 0 if it failed.
# TYPE sl_backup_last_verify_status gauge
sl_backup_last_verify_status{type="postgres"} $([ "$status" -eq 0 ] && echo 1 || echo 0)
# HELP sl_backup_last_verify_timestamp_seconds Unix time this verification last ran.
# TYPE sl_backup_last_verify_timestamp_seconds gauge
sl_backup_last_verify_timestamp_seconds{type="postgres"} $(date -u +%s)
EOF
    mv "$metrics_tmp" "${BACKUP_DIR}/backup_verify.prom"
  fi
}
trap cleanup EXIT

echo "[verify-backup] restoring $DUMP_FILE into scratch database $SCRATCH_DB"
if ! "$SCRIPT_DIR/pg-restore.sh" "$DUMP_FILE" "$SCRATCH_DB" --create; then
  echo "[verify-backup] FAIL: restore itself failed" >&2
  exit 1
fi

# Sanity checks: every one of these tables must exist and be queryable in
# the restored scratch DB. This is deliberately about *restorability*
# (schema + data came back intact), not business-logic row-count
# expectations — those vary legitimately by environment and day.
CHECK_TABLES=(schema_migrations users plans subscriptions licenses audit_logs)
for t in "${CHECK_TABLES[@]}"; do
  count="$(PGDATABASE="$SCRATCH_DB" psql -tAc "SELECT count(*) FROM \"$t\";" 2>&1)"
  if ! [[ "$count" =~ ^[0-9]+$ ]]; then
    echo "[verify-backup] FAIL: SELECT count(*) FROM $t failed: $count" >&2
    exit 1
  fi
  echo "[verify-backup]   $t: $count row(s)"
done

migrations_applied="$(PGDATABASE="$SCRATCH_DB" psql -tAc "SELECT count(*) FROM schema_migrations;" 2>&1)"
if [ "${migrations_applied:-0}" -lt 1 ]; then
  echo "[verify-backup] FAIL: schema_migrations is empty — restored database has no migration history" >&2
  exit 1
fi

echo "[verify-backup] PASS: $DUMP_FILE restores cleanly and all sanity checks pass"
status=0
exit 0
