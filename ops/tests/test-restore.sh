#!/usr/bin/env bash
# Tests for ops/restore-postgres.sh.
# shellcheck source=ops/tests/harness.sh
. "$(dirname "$0")/harness.sh"

make_backup() {
  ./ops/backup-postgres.sh >/dev/null 2>&1 || fail 'backup failed'
  TIMESTAMP=$(ls "$SANDBOX/backups" | sed -n 's/^SHA256SUMS_\(.*\)\.txt$/\1/p')
  : > "$SHIM_DIR/docker.log"
}
restore() {
  CONFIRM_RESTORE=YES ALLOW_DESTRUCTIVE_RESTORE=YES \
    AGE_IDENTITY="$SANDBOX/key.txt" BACKUP_TIMESTAMP="$TIMESTAMP" \
    ./ops/restore-postgres.sh
}
restored_count() {
  set -- "$SHIM_DIR"/restored_*
  if [ -e "$1" ]; then echo "$#"; else echo 0; fi
}

test_restores_every_database_from_local_files() {
  make_backup
  output=$(restore 2>&1) || fail "restore failed: $output"
  for db in miya_users miya_classes miya_registrations; do
    assert_eq "$(cat "$SHIM_DIR/restored_$db")" "DUMP:$db"
  done
  restore_call=$(grep -m1 pg_restore "$SHIM_DIR/docker.log")
  assert_contains "$restore_call" 'pg_restore --clean --if-exists --no-owner --no-privileges'
  assert_contains "$output" 'Re-run migrations and smoke tests'
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
