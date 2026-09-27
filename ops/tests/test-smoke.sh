#!/usr/bin/env bash
# Tests for ops/smoke-test.sh.
# shellcheck source=ops/tests/harness.sh
. "$(dirname "$0")/harness.sh"

test_checks_health_and_the_public_class_list() {
  output=$(./ops/smoke-test.sh https://studio.test/ 2>&1) || fail "$output"
  assert_eq "$(cat "$SHIM_DIR/curl.log")" "https://studio.test/health/live
https://studio.test/health/ready
https://studio.test/classes"
  assert_contains "$output" 'Unauthenticated production smoke checks passed.'
}

test_fails_when_a_check_fails() {
  export SHIM_FAIL_CURL=/health/ready
  ./ops/smoke-test.sh https://studio.test >/dev/null 2>&1 && fail 'expected failure'
  assert_eq "$(wc -l < "$SHIM_DIR/curl.log" | tr -d ' ')" 2
}

test_requires_https() {
  output=$(./ops/smoke-test.sh http://studio.test 2>&1) && fail 'expected failure'
  assert_contains "$output" 'Smoke tests require an HTTPS base URL'
  assert_eq "$(cat "$SHIM_DIR/curl.log")" ''
}

test_requires_a_base_url() {
  output=$(./ops/smoke-test.sh 2>&1) && fail 'expected failure'
  assert_contains "$output" 'Usage: ops/smoke-test.sh'
}

run_tests
