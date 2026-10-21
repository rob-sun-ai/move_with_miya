#!/usr/bin/env sh
set -eu

base_url=${1:?Usage: ops/smoke-test.sh https://your-domain.example}
base_url=${base_url%/}
case "$base_url" in
  https://*) ;;
  *) echo 'Smoke tests require an HTTPS base URL' >&2; exit 1 ;;
esac

# Retries cover services that are still warming up after a restart
# (connection refused, timeouts, and 5xx responses).
check() {
  curl --fail --silent --show-error --max-time 10 \
    --retry 5 --retry-delay 3 --retry-connrefused "$1" >/dev/null
}
check "$base_url/health/live"
check "$base_url/health/ready"
check "$base_url/classes"

echo 'Unauthenticated production smoke checks passed.'
echo 'Run the authenticated checklist in docs/production-runbook.md before declaring a release complete.'
