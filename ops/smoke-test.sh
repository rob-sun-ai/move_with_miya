#!/usr/bin/env sh
set -eu

base_url=${1:?Usage: ops/smoke-test.sh https://your-domain.example}
base_url=${base_url%/}
case "$base_url" in
  https://*) ;;
  *) echo 'Smoke tests require an HTTPS base URL' >&2; exit 1 ;;
esac

curl --fail --silent --show-error "$base_url/health/live" >/dev/null
curl --fail --silent --show-error "$base_url/health/ready" >/dev/null
curl --fail --silent --show-error "$base_url/classes" >/dev/null

echo 'Unauthenticated production smoke checks passed.'
echo 'Run the authenticated checklist in docs/production-runbook.md before declaring a release complete.'
