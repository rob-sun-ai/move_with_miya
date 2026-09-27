#!/usr/bin/env sh
set -eu
. ./ops/lib.sh

# Images are tagged with the commit they are built from, so the release
# version must be the checked-out commit.
head_sha=$(git rev-parse HEAD)
if [ -n "${RELEASE_VERSION:-}" ] && [ "$RELEASE_VERSION" != "$head_sha" ]; then
  echo "RELEASE_VERSION ($RELEASE_VERSION) does not match the checked-out commit ($head_sha)" >&2
  exit 1
fi
load_env
export RELEASE_VERSION="$head_sha"

./ops/preflight-production.sh
compose config --quiet
compose build
compose up -d --wait redis postgres rabbitmq
# Migrations are not reversible; keep a restorable copy of the data first.
./ops/backup-postgres.sh
for job in user-migrate classes-migrate registration-migrate; do
  compose run --rm "$job"
done
compose up -d user-service backend classes-service registration-service frontend
reload_nginx
compose up -d otel-collector prometheus alertmanager loki promtail tempo grafana

./ops/smoke-test.sh "${PUBLIC_APP_URL:?PUBLIC_APP_URL is required}"
persist_release_version "$RELEASE_VERSION"
echo "Deployment completed for $RELEASE_VERSION."
