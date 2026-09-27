#!/usr/bin/env bash
# Tests for ops/lib.sh.
# shellcheck source=ops/tests/harness.sh
. "$(dirname "$0")/harness.sh"

test_load_env_exports_the_env_file() {
  printf 'SOME_SETTING=from-file\n' >> "$ENV_FILE"
  output=$(. ./ops/lib.sh && load_env && sh -c 'echo "$SOME_SETTING"')
  assert_eq "$output" from-file
}

test_load_env_reads_values_like_docker_compose() {
  cat > "$ENV_FILE" <<'ENV'
# comment

FROM=Move with Miya <hello@studio.test>
DOUBLE="quoted value"
SINGLE='single quoted'
EQUALS=a=b=c
EMPTY=
SPACES_INSIDE="  padded  "
ENV
  output=$(. ./ops/lib.sh && load_env && sh -c \
    'printf "%s|%s|%s|%s|%s|%s" "$FROM" "$DOUBLE" "$SINGLE" "$EQUALS" "$EMPTY" "$SPACES_INSIDE"')
  assert_eq "$output" 'Move with Miya <hello@studio.test>|quoted value|single quoted|a=b=c||  padded  '
}

test_load_env_never_executes_the_file() {
  # shellcheck disable=SC2016
  printf 'INJECTED=$(touch %s/pwned)\nTICKS=`touch %s/pwned`\n' "$SANDBOX" "$SANDBOX" > "$ENV_FILE"
  output=$(. ./ops/lib.sh && load_env && printf '%s' "$INJECTED")
  assert_no_file "$SANDBOX/pwned"
  assert_eq "$output" "\$(touch $SANDBOX/pwned)"
}

test_load_env_reads_a_last_line_without_a_newline() {
  printf 'LAST=value' > "$ENV_FILE"
  assert_eq "$(. ./ops/lib.sh && load_env && printf '%s' "$LAST")" value
}

test_load_env_rejects_malformed_lines() {
  for line in 'NOT A PAIR' '1BAD=value' 'BAD-NAME=value' '=value' 'export FOO=bar'; do
    printf '%s\n' "$line" > "$ENV_FILE"
    output=$( (. ./ops/lib.sh && load_env) 2>&1) && fail "accepted '$line'"
    assert_contains "$output" "Invalid"
  done
}

test_load_env_reads_the_production_example() {
  cp .env.production.example "$ENV_FILE"
  output=$(. ./ops/lib.sh && load_env && printf '%s' "$RESEND_FROM_EMAIL") \
    || fail 'the example env file does not load'
  assert_eq "$output" 'Move with Miya <hello@your-domain.example>'
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
