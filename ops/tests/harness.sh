# shellcheck shell=bash
# Minimal test harness for the ops scripts. Source it from a test file, define
# test_* functions, then call run_tests. Each test runs in a subshell with a
# fresh $SANDBOX, a docker test double on PATH, and an age key pair.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT" || exit 1

setup_sandbox() {
  SANDBOX=$(mktemp -d)
  export SHIM_DIR="$SANDBOX/shim"
  mkdir -p "$SHIM_DIR" "$SANDBOX/remote" "$SANDBOX/backups"
  : > "$SHIM_DIR/docker.log"
  : > "$SHIM_DIR/alerts.log"
  export PATH="$ROOT/ops/tests/shims:$PATH"
  age-keygen -o "$SANDBOX/key.txt" 2>/dev/null
  AGE_PUBLIC_KEY=$(age-keygen -y "$SANDBOX/key.txt")
  export ENV_FILE="$SANDBOX/env"
  cat > "$ENV_FILE" <<ENV
AGE_RECIPIENT=$AGE_PUBLIC_KEY
BACKUP_REMOTE=:local:$SANDBOX/remote
BACKUP_DIR=$SANDBOX/backups
ENV
}

fail() {
  echo "    $*" >&2
  exit 1
}
assert_eq() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'${3:+ ($3)}"; }
assert_contains() {
  case "$1" in *"$2"*) ;; *) fail "expected output to contain '$2'; got: $1" ;; esac
}
assert_file() { [ -f "$1" ] || fail "missing file $1"; }
assert_no_file() { [ ! -e "$1" ] || fail "unexpected file $1"; }

run_tests() {
  local passed=0 failed=0 name output
  for name in $(declare -F | awk '{ print $3 }' | grep '^test_'); do
    if output=$( (setup_sandbox && "$name") 2>&1 ); then
      echo "ok   ${name#test_}"
      passed=$((passed + 1))
    else
      echo "FAIL ${name#test_}"
      printf '%s\n' "$output" | sed 's/^/    /'
      failed=$((failed + 1))
    fi
  done
  echo "$(basename "$0"): $passed passed, $failed failed"
  [ "$failed" -eq 0 ]
}
