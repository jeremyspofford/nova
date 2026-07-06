#!/usr/bin/env bash
#
# Nova Emergency Backup Script
#
# Creates a database backup when the Recovery UI is unavailable.
# For normal operation, use the dashboard: Settings > Backups or /recovery
#
set -euo pipefail

usage() {
  cat <<USAGE
Nova Emergency Backup Script

Creates a tarball containing a Postgres dump (and any associated state) for
disaster recovery. For routine backups use the Recovery UI in the dashboard
(Settings → System → Recovery & Services); this script is the offline /
emergency path.

Usage:
  ./scripts/backup.sh
  BACKUP_DIR=/mnt/nas ./scripts/backup.sh

Environment:
  BACKUP_DIR     Directory to write the tarball (default: ./backups)

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
TIMESTAMP=$(date -u +%Y-%m-%d_%H-%M-%S)
FILENAME="nova-backup-${TIMESTAMP}.tar.gz"

mkdir -p "$BACKUP_DIR"

echo "Creating Nova backup..."
echo "  Output: ${BACKUP_DIR}/${FILENAME}"

# Create temp directory for dump
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Dump database
echo "  Dumping database..."
docker compose exec -T postgres pg_dump -U nova nova --no-owner --no-acl \
  > "${TMPDIR}/database.sql"

# Stage filesystem source blobs alongside the SQL dump if any exist
SOURCES_DIR="${SOURCES_DIR:-./data/sources}"
SOURCES_COUNT=0
if [ -d "$SOURCES_DIR" ] && [ -n "$(ls -A "$SOURCES_DIR" 2>/dev/null)" ]; then
  echo "  Staging source blobs from ${SOURCES_DIR}..."
  mkdir -p "${TMPDIR}/sources"
  cp -r "$SOURCES_DIR"/. "${TMPDIR}/sources/"
  SOURCES_COUNT=$(find "${TMPDIR}/sources" -type f | wc -l)
  echo "  Included ${SOURCES_COUNT} source blob(s)"
fi

# Bundle into tar.gz
echo "  Packaging..."
if [ "$SOURCES_COUNT" -gt 0 ]; then
  tar -czf "${BACKUP_DIR}/${FILENAME}" -C "$TMPDIR" database.sql sources
else
  tar -czf "${BACKUP_DIR}/${FILENAME}" -C "$TMPDIR" database.sql
fi

SIZE=$(du -h "${BACKUP_DIR}/${FILENAME}" | cut -f1)
echo ""
echo "Backup complete: ${BACKUP_DIR}/${FILENAME} (${SIZE})"
echo ""
echo "To restore: ./scripts/restore.sh ${BACKUP_DIR}/${FILENAME}"
