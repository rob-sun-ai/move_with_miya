#!/usr/bin/env bash
# Tests for ops/preflight-production.sh.
# shellcheck source=ops/tests/harness.sh
. "$(dirname "$0")/harness.sh"

# Runs preflight with the sandbox env file, after applying KEY=VALUE edits
# (an empty value removes the key).
preflight() {
  write_production_env
  for edit in "$@"; do
    key=${edit%%=*}
    sed -i "/^$key=/d" "$ENV_FILE"
    [ -z "${edit#*=}" ] || printf '%s\n' "$edit" >> "$ENV_FILE"
  done
  (. ./ops/lib.sh && load_env && ./ops/preflight-production.sh) 2>&1
}
expect_failure() {
  message=$1
  shift
  output=$(preflight "$@") && fail "expected failure for $*"
  assert_contains "$output" "$message"
}

test_passes_a_complete_production_configuration() {
  output=$(preflight) || fail "preflight failed: $output"
  assert_contains "$output" 'Production configuration preflight passed.'
}

test_rejects_each_missing_variable() {
  for key in NODE_ENV PUBLIC_HOST SESSION_SECRET STRIPE_WEBHOOK_SECRET \
    TLS_KEY_FILE GRAFANA_ADMIN_PASSWORD ALERT_EMAIL_TO AGE_RECIPIENT BACKUP_REMOTE; do
    setup_sandbox
    expect_failure "Missing required production variable: $key" "$key="
  done
}

test_requires_node_env_production() {
  expect_failure 'NODE_ENV must be production' NODE_ENV=staging
}

test_rejects_placeholders() {
  for edit in 'POSTGRES_PASSWORD=change-me-please' 'STRIPE_SECRET_KEY=replace-with-key' \
    'RABBITMQ_USER=guest' 'CORS_ORIGIN=https://localhost' \
    'PUBLIC_APP_URL=https://your-domain.example' 'CONTACT_EMAIL_TO=a@example.com' \
    'TURNSTILE_HOSTNAME=example.org'; do
    setup_sandbox
    expect_failure "${edit%%=*} contains a placeholder value" "$edit"
  done
}

test_requires_long_secrets() {
  expect_failure 'SESSION_SECRET must be at least 32 characters' SESSION_SECRET=0123456789abcdef
  setup_sandbox
  expect_failure 'GRAFANA_ADMIN_PASSWORD must be at least 20 characters' GRAFANA_ADMIN_PASSWORD=short-password
}

test_requires_https_urls() {
  expect_failure 'PUBLIC_APP_URL must use HTTPS' PUBLIC_APP_URL=http://studio.test
  setup_sandbox
  expect_failure 'CORS_ORIGIN must use HTTPS' CORS_ORIGIN=http://studio.test
}

test_rejects_unsafe_public_hosts() {
  for host in 'studio.test/path' 'studio.test;rm' '.studio.test' 'studio.test.' 'https://studio.test'; do
    setup_sandbox
    expect_failure 'PUBLIC_HOST must be a hostname' "PUBLIC_HOST=$host"
  done
}

test_requires_a_single_alert_email_address() {
  for address in 'ops' 'ops@studio' '@studio.test' 'ops@' 'a@b@studio.test' \
    'ops@studio.test,cto@studio.test' 'Ops <ops@studio.test>'; do
    setup_sandbox
    expect_failure 'ALERT_EMAIL_TO must be a single email address' "ALERT_EMAIL_TO=$address"
  done
}

test_requires_an_age_public_key() {
  expect_failure 'AGE_RECIPIENT must be an age public key' 'AGE_RECIPIENT=ssh-ed25519 AAAA'
}

test_requires_the_backup_tools() {
  mkdir "$SANDBOX/bin"
  for tool in docker age sha256sum sh sed; do
    ln -s "$(command -v "$tool")" "$SANDBOX/bin/$tool"
  done
  write_production_env
  output=$( (. ./ops/lib.sh && load_env && PATH="$SANDBOX/bin" ./ops/preflight-production.sh) 2>&1) \
    && fail 'expected failure'
  assert_contains "$output" 'Missing required command: rclone'
}

test_requires_readable_tls_files() {
  expect_failure 'TLS certificate is not readable' "TLS_CERT_FILE=$SANDBOX/missing.pem"
  setup_sandbox
  expect_failure 'TLS key is not readable' "TLS_KEY_FILE=$SANDBOX/missing.pem"
}

run_tests
