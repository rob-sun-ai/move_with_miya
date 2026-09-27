#!/usr/bin/env bash
# Tests for ops/lib.sh.
# shellcheck source=ops/tests/harness.sh
. "$(dirname "$0")/harness.sh"

test_load_env_exports_the_env_file() {
  printf 'SOME_SETTING=from-file\n' >> "$ENV_FILE"
  output=$(. ./ops/lib.sh && load_env && sh -c 'echo "$SOME_SETTING"')
  assert_eq "$output" from-file
}

test_load_env_rejects_a_missing_file() {
  export ENV_FILE="$SANDBOX/missing"
  output=$( (. ./ops/lib.sh && load_env) 2>&1) && fail 'expected failure'
  assert_contains "$output" "Missing deployment env file: $SANDBOX/missing"
}

test_load_env_defaults_to_env_production() {
  unset ENV_FILE
  output=$( (cd "$SANDBOX" && . "$ROOT/ops/lib.sh" && load_env) 2>&1) && fail 'expected failure'
  assert_contains "$output" 'Missing deployment env file: .env.production'
}

test_compose_uses_the_env_file_and_production_compose_file() {
  (. ./ops/lib.sh && load_env && compose ps)
  assert_eq "$(cat "$SHIM_DIR/docker.log")" \
    "compose --env-file $ENV_FILE -f docker-compose.prod.yml ps"
}

test_require_command_accepts_installed_commands() {
  (. ./ops/lib.sh && require_command sh age) || fail 'expected success'
}

test_require_command_names_the_missing_command() {
  output=$( (. ./ops/lib.sh && require_command sh no-such-tool-xyz) 2>&1) && fail 'expected failure'
  assert_contains "$output" 'Missing required command: no-such-tool-xyz'
}

test_app_databases_match_postgres_init() {
  expected=$(sed -n 's/^CREATE DATABASE \(.*\);$/\1/p' postgres/init.sql | xargs)
  assert_eq "$(. ./ops/lib.sh && echo "$APP_DATABASES")" "$expected"
}

run_tests
