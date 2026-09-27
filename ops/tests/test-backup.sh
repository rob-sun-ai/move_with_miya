#!/usr/bin/env bash
# Tests for ops/backup-postgres.sh.
# shellcheck source=ops/tests/harness.sh
. "$(dirname "$0")/harness.sh"

backup() { ./ops/backup-postgres.sh; }
only_timestamp() {
  ls "$SANDBOX/backups" | sed -n 's/^SHA256SUMS_\(.*\)\.txt$/\1/p'
}

test_encrypts_every_database_and_copies_it_off_host() {
  output=$(backup 2>&1) || fail "backup failed: $output"
  ts=$(only_timestamp)
  for db in miya_users miya_classes miya_registrations; do
    file="${db}_$ts.dump.age"
    assert_file "$SANDBOX/backups/$file"
    assert_file "$SANDBOX/remote/$file"
    assert_eq "$(head -c 21 "$SANDBOX/backups/$file")" 'age-encryption.org/v1' "$file is encrypted"
    assert_eq "$(age -d -i "$SANDBOX/key.txt" "$SANDBOX/remote/$file")" "DUMP:$db"
  done
  assert_file "$SANDBOX/remote/SHA256SUMS_$ts.txt"
  assert_contains "$output" "Encrypted PostgreSQL backups $ts written"
}

test_checksums_verify_wherever_the_files_are_copied() {
  backup >/dev/null 2>&1 || fail 'backup failed'
  ts=$(only_timestamp)
  (cd "$SANDBOX/remote" && sha256sum -c "SHA256SUMS_$ts.txt" >/dev/null) \
    || fail 'remote checksums do not verify'
  assert_eq "$(wc -l < "$SANDBOX/remote/SHA256SUMS_$ts.txt" | tr -d ' ')" 3
}

test_dumps_with_the_containers_credentials() {
  backup >/dev/null 2>&1 || fail 'backup failed'
  dump=$(grep -m1 pg_dump "$SHIM_DIR/docker.log")
  assert_contains "$dump" 'exec -T postgres sh -c'
  assert_contains "$dump" 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --format=custom'
  assert_contains "$dump" '-U "$POSTGRES_USER"'
}

test_clears_the_backup_alert_after_success() {
  backup >/dev/null 2>&1 || fail 'backup failed'
  assert_eq "$(grep -c BackupFailed "$SHIM_DIR/alerts.log")" 1
  end=$(sed -n 's/.*--end=\([^ ]*\).*/\1/p' "$SHIM_DIR/alerts.log")
  age=$(( $(date -u +%s) - $(date -u -d "$end" +%s) ))
  [ "$age" -ge 0 ] && [ "$age" -lt 60 ] || fail "alert should end now, ends at $end"
}

test_prunes_only_old_local_backups() {
  touch -d '10 days ago' "$SANDBOX/backups/miya_users_20000101T000000Z.dump.age" \
    "$SANDBOX/backups/SHA256SUMS_20000101T000000Z.txt" "$SANDBOX/backups/notes.txt"
  touch -d '2 days ago' "$SANDBOX/backups/miya_users_20990101T000000Z.dump.age"
  backup >/dev/null 2>&1 || fail 'backup failed'
  assert_no_file "$SANDBOX/backups/miya_users_20000101T000000Z.dump.age"
  assert_no_file "$SANDBOX/backups/SHA256SUMS_20000101T000000Z.txt"
  assert_file "$SANDBOX/backups/notes.txt"
  assert_file "$SANDBOX/backups/miya_users_20990101T000000Z.dump.age"
}

test_honours_a_custom_local_retention() {
  printf 'BACKUP_LOCAL_RETENTION_DAYS=1\n' >> "$ENV_FILE"
  touch -d '3 days ago' "$SANDBOX/backups/miya_users_20990101T000000Z.dump.age"
  backup >/dev/null 2>&1 || fail 'backup failed'
  assert_no_file "$SANDBOX/backups/miya_users_20990101T000000Z.dump.age"
}

test_does_not_upload_older_local_backups_again() {
  printf 'old' > "$SANDBOX/backups/miya_users_20000101T000000Z.dump.age"
  backup >/dev/null 2>&1 || fail 'backup failed'
  assert_no_file "$SANDBOX/remote/miya_users_20000101T000000Z.dump.age"
}

test_raises_a_lasting_alert_and_keeps_local_files_when_upload_fails() {
  sed -i 's|^BACKUP_REMOTE=.*|BACKUP_REMOTE=nosuchremote:bucket|' "$ENV_FILE"
  touch -d '10 days ago' "$SANDBOX/backups/miya_users_20000101T000000Z.dump.age"
  backup >/dev/null 2>&1 && fail 'expected failure'
  assert_file "$SANDBOX/backups/miya_users_20000101T000000Z.dump.age"
  end=$(sed -n 's/.*--end=\([^ ]*\).*/\1/p' "$SHIM_DIR/alerts.log")
  remaining=$(( $(date -u -d "$end" +%s) - $(date -u +%s) ))
  # About 25 hours: it stays active past the next nightly run.
  [ "$remaining" -gt $((25 * 3600 - 120)) ] && [ "$remaining" -le $((25 * 3600)) ] \
    || fail "alert should end in about 25h, ends in ${remaining}s"
  assert_contains "$(cat "$SHIM_DIR/alerts.log")" 'severity=critical'
}

test_fails_without_uploading_when_a_dump_fails() {
  export SHIM_FAIL_DUMP=miya_classes
  backup >/dev/null 2>&1 && fail 'expected failure'
  assert_eq "$(ls "$SANDBOX/remote" | wc -l | tr -d ' ')" 0
  assert_contains "$(cat "$SHIM_DIR/alerts.log")" BackupFailed
}

test_a_failing_alertmanager_does_not_fail_a_good_backup() {
  export SHIM_FAIL_ALERT=1
  backup >/dev/null 2>&1 || fail 'backup should still succeed'
}

test_requires_an_encryption_recipient() {
  sed -i '/^AGE_RECIPIENT=/d' "$ENV_FILE"
  output=$(backup 2>&1) && fail 'expected failure'
  assert_contains "$output" 'AGE_RECIPIENT is required for encrypted backups'
  assert_eq "$(grep -c pg_dump "$SHIM_DIR/docker.log")" 0
}

test_requires_an_off_host_remote() {
  sed -i '/^BACKUP_REMOTE=/d' "$ENV_FILE"
  output=$(backup 2>&1) && fail 'expected failure'
  assert_contains "$output" 'BACKUP_REMOTE is required for off-host backups'
}

test_requires_rclone() {
  mkdir "$SANDBOX/bin"
  for tool in age sha256sum docker bash sh date mktemp; do
    ln -s "$(command -v "$tool")" "$SANDBOX/bin/$tool"
  done
  output=$(PATH="$SANDBOX/bin" backup 2>&1) && fail 'expected failure'
  assert_contains "$output" 'Missing required command: rclone'
}

run_tests
