#!/usr/bin/env bash
# Tests for ops/deploy.sh.
# shellcheck source=ops/tests/harness.sh
. "$(dirname "$0")/harness.sh"

# Each test deploys from its own clean, committed checkout (via GIT_DIR and
# GIT_WORK_TREE), so the result does not depend on this repository's state.
setup_test() {
  export GIT_WORK_TREE="$SANDBOX/checkout" GIT_DIR="$SANDBOX/checkout/.git"
  mkdir "$GIT_WORK_TREE"
  git init -q "$GIT_WORK_TREE"
  printf 'v1\n' > "$GIT_WORK_TREE/tracked.txt"
  git add tracked.txt
  git -c user.name=test -c user.email=test@example.test commit -q -m initial
  HEAD_SHA=$(git rev-parse HEAD)
}

deploy() { ./ops/deploy.sh; }
# docker calls, without the env/compose-file prefix, one per line.
calls() {
  sed "s|^compose --env-file $ENV_FILE -f docker-compose.prod.yml ||" "$SHIM_DIR/docker.log"
}
# Line number of the first call matching $1.
line_of() { calls | grep -n -m1 -- "$1" | cut -d: -f1; }

test_deploys_the_checked_out_commit_in_order() {
  write_production_env
  output=$(deploy 2>&1) || fail "deploy failed: $output"
  for step in 'config --quiet' build 'up -d --wait redis postgres rabbitmq' \
    'exec -T postgres' 'run --rm user-migrate' 'run --rm classes-migrate' \
    'run --rm registration-migrate' \
    'up -d --wait --no-deps user-service backend classes-service registration-service frontend' \
    'up -d --no-deps --force-recreate nginx' \
    'up -d --no-deps otel-collector prometheus alertmanager loki promtail tempo grafana'; do
    [ -n "$(line_of "$step")" ] || fail "missing step: $step"
  done
  [ "$(line_of 'exec -T postgres')" -lt "$(line_of 'run --rm user-migrate')" ] \
    || fail 'backup must run before migrations'
  [ "$(line_of 'run --rm registration-migrate')" -lt "$(line_of 'up -d --wait --no-deps user-service')" ] \
    || fail 'migrations must finish before services start'
  [ "$(line_of 'up -d --wait --no-deps user-service')" -lt "$(line_of 'force-recreate nginx')" ] \
    || fail 'nginx must be recreated after services are recreated'
  assert_contains "$output" "Deployment completed for $HEAD_SHA."
}

test_builds_and_runs_with_the_commit_as_release_version() {
  write_production_env
  deploy >/dev/null 2>&1 || fail 'deploy failed'
  # The backup script reloads the env file for its own compose exec calls
  # into running containers, where the image tag does not matter.
  releases=$(paste -d' ' "$SHIM_DIR/release.log" "$SHIM_DIR/docker.log" \
    | grep -v -e 'exec -T postgres' -e 'exec -T alertmanager' | cut -d' ' -f1 | sort -u)
  assert_eq "$releases" "$HEAD_SHA"
}

test_runs_migrations_only_as_one_shot_jobs() {
  write_production_env
  deploy >/dev/null 2>&1 || fail 'deploy failed'
  # `compose up` must not start the migration jobs again as dependencies.
  [ -z "$(grep migrate "$SHIM_DIR/started.log")" ] \
    || fail "compose up started: $(grep migrate "$SHIM_DIR/started.log" | xargs)"
}

test_records_the_release_after_smoke_checks_pass() {
  write_production_env
  deploy >/dev/null 2>&1 || fail 'deploy failed'
  assert_eq "$(grep -c '^RELEASE_VERSION=' "$ENV_FILE")" 1
  assert_contains "$(cat "$ENV_FILE")" "RELEASE_VERSION=$HEAD_SHA"
  assert_contains "$(cat "$SHIM_DIR/curl.log")" 'https://studio.test/health/ready'
}

test_does_not_record_the_release_when_smoke_checks_fail() {
  write_production_env
  export SHIM_FAIL_CURL=/classes
  deploy >/dev/null 2>&1 && fail 'expected failure'
  assert_contains "$(cat "$ENV_FILE")" 'RELEASE_VERSION=0000000000000000000000000000000000000000'
}

test_prints_the_rollback_command_when_smoke_checks_fail() {
  write_production_env
  previous=abcdefabcdefabcdefabcdefabcdefabcdefabcd
  sed -i "s/^RELEASE_VERSION=.*/RELEASE_VERSION=$previous/" "$ENV_FILE"
  export SHIM_FAIL_CURL=/classes
  output=$(deploy 2>&1) && fail 'expected failure'
  assert_contains "$output" "Smoke checks failed. $HEAD_SHA was not recorded"
  assert_contains "$output" "ROLLBACK_VERSION=$previous ENV_FILE=$ENV_FILE ./ops/rollback.sh"
}

