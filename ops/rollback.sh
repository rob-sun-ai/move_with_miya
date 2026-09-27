#!/usr/bin/env sh
set -eu
. ./ops/lib.sh

load_env
assert_git_sha ROLLBACK_VERSION "${ROLLBACK_VERSION:-}"
export RELEASE_VERSION="$ROLLBACK_VERSION"

echo 'Application rollback only: database migrations are not automatically reversed.'
echo 'Restore the database from a verified backup before attempting a destructive schema rollback.'

services='user-service backend classes-service registration-service frontend'
for service in $services; do
  docker image inspect "move-with-miya/$service:$RELEASE_VERSION" >/dev/null 2>&1 || {
    echo "Image move-with-miya/$service:$RELEASE_VERSION is not on this host; deploy that commit instead." >&2
    exit 1
  }
done

# --no-deps: do not run the older release's migration jobs against the
# already-migrated databases.
# shellcheck disable=SC2086
compose up -d --no-build --no-deps $services
reload_nginx
./ops/smoke-test.sh "${PUBLIC_APP_URL:?PUBLIC_APP_URL is required}"
persist_release_version "$RELEASE_VERSION"
echo "Rolled back to $RELEASE_VERSION."
