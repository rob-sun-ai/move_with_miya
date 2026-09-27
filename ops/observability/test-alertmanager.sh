#!/usr/bin/env bash
# Starts the production alertmanager service and checks that it rendered its
# recipients, mounted the Resend key as a secret, and accepts alerts.
# Run from the repository root with the production variables exported.
set -euo pipefail
cd "$(dirname "$0")/../.."

project=miya-alertmanager-test
compose() {
  docker compose -p "$project" -f docker-compose.prod.yml "$@"
}
cleanup() { compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

compose up -d --no-deps alertmanager >/dev/null 2>&1
for _ in $(seq 1 30); do
  compose exec -T alertmanager wget -qO- http://localhost:9093/-/ready >/dev/null 2>&1 && break
  sleep 1
done

failures=0
check() {
  if [ "$2" = "$3" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1: expected '$2', got '$3'"
    failures=$((failures + 1))
  fi
}
in_container() { compose exec -T alertmanager sh -c "$1"; }

check 'Alertmanager is ready' OK "$(in_container 'wget -qO- http://localhost:9093/-/ready')"
check 'alerts go to ALERT_EMAIL_TO' "      - to: '$ALERT_EMAIL_TO'" \
  "$(in_container "grep -- '- to:' /tmp/alertmanager.yml")"
check 'alerts come from RESEND_FROM_EMAIL' "  smtp_from: '$RESEND_FROM_EMAIL'" \
  "$(in_container "grep smtp_from /tmp/alertmanager.yml")"
check 'no placeholders remain' 0 \
  "$(in_container "grep -c __ALERT_ /tmp/alertmanager.yml || true")"
check 'the Resend key is a secret file' "$RESEND_API_KEY" \
  "$(in_container 'cat /run/secrets/resend_api_key')"
check 'the Resend key is not in the config' 0 \
  "$(in_container "grep -c -- '$RESEND_API_KEY' /tmp/alertmanager.yml || true")"
check 'the rendered config is valid' 0 \
  "$(in_container 'amtool check-config /tmp/alertmanager.yml >/dev/null; echo $?')"
in_container "amtool alert add CiTestAlert severity=warning \
  --annotation='summary=\"CI test\"' --alertmanager.url=http://localhost:9093" >/dev/null 2>&1
check 'alerts are accepted' CiTestAlert \
  "$(in_container 'amtool alert query CiTestAlert -o simple --alertmanager.url=http://localhost:9093' \
    | awk 'NR == 2 { print $1 }')"

[ "$failures" -eq 0 ] || { echo "$failures alertmanager check(s) failed" >&2; exit 1; }
echo 'Alertmanager checks passed.'
