#!/usr/bin/env bash
# Tests for ops/deploy.sh.
# shellcheck source=ops/tests/harness.sh
. "$(dirname "$0")/harness.sh"

HEAD_SHA=$(git rev-parse HEAD)

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
    'up -d user-service backend classes-service registration-service frontend' \
    'up -d nginx' 'exec -T nginx nginx -s reload' \
    'up -d otel-collector prometheus alertmanager loki promtail tempo grafana'; do
    [ -n "$(line_of "$step")" ] || fail "missing step: $step"
  done
  [ "$(line_of 'exec -T postgres')" -lt "$(line_of 'run --rm user-migrate')" ] \
    || fail 'backup must run before migrations'
  [ "$(line_of 'run --rm registration-migrate')" -lt "$(line_of 'up -d user-service')" ] \
    || fail 'migrations must finish before services start'
  [ "$(line_of 'up -d user-service')" -lt "$(line_of 'nginx -s reload')" ] \
    || fail 'nginx must reload after services are recreated'
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
  [ -z "$(line_of 'up -d user-service')" ] || fail 'services started after a failed migration'
}

run_tests
