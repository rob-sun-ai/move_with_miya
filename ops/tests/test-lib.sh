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

test_load_env_strips_inline_comments_like_docker_compose() {
  cat > "$ENV_FILE" <<'ENV'
PLAIN=value # comment
TAB=value	# comment
HASH_INSIDE=a#b
TRAILING=value   
DOUBLE="kept # inside quotes" # comment
SINGLE='single' # it's a comment
ONLY_COMMENT= # nothing here
ENV
  output=$(. ./ops/lib.sh && load_env && sh -c \
    'printf "%s|%s|%s|%s|%s|%s|%s" "$PLAIN" "$TAB" "$HASH_INSIDE" "$TRAILING" "$DOUBLE" "$SINGLE" "$ONLY_COMMENT"')
  assert_eq "$output" 'value|value|a#b|value|kept # inside quotes|single|'
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

test_assert_git_sha_accepts_full_hex_shas() {
  (. ./ops/lib.sh && assert_git_sha V 0123456789abcdef0123456789abcdef01234567 \
    && assert_git_sha V 0123456789ABCDEF0123456789ABCDEF01234567) \
    || fail 'expected valid SHAs to pass'
}

test_assert_git_sha_rejects_anything_else() {
  for value in '' abc 0123456789abcdef0123456789abcdef0123456 \
    0123456789abcdef0123456789abcdef012345678 \
    g123456789abcdef0123456789abcdef01234567 '0123456789abcdef0123456789abcdef0123456 '; do
    output=$( (. ./ops/lib.sh && assert_git_sha ROLLBACK_VERSION "$value") 2>&1) \
      && fail "accepted '$value'"
    assert_contains "$output" 'ROLLBACK_VERSION must be a 40-character Git SHA'
  done
}

test_persist_release_version_replaces_the_recorded_release() {
  printf 'A=1\nRELEASE_VERSION=old\nB=2\n' > "$ENV_FILE"
  (. ./ops/lib.sh && persist_release_version abc)
  assert_eq "$(cat "$ENV_FILE")" 'A=1
RELEASE_VERSION=abc
B=2'
}

test_persist_release_version_adds_a_missing_release() {
  printf 'A=1\n' > "$ENV_FILE"
  (. ./ops/lib.sh && persist_release_version abc)
  assert_eq "$(cat "$ENV_FILE")" 'A=1
RELEASE_VERSION=abc'
}

test_restart_nginx_recreates_only_nginx() {
  (. ./ops/lib.sh && restart_nginx)
  assert_eq "$(cat "$SHIM_DIR/docker.log")" \
    "compose --env-file $ENV_FILE -f docker-compose.prod.yml up -d --no-deps --force-recreate nginx"
}

test_persist_release_version_appends_after_a_last_line_without_newline() {
  printf 'A=1' > "$ENV_FILE"
  (. ./ops/lib.sh && persist_release_version abc)
  assert_eq "$(cat "$ENV_FILE")" 'A=1
RELEASE_VERSION=abc'
}

test_restart_nginx_does_not_start_its_dependencies_or_migrations() {
  (. ./ops/lib.sh && restart_nginx)
  assert_eq "$(cat "$SHIM_DIR/started.log")" nginx
}

test_acquire_deploy_lock_refuses_while_another_run_holds_it() {
  export DEPLOY_LOCK_FILE="$SANDBOX/deploy.lock"
  exec 8> "$DEPLOY_LOCK_FILE"
  flock -n 8 || fail 'could not take the lock in the test'
  output=$( (. ./ops/lib.sh && acquire_deploy_lock) 2>&1) && fail 'expected failure'
  assert_contains "$output" 'Another deploy or rollback is running on this host'
  exec 8>&-
  (. ./ops/lib.sh && acquire_deploy_lock) || fail 'lock should be free again'
}

test_acquire_deploy_lock_is_released_when_the_script_exits() {
  export DEPLOY_LOCK_FILE="$SANDBOX/deploy.lock"
  (. ./ops/lib.sh && acquire_deploy_lock) || fail 'first run should get the lock'
  (. ./ops/lib.sh && acquire_deploy_lock) || fail 'second run should get the lock'
}

run_tests
