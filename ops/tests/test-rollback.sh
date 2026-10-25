#!/usr/bin/env bash
# Tests for ops/rollback.sh.
# shellcheck source=ops/tests/harness.sh
. "$(dirname "$0")/harness.sh"

TARGET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SERVICES='user-service backend classes-service registration-service frontend'

images_for() {
  for service in $SERVICES; do printf 'move-with-miya/%s:%s ' "$service" "$1"; done
}
setup_test() { export DEPLOY_LOCK_FILE="$SANDBOX/deploy.lock"; }
rollback() { ROLLBACK_VERSION=$1 ./ops/rollback.sh; }
calls() {
  sed "s|^compose --env-file $ENV_FILE -f docker-compose.prod.yml ||" "$SHIM_DIR/docker.log"
}

test_restarts_services_on_the_previous_images_without_old_migrations() {
  write_production_env
  export SHIM_IMAGES; SHIM_IMAGES=$(images_for "$TARGET")
  output=$(rollback "$TARGET" 2>&1) || fail "rollback failed: $output"
  assert_contains "$(calls)" "up -d --wait --no-build --no-deps $SERVICES"
  assert_contains "$(calls)" 'up -d --no-deps --force-recreate nginx'
  [ -z "$(calls | grep migrate)" ] || fail 'rollback ran migration jobs'
  # Nor may Compose start them as dependencies of what rollback starts.
  [ -z "$(grep migrate "$SHIM_DIR/started.log")" ] \
    || fail "compose up started: $(grep migrate "$SHIM_DIR/started.log" | xargs)"
  assert_contains "$output" "Rolled back to $TARGET."
}

test_runs_compose_with_the_rollback_release() {
  write_production_env
  export SHIM_IMAGES; SHIM_IMAGES=$(images_for "$TARGET")
  rollback "$TARGET" >/dev/null 2>&1 || fail 'rollback failed'
  grep -A1000 'up -d --no-build' "$SHIM_DIR/docker.log" >/dev/null
  assert_eq "$(tail -1 "$SHIM_DIR/release.log")" "$TARGET"
  assert_contains "$(cat "$ENV_FILE")" "RELEASE_VERSION=$TARGET"
}

test_refuses_when_an_image_for_the_release_is_missing() {
  write_production_env
  export SHIM_IMAGES; SHIM_IMAGES=$(images_for "$TARGET" | sed 's|move-with-miya/frontend:[a-f0-9]*||')
  output=$(rollback "$TARGET" 2>&1) && fail 'expected failure'
  assert_contains "$output" "Image move-with-miya/frontend:$TARGET is not on this host"
  [ -z "$(calls | grep 'up -d')" ] || fail 'services were restarted'
  assert_contains "$(cat "$ENV_FILE")" 'RELEASE_VERSION=0000000000000000000000000000000000000000'
}

test_does_not_record_the_release_when_smoke_checks_fail() {
  write_production_env
  export SHIM_IMAGES; SHIM_IMAGES=$(images_for "$TARGET")
  export SHIM_FAIL_CURL=/health/live
  rollback "$TARGET" >/dev/null 2>&1 && fail 'expected failure'
  assert_contains "$(cat "$ENV_FILE")" 'RELEASE_VERSION=0000000000000000000000000000000000000000'
}

test_refuses_to_run_while_another_deploy_holds_the_lock() {
  write_production_env
  export SHIM_IMAGES; SHIM_IMAGES=$(images_for "$TARGET")
  exec 8> "$DEPLOY_LOCK_FILE"
  flock -n 8 || fail 'could not take the lock in the test'
  output=$(rollback "$TARGET" 2>&1) && fail 'expected failure'
  assert_contains "$output" 'Another deploy or rollback is running on this host'
  assert_eq "$(cat "$SHIM_DIR/docker.log")" ''
}

test_requires_a_full_git_sha() {
  write_production_env
  for version in '' abc123 "${TARGET}0" 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' "$TARGET;rm"; do
    output=$(rollback "$version" 2>&1) && fail "accepted '$version'"
    assert_contains "$output" 'ROLLBACK_VERSION must be a 40-character Git SHA'
  done
  assert_eq "$(cat "$SHIM_DIR/docker.log")" ''
}

run_tests
