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
  : > "$SHIM_DIR/curl.log"
  : > "$SHIM_DIR/release.log"
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

# Appends a complete, valid production configuration to $ENV_FILE.
write_production_env() {
  printf 'certificate' > "$SANDBOX/fullchain.pem"
  printf 'key' > "$SANDBOX/privkey.pem"
  cat >> "$ENV_FILE" <<ENV
NODE_ENV=production
PUBLIC_HOST=studio.test
POSTGRES_USER=miya
POSTGRES_PASSWORD=a-long-random-postgres-password
POSTGRES_DB=miya
RABBITMQ_USER=miya
RABBITMQ_PASS=a-long-random-rabbit-password
SESSION_SECRET=0123456789abcdef0123456789abcdef
CORS_ORIGIN=https://studio.test
PUBLIC_APP_URL=https://studio.test
GOOGLE_CLIENT_ID=client-id
GOOGLE_CLIENT_SECRET=client-secret
GOOGLE_CALLBACK_URL=https://studio.test/api/auth/google/callback
NEXT_PUBLIC_AUTH_URL=https://studio.test/api/auth/google
NEXT_PUBLIC_TURNSTILE_SITE_KEY=site-key
CONTACT_CHALLENGE_SECRET=challenge-secret
TURNSTILE_SECRET_KEY=turnstile-secret
TURNSTILE_HOSTNAME=studio.test
RESEND_API_KEY=re_live_key
CONTACT_EMAIL_TO=studio@studio.test
RESEND_FROM_EMAIL=Move with Miya <hello@studio.test>
STRIPE_SECRET_KEY=sk_live_key
STRIPE_WEBHOOK_SECRET=whsec_key
STRIPE_CURRENCY=usd
TLS_CERT_FILE=$SANDBOX/fullchain.pem
TLS_KEY_FILE=$SANDBOX/privkey.pem
GRAFANA_ADMIN_PASSWORD=a-long-grafana-admin-password
ALERT_EMAIL_TO=ops@studio.test
RELEASE_VERSION=0000000000000000000000000000000000000000
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
