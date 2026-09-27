#!/usr/bin/env sh
# Dumps every application database, encrypts each dump for AGE_RECIPIENT, and
# copies the encrypted files to BACKUP_REMOTE with rclone. Local copies older
# than BACKUP_LOCAL_RETENTION_DAYS are pruned; remote retention is the storage
# provider's job (the upload credentials should not be able to delete).
set -eu
umask 077
. ./ops/lib.sh
load_env

AGE_RECIPIENT=${AGE_RECIPIENT:?AGE_RECIPIENT is required for encrypted backups}
BACKUP_REMOTE=${BACKUP_REMOTE:?BACKUP_REMOTE is required for off-host backups}
BACKUP_DIR=${BACKUP_DIR:-./backups}
BACKUP_LOCAL_RETENTION_DAYS=${BACKUP_LOCAL_RETENTION_DAYS:-7}
require_command age rclone sha256sum

# Raises (or clears) a BackupFailed alert through Alertmanager. Best effort:
# the backup's own exit status is what systemd records.
backup_alert() {
  compose exec -T alertmanager amtool alert add BackupFailed severity=critical \
    --annotation='summary="PostgreSQL backup failed; see journalctl -u move-with-miya-backup"' \
    --end="$1" --alertmanager.url=http://localhost:9093 >/dev/null 2>&1 || true
}
on_exit() {
  status=$?
  rm -rf "$tmp_dir"
  if [ "$status" -ne 0 ]; then
    # Keep firing until the next nightly run can clear it.
    backup_alert "$(date -u -d '+25 hours' +%Y-%m-%dT%H:%M:%SZ)"
  fi
  exit "$status"
}

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
tmp_dir=$(mktemp -d)
trap on_exit EXIT
trap 'exit 1' INT TERM
mkdir -p "$BACKUP_DIR"

for database in $APP_DATABASES; do
  dump="$tmp_dir/$database.dump"
  compose exec -T postgres \
    sh -c "PGPASSWORD=\"\$POSTGRES_PASSWORD\" pg_dump --format=custom --no-owner --no-privileges -U \"\$POSTGRES_USER\" -d '$database'" \
    > "$dump"
  age --encrypt --recipient "$AGE_RECIPIENT" \
    --output "$BACKUP_DIR/${database}_${timestamp}.dump.age" "$dump"
done
(cd "$BACKUP_DIR" && sha256sum ./*_"$timestamp".dump.age > "SHA256SUMS_$timestamp.txt")

# --immutable: never overwrite an existing remote file.
rclone copy --immutable "$BACKUP_DIR" "$BACKUP_REMOTE" \
  --include "*_$timestamp.dump.age" --include "SHA256SUMS_$timestamp.txt"

find "$BACKUP_DIR" -type f \( -name '*.dump.age' -o -name 'SHA256SUMS_*.txt' \) \
  -mtime +"$BACKUP_LOCAL_RETENTION_DAYS" -delete

backup_alert "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Encrypted PostgreSQL backups $timestamp written to $BACKUP_DIR and $BACKUP_REMOTE."
