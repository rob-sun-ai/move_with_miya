#!/usr/bin/env sh
set -eu
. ./ops/lib.sh
acquire_deploy_lock

# Images are tagged with the commit they are built from, so the release
# version must be the checked-out commit, and the checkout must be clean.
head_sha=$(git rev-parse HEAD)
if [ -n "${RELEASE_VERSION:-}" ] && [ "$RELEASE_VERSION" != "$head_sha" ]; then
  echo "RELEASE_VERSION ($RELEASE_VERSION) does not match the checked-out commit ($head_sha)" >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "The checkout has uncommitted changes; images would not match $head_sha:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi
load_env
previous_release=${RELEASE_VERSION:-}
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
# Migrations and infrastructure are done; --no-deps keeps Compose from
# re-running the migration jobs, and --wait gates nginx on healthy services.
compose up -d --wait --no-deps user-service backend classes-service registration-service frontend
reload_nginx
compose up -d --no-deps otel-collector prometheus alertmanager loki promtail tempo grafana

./ops/smoke-test.sh "${PUBLIC_APP_URL:?PUBLIC_APP_URL is required}" || {
  echo "Smoke checks failed. $RELEASE_VERSION is serving but was not recorded as the release." >&2
  case "$previous_release" in
    *[!A-Fa-f0-9]* | '') echo 'No previous release is recorded to roll back to.' >&2 ;;
    *)
      echo 'To roll back the application (database migrations stay applied):' >&2
      echo "  ROLLBACK_VERSION=$previous_release ENV_FILE=$ENV_FILE ./ops/rollback.sh" >&2
      ;;
  esac
  exit 1
}
persist_release_version "$RELEASE_VERSION"
echo "Deployment completed for $RELEASE_VERSION."
