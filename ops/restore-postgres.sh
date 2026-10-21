#!/usr/bin/env sh
# Restores every application database from one backup timestamp into the
# Compose stack of ENV_FILE, replacing its data. Files missing locally are
# fetched from RESTORE_REMOTE (default BACKUP_REMOTE); checksums are verified
# before anything is restored. Each dump is restored into a fresh
# <database>_restore database in one transaction; only when all of them
# succeed are the live databases dropped and replaced, so a failed restore
# leaves the current data untouched and nothing created after the backup
# survives a successful one.
set -eu
umask 077
. ./ops/lib.sh

[ "${CONFIRM_RESTORE:-}" = YES ] || { echo 'Set CONFIRM_RESTORE=YES to restore into the target stack.' >&2; exit 1; }
[ "${ALLOW_DESTRUCTIVE_RESTORE:-}" = YES ] || { echo 'Set ALLOW_DESTRUCTIVE_RESTORE=YES to acknowledge that restore replaces data.' >&2; exit 1; }
load_env
BACKUP_DIR=${BACKUP_DIR:-/var/backups/move-with-miya}
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
trap 'rm -rf "$tmp_dir"' EXIT
trap 'exit 1' INT TERM

# Runs SQL statements (one per argument) against the maintenance database.
# psql runs each statement on its own, as CREATE/DROP DATABASE require.
admin_sql() {
  printf '%s;\n' "$@" | compose exec -T postgres \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" PGOPTIONS="-c client_min_messages=warning" psql -v ON_ERROR_STOP=1 --quiet -U "$POSTGRES_USER" -d postgres'
}

for database in $APP_DATABASES; do
  age --decrypt --identity "$AGE_IDENTITY" --output "$tmp_dir/$database.dump" \
    "$BACKUP_DIR/${database}_${timestamp}.dump.age"
done

for database in $APP_DATABASES; do
  staging="${database}_restore"
  admin_sql "DROP DATABASE IF EXISTS $staging" "CREATE DATABASE $staging TEMPLATE template0"
  compose exec -T postgres \
    sh -c "PGPASSWORD=\"\$POSTGRES_PASSWORD\" pg_restore --single-transaction --exit-on-error --no-owner --no-privileges -U \"\$POSTGRES_USER\" -d '$staging'" \
    < "$tmp_dir/$database.dump"
done

# Every dump restored: swap the restored databases in.
for database in $APP_DATABASES; do
  admin_sql "DROP DATABASE IF EXISTS $database WITH (FORCE)" \
    "ALTER DATABASE ${database}_restore RENAME TO $database"
done

echo 'PostgreSQL restore completed. Re-run migrations and smoke tests before serving traffic.'
