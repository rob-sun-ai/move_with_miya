#!/usr/bin/env bash
# Tests for ops/restore-postgres.sh.
# shellcheck source=ops/tests/harness.sh
. "$(dirname "$0")/harness.sh"

make_backup() {
  ./ops/backup-postgres.sh >/dev/null 2>&1 || fail 'backup failed'
  TIMESTAMP=$(ls "$SANDBOX/backups" | sed -n 's/^SHA256SUMS_\(.*\)\.txt$/\1/p')
  : > "$SHIM_DIR/docker.log"
  # The live databases, with data (and tables) newer than the backup.
  for db in miya_users miya_classes miya_registrations; do
    printf 'LIVE:%s' "$db" > "$SHIM_DIR/db_$db"
  done
}
restore() {
  CONFIRM_RESTORE=YES ALLOW_DESTRUCTIVE_RESTORE=YES \
    AGE_IDENTITY="$SANDBOX/key.txt" BACKUP_TIMESTAMP="$TIMESTAMP" \
    ./ops/restore-postgres.sh
}
restored_count() {
  local count=0 db
  for db in miya_users miya_classes miya_registrations; do
    [ "$(cat "$SHIM_DIR/db_$db" 2>/dev/null)" != "DUMP:$db" ] || count=$((count + 1))
  done
  echo "$count"
}
assert_live_data_untouched() {
  for db in miya_users miya_classes miya_registrations; do
    assert_eq "$(cat "$SHIM_DIR/db_$db")" "LIVE:$db"
  done
}

test_restores_every_database_from_local_files() {
  make_backup
  output=$(restore 2>&1) || fail "restore failed: $output"
  for db in miya_users miya_classes miya_registrations; do
    assert_eq "$(cat "$SHIM_DIR/db_$db")" "DUMP:$db"
    assert_no_file "$SHIM_DIR/db_${db}_restore"
  done
  restore_call=$(grep -m1 pg_restore "$SHIM_DIR/docker.log")
  assert_contains "$restore_call" 'pg_restore --single-transaction --exit-on-error --no-owner --no-privileges'
  assert_contains "$restore_call" "-d 'miya_users_restore'"
  assert_contains "$output" 'Re-run migrations and smoke tests'
}

test_restores_into_fresh_databases_and_swaps_them_in_last() {
  make_backup
  restore >/dev/null 2>&1 || fail 'restore failed'
  sql=$(cat "$SHIM_DIR/sql.log")
  assert_contains "$sql" 'CREATE DATABASE miya_classes_restore TEMPLATE template0;'
  assert_contains "$sql" 'DROP DATABASE IF EXISTS miya_classes WITH (FORCE);'
  # No live database is dropped before every dump has been restored.
  last_restore=$(grep -n pg_restore "$SHIM_DIR/docker.log" | tail -1 | cut -d: -f1)
  first_swap=$(grep -n 'psql' "$SHIM_DIR/docker.log" | sed -n 4p | cut -d: -f1)
  [ "$first_swap" -gt "$last_restore" ] || fail 'a live database was replaced before all restores finished'
  first_live_drop=$(grep -n 'WITH (FORCE)' "$SHIM_DIR/sql.log" | head -1 | cut -d: -f1)
  last_create=$(grep -n 'CREATE DATABASE' "$SHIM_DIR/sql.log" | tail -1 | cut -d: -f1)
  [ "$first_live_drop" -gt "$last_create" ] || fail 'a live database was dropped too early'
}

test_a_failed_restore_leaves_the_live_databases_untouched() {
  make_backup
  export SHIM_FAIL_RESTORE=miya_registrations_restore
  restore >/dev/null 2>&1 && fail 'expected failure'
  assert_live_data_untouched
}

test_a_failed_decryption_restores_nothing() {
  make_backup
  # A truncated file with a matching checksum: age's authentication fails.
  head -c 100 "$SANDBOX/backups/miya_registrations_$TIMESTAMP.dump.age" > "$SANDBOX/short"
  mv "$SANDBOX/short" "$SANDBOX/backups/miya_registrations_$TIMESTAMP.dump.age"
  (cd "$SANDBOX/backups" && sha256sum ./*_"$TIMESTAMP".dump.age > "SHA256SUMS_$TIMESTAMP.txt")
  restore >/dev/null 2>&1 && fail 'expected failure'
  assert_live_data_untouched
  assert_eq "$(grep -c pg_restore "$SHIM_DIR/docker.log")" 0
}

test_fetches_missing_files_from_the_restore_remote() {
  make_backup
  mv "$SANDBOX/remote" "$SANDBOX/read-only-remote"
  rm "$SANDBOX/backups"/*
  RESTORE_REMOTE=":local:$SANDBOX/read-only-remote" restore >/dev/null 2>&1 \
    || fail 'restore failed'
  assert_eq "$(restored_count)" 3
}

test_falls_back_to_the_backup_remote() {
  make_backup
  rm "$SANDBOX/backups"/*
  restore >/dev/null 2>&1 || fail 'restore failed'
  assert_eq "$(restored_count)" 3
}

test_refuses_to_restore_files_that_fail_their_checksums() {
  make_backup
  printf 'tampered' >> "$SANDBOX/backups/miya_classes_$TIMESTAMP.dump.age"
  restore >/dev/null 2>&1 && fail 'expected failure'
  assert_eq "$(restored_count)" 0
}

test_needs_a_remote_for_files_that_are_not_local() {
  TIMESTAMP=20260101T000000Z
  sed -i '/^BACKUP_REMOTE=/d' "$ENV_FILE"
  output=$(restore 2>&1) && fail 'expected failure'
  assert_contains "$output" 'Set RESTORE_REMOTE to fetch backups that are not local'
}

test_requires_both_confirmations() {
  make_backup
  output=$(ALLOW_DESTRUCTIVE_RESTORE=YES ./ops/restore-postgres.sh 2>&1) && fail 'expected failure'
  assert_contains "$output" 'Set CONFIRM_RESTORE=YES'
  output=$(CONFIRM_RESTORE=YES ./ops/restore-postgres.sh 2>&1) && fail 'expected failure'
  assert_contains "$output" 'Set ALLOW_DESTRUCTIVE_RESTORE=YES'
  assert_eq "$(restored_count)" 0
}

test_requires_the_decryption_key() {
  make_backup
  output=$(CONFIRM_RESTORE=YES ALLOW_DESTRUCTIVE_RESTORE=YES \
    BACKUP_TIMESTAMP="$TIMESTAMP" ./ops/restore-postgres.sh 2>&1) && fail 'expected failure'
  assert_contains "$output" 'AGE_IDENTITY is required'
}

test_rejects_a_timestamp_with_path_characters() {
  TIMESTAMP='../../etc/passwd'
  output=$(restore 2>&1) && fail 'expected failure'
  assert_contains "$output" 'BACKUP_TIMESTAMP contains invalid path characters'
}

test_rejects_the_wrong_decryption_key() {
  make_backup
  age-keygen -o "$SANDBOX/other-key.txt" 2>/dev/null
  CONFIRM_RESTORE=YES ALLOW_DESTRUCTIVE_RESTORE=YES \
    AGE_IDENTITY="$SANDBOX/other-key.txt" BACKUP_TIMESTAMP="$TIMESTAMP" \
    ./ops/restore-postgres.sh >/dev/null 2>&1 && fail 'expected failure'
  assert_eq "$(restored_count)" 0
}

run_tests
