# shellcheck shell=sh
# Shared helpers for the production operations scripts.
# Source from the repository root: `. ./ops/lib.sh`.

# Databases created by postgres/init.sql, one per service.
# shellcheck disable=SC2034 # used by the scripts that source this file
APP_DATABASES='miya_users miya_classes miya_registrations'

# Exports the KEY=VALUE lines of $ENV_FILE the way Docker Compose reads them:
# values may contain spaces and <>, one pair of surrounding quotes is
# removed, and nothing in the file is executed.
load_env() {
  ENV_FILE=${ENV_FILE:-.env.production}
  [ -f "$ENV_FILE" ] || { echo "Missing deployment env file: $ENV_FILE" >&2; exit 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key=${line%%=*}
    case "$line" in
      *=*) ;;
      *) echo "Invalid line in $ENV_FILE: expected KEY=VALUE" >&2; exit 1 ;;
    esac
    case "$key" in
      '' | [0-9]* | *[!A-Za-z0-9_]*)
        echo "Invalid variable name in $ENV_FILE: $key" >&2
        exit 1
        ;;
    esac
    value=${line#*=}
    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
    export "$key=$value"
  done < "$ENV_FILE"
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
