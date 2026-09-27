#!/usr/bin/env sh
# Restores every application database from one backup timestamp into the
# Compose stack of ENV_FILE, replacing its data. Files missing locally are
# fetched from RESTORE_REMOTE (default BACKUP_REMOTE); checksums are verified
# before anything is restored.
set -eu
umask 077
. ./ops/lib.sh

[ "${CONFIRM_RESTORE:-}" = YES ] || { echo 'Set CONFIRM_RESTORE=YES to restore into the target stack.' >&2; exit 1; }
[ "${ALLOW_DESTRUCTIVE_RESTORE:-}" = YES ] || { echo 'Set ALLOW_DESTRUCTIVE_RESTORE=YES to acknowledge that restore replaces data.' >&2; exit 1; }
load_env
BACKUP_DIR=${BACKUP_DIR:-./backups}
AGE_IDENTITY=${AGE_IDENTITY:?AGE_IDENTITY is required}
timestamp=${BACKUP_TIMESTAMP:?BACKUP_TIMESTAMP is required}
case "$timestamp" in
  *[!A-Za-z0-9_.-]*) echo 'BACKUP_TIMESTAMP contains invalid path characters' >&2; exit 1 ;;
esac
require_command age sha256sum

checksums="SHA256SUMS_$timestamp.txt"
if [ ! -f "$BACKUP_DIR/$checksums" ]; then
  require_command rclone
  # The env file's remote uses the upload-only key, which cannot read, so
  # restores normally point RESTORE_REMOTE at a remote with the read key.
  remote=${RESTORE_REMOTE:-${BACKUP_REMOTE:-}}
  : "${remote:?Set RESTORE_REMOTE to fetch backups that are not local}"
  mkdir -p "$BACKUP_DIR"
  rclone copy "$remote" "$BACKUP_DIR" \
    --include "*_$timestamp.dump.age" --include "$checksums"
fi
(cd "$BACKUP_DIR" && sha256sum -c "$checksums")

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

for database in $APP_DATABASES; do
  dump="$tmp_dir/$database.dump"
  age --decrypt --identity "$AGE_IDENTITY" --output "$dump" \
    "$BACKUP_DIR/${database}_${timestamp}.dump.age"
  compose exec -T postgres \
    sh -c "PGPASSWORD=\"\$POSTGRES_PASSWORD\" pg_restore --clean --if-exists --no-owner --no-privileges -U \"\$POSTGRES_USER\" -d '$database'" \
    < "$dump"
done

echo 'PostgreSQL restore completed. Re-run migrations and smoke tests before serving traffic.'
