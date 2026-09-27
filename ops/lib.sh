# Shared helpers for the production operations scripts.
# Source from the repository root: `. ./ops/lib.sh`.

# Databases created by postgres/init.sql, one per service.
APP_DATABASES='miya_users miya_classes miya_registrations'

load_env() {
  ENV_FILE=${ENV_FILE:-.env.production}
  [ -f "$ENV_FILE" ] || { echo "Missing deployment env file: $ENV_FILE" >&2; exit 1; }
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

compose() {
  docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml "$@"
}

# Usage: require_command NAME...
require_command() {
  for command_name in "$@"; do
    command -v "$command_name" >/dev/null 2>&1 || {
      echo "Missing required command: $command_name" >&2
      exit 1
    }
  done
}
