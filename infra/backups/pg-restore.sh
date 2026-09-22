#!/usr/bin/env bash
# pg-restore.sh — restore a pg-backup.sh dump into a target database.
# Always requires the target database name explicitly (no implicit default
# onto $PGDATABASE) so a disaster-recovery run can never silently overwrite
# the live database by omission. Used directly for a real restore, and by
# verify-backup.sh (against a disposable scratch database) as the restore
# half of the daily verification drill. See docs/11-devops.md "Backup /
# restore runbook" for the full manual restore + PITR procedure.
#
# Usage:
#   pg-restore.sh <dump-file.dump.gz|dump-file.dump> <target-database> [--create]
#
#   --create   create <target-database> first (CREATE DATABASE ... OWNER
#              $PGUSER) if it doesn't already exist. Without it, the target
#              database must already exist (pg-restore.sh only ever
#              --clean's objects inside it, never creates/drops the
#              database itself, unless you opt in).
#
# Connection: standard libpq env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD) —
# same as pg-backup.sh. PGDATABASE is NOT used for the restore target
# (that's the required <target-database> argument); it's only relevant for
# the `postgres` maintenance connection --create uses to issue CREATE
# DATABASE.
#
# Exit codes: 0 success, 1 restore failure, 2 usage/checksum error.

set -euo pipefail

usage() {
  echo "Usage: $0 <dump-file.dump.gz|dump-file.dump> <target-database> [--create]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
DUMP_FILE="$1"
TARGET_DB="$2"
CREATE_FIRST="false"
if [ "${3:-}" = "--create" ]; then CREATE_FIRST="true"; fi

[ -f "$DUMP_FILE" ] || { echo "[pg-restore] no such file: $DUMP_FILE" >&2; exit 2; }

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-sl}"
export PGHOST PGPORT PGUSER

# --- checksum verification (skipped with a warning if no sidecar exists —
# e.g. a dump fetched back down from S3 without its .sha256 twin). ---
if [ -f "${DUMP_FILE}.sha256" ]; then
  echo "[pg-restore] verifying checksum"
  dir="$(dirname "$DUMP_FILE")"
  (cd "$dir" && sha256sum -c "$(basename "${DUMP_FILE}.sha256")")
else
  echo "[pg-restore] WARNING: no ${DUMP_FILE}.sha256 sidecar found — skipping checksum verification" >&2
fi

work_dump="$DUMP_FILE"
cleanup_tmp=""
if [[ "$DUMP_FILE" == *.gz ]]; then
  work_dump="$(mktemp --suffix=.dump)"
  cleanup_tmp="$work_dump"
  echo "[pg-restore] decompressing to $work_dump"
  gunzip -c "$DUMP_FILE" > "$work_dump"
fi
trap '[ -n "$cleanup_tmp" ] && rm -f "$cleanup_tmp"' EXIT

if [ "$CREATE_FIRST" = "true" ]; then
  echo "[pg-restore] ensuring database \"$TARGET_DB\" exists (owner $PGUSER)"
  exists="$(PGDATABASE=postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'")"
  if [ "$exists" != "1" ]; then
    PGDATABASE=postgres psql -c "CREATE DATABASE \"$TARGET_DB\" OWNER \"$PGUSER\";"
  fi
fi

echo "[pg-restore] restoring $work_dump -> ${PGUSER}@${PGHOST}:${PGPORT}/${TARGET_DB}"
# --clean --if-exists: drop existing objects before recreating them, so a
# restore into an already-populated database (e.g. re-running a drill
# against the same scratch DB) doesn't fail on "relation already exists".
# --no-owner --no-privileges: don't require the dump's original roles to
# exist on the restore target (a scratch verify DB, or a differently-named
# environment's role).
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname="$TARGET_DB" \
  --jobs="$(nproc 2>/dev/null || echo 2)" \
  "$work_dump"

echo "[pg-restore] done"