test_prints_the_rollback_command_when_services_stay_unhealthy() {
  write_production_env
  previous=abcdefabcdefabcdefabcdefabcdefabcdefabcd
  sed -i "s/^RELEASE_VERSION=.*/RELEASE_VERSION=$previous/" "$ENV_FILE"
  export SHIM_FAIL_UP=backend
  output=$(deploy 2>&1) && fail 'expected failure'
  assert_contains "$output" "Application services did not become healthy. $HEAD_SHA was not recorded"
  assert_contains "$output" "ROLLBACK_VERSION=$previous ENV_FILE=$ENV_FILE ./ops/rollback.sh"
  [ -z "$(line_of 'nginx')" ] || fail 'nginx was recreated in front of unhealthy services'
  assert_contains "$(cat "$ENV_FILE")" "RELEASE_VERSION=$previous"
}

test_prints_the_rollback_command_when_nginx_cannot_be_recreated() {
  write_production_env
  previous=abcdefabcdefabcdefabcdefabcdefabcdefabcd
  sed -i "s/^RELEASE_VERSION=.*/RELEASE_VERSION=$previous/" "$ENV_FILE"
  export SHIM_FAIL_UP=nginx
  output=$(deploy 2>&1) && fail 'expected failure'
  assert_contains "$output" "nginx could not be recreated. $HEAD_SHA was not recorded"
  assert_contains "$output" "ROLLBACK_VERSION=$previous ENV_FILE=$ENV_FILE ./ops/rollback.sh"
  assert_contains "$(cat "$ENV_FILE")" "RELEASE_VERSION=$previous"
}

test_says_when_there_is_no_release_to_roll_back_to() {
  write_production_env
  sed -i 's/^RELEASE_VERSION=.*/RELEASE_VERSION=replace-with-git-sha/' "$ENV_FILE"
  export SHIM_FAIL_CURL=/classes
  output=$(deploy 2>&1) && fail 'expected failure'
  assert_contains "$output" 'No previous release is recorded to roll back to.'
}

test_refuses_to_deploy_a_checkout_with_uncommitted_changes() {
  write_production_env
  printf 'v2\n' > "$GIT_WORK_TREE/tracked.txt"
  output=$(deploy 2>&1) && fail 'expected failure'
  assert_contains "$output" 'The checkout has uncommitted changes'
  assert_contains "$output" 'tracked.txt'
  assert_eq "$(cat "$SHIM_DIR/docker.log")" ''
}

test_ignores_untracked_files_in_the_checkout() {
  write_production_env
  printf 'notes\n' > "$GIT_WORK_TREE/notes.txt"
  deploy >/dev/null 2>&1 || fail 'deploy failed'
}

test_refuses_to_run_while_another_deploy_holds_the_lock() {
  write_production_env
  exec 8> "$(git rev-parse --git-path move-with-miya-deploy.lock)"
  flock -n 8 || fail 'could not take the lock in the test'
  output=$(deploy 2>&1) && fail 'expected failure'
  assert_contains "$output" 'Another deploy or rollback is running on this host'
  assert_eq "$(cat "$SHIM_DIR/docker.log")" ''
}

test_refuses_a_release_version_other_than_the_checkout() {
  write_production_env
  output=$(RELEASE_VERSION=1111111111111111111111111111111111111111 deploy 2>&1) \
    && fail 'expected failure'
  assert_contains "$output" 'does not match the checked-out commit'
  assert_eq "$(cat "$SHIM_DIR/docker.log")" ''
}

test_accepts_the_workflow_passing_the_checked_out_commit() {
  write_production_env
  RELEASE_VERSION=$HEAD_SHA deploy >/dev/null 2>&1 || fail 'deploy failed'
}

test_stops_before_touching_anything_when_preflight_fails() {
  write_production_env
  sed -i 's|^PUBLIC_APP_URL=.*|PUBLIC_APP_URL=http://studio.test|' "$ENV_FILE"
  output=$(deploy 2>&1) && fail 'expected failure'
  assert_contains "$output" 'PUBLIC_APP_URL must use HTTPS'
  assert_eq "$(cat "$SHIM_DIR/docker.log")" ''
}

test_stops_before_migrating_when_the_backup_fails() {
  write_production_env
  export SHIM_FAIL_DUMP=miya_users
  deploy >/dev/null 2>&1 && fail 'expected failure'
  [ -z "$(line_of 'run --rm')" ] || fail 'migrations ran after a failed backup'
}

test_stops_before_starting_services_when_a_migration_fails() {
  write_production_env
  export SHIM_FAIL_RUN=classes-migrate
  deploy >/dev/null 2>&1 && fail 'expected failure'
  [ -z "$(line_of 'run --rm registration-migrate')" ] || fail 'later migrations ran'
  [ -z "$(line_of 'up -d --wait --no-deps user-service')" ] || fail 'services started after a failed migration'
}

run_tests
