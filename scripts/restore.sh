#!/usr/bin/env bash
#
# Nova Emergency Restore Script
#
# Restores a database backup when the Recovery UI is unavailable.
# For normal operation, use the dashboard: /recovery
#
set -euo pipefail

usage() {
  cat <<USAGE
Nova Emergency Restore Script

Restores a Postgres dump created by ./scripts/backup.sh. For routine
restores use the Recovery UI in the dashboard; this is the offline path.

Usage:
  ./scripts/restore.sh                                   List available backups
  ./scripts/restore.sh ./backups/nova-backup-<TS>.tar.gz Restore specific tarball

Environment:
  BACKUP_DIR     Directory to look for backup tarballs (default: ./backups)

Options:
  --help, -h     Show this help message and exit
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --help|-h|-help) usage; exit 0 ;;
  esac
done

BACKUP_DIR="${BACKUP_DIR:-./backups}"

# If no argument, list available backups
if [ $# -eq 0 ]; then
  echo "Nova Backups"
  echo "============"
  echo ""
  if [ -d "$BACKUP_DIR" ] && ls "$BACKUP_DIR"/nova-backup-*.tar.gz 1>/dev/null 2>&1; then
    echo "Available backups (newest first):"
    echo ""
    ls -lhtr "$BACKUP_DIR"/nova-backup-*.tar.gz | awk '{print "  " $NF " (" $5 ")"}'
    echo ""
    echo "Usage: ./scripts/restore.sh <backup-file>"
  else
    echo "No backups found in ${BACKUP_DIR}/"
    echo "Create one with: ./scripts/backup.sh"
  fi
  exit 0
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo ""
echo "WARNING: This will overwrite your current Nova database!"
echo "  Backup: $BACKUP_FILE"
echo ""
read -p "Type YES to continue: " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "Aborted."
  exit 1
fi

# Create temp directory
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo ""
echo "Extracting backup..."
tar -xzf "$BACKUP_FILE" -C "$TMPDIR"

if [ ! -f "${TMPDIR}/database.sql" ]; then
  echo "Error: Backup archive missing database.sql"
  exit 1
fi

echo "Restoring database..."
docker compose exec -T postgres psql -U nova nova --single-transaction \
  < "${TMPDIR}/database.sql"

# Restore filesystem source blobs (after DB so source_ref_id rows resolve)
SOURCES_DIR="${SOURCES_DIR:-./data/sources}"
if [ -d "${TMPDIR}/sources" ]; then
  echo "Restoring source blobs to ${SOURCES_DIR}..."
  mkdir -p "$SOURCES_DIR"
  # Mirror the DB's DROP-and-recreate semantics — backup is authoritative
  find "$SOURCES_DIR" -mindepth 1 -delete 2>/dev/null || true
  cp -r "${TMPDIR}/sources/." "$SOURCES_DIR/"
  COUNT=$(find "$SOURCES_DIR" -type f | wc -l)
  echo "  Restored ${COUNT} source blob(s)"
fi

echo ""
echo "Database restored. Restarting services..."
docker compose restart orchestrator memory-service llm-gateway chat-api

echo ""
echo "Restore complete. Nova should be back online shortly."
