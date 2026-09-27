# shellcheck shell=sh
# Shared helpers for the production operations scripts.
# Source from the repository root: `. ./ops/lib.sh`.

# Databases created by postgres/init.sql, one per service.
# shellcheck disable=SC2034 # used by the scripts that source this file
APP_DATABASES='miya_users miya_classes miya_registrations'

# Exports the KEY=VALUE lines of $ENV_FILE the way Docker Compose reads them:
# values may contain spaces and <>, one pair of surrounding quotes is
# removed, a ` #` after an unquoted value (or after the closing quote) starts
# a comment, and nothing in the file is executed.
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
    quoted=
    case "$value" in
      \"*\"* | \'*\'*)
        quote=${value%"${value#?}"}
        rest=${value#?}
        # The value ends at the last quote, or at the first one when a
        # comment containing a quote follows it. Only spaces or a ` #`
        # comment may follow the closing quote.
        for after in "${rest##*"$quote"}" "${rest#*"$quote"}"; do
          trimmed=${after#"${after%%[![:space:]]*}"}
          case "$trimmed" in
            '') quoted=yes ;;
            '#'*) [ "$trimmed" = "$after" ] || quoted=yes ;;
          esac
          if [ -n "$quoted" ]; then
            value=${rest%"$quote$after"}
            break
          fi
        done
        ;;
    esac
    if [ -z "$quoted" ]; then
      value=${value%%[[:space:]]'#'*}
      value=${value%"${value##*[![:space:]]}"}
    fi
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

# Usage: assert_git_sha NAME VALUE
assert_git_sha() {
  case "$2" in
    *[!A-Fa-f0-9]*|'') echo "$1 must be a 40-character Git SHA" >&2; exit 1 ;;
  esac
  [ "${#2}" -eq 40 ] || { echo "$1 must be a 40-character Git SHA" >&2; exit 1; }
}

# nginx resolves upstream hostnames once at startup, so reload it after
# application containers are recreated with new addresses.
reload_nginx() {
  compose up -d nginx
  compose exec -T nginx nginx -s reload
}

# Records the running release in the env file so later compose commands and
# rollbacks resolve the same image tags.
persist_release_version() {
  if grep -q '^RELEASE_VERSION=' "$ENV_FILE"; then
    sed -i "s/^RELEASE_VERSION=.*/RELEASE_VERSION=$1/" "$ENV_FILE"
  else
    printf 'RELEASE_VERSION=%s\n' "$1" >> "$ENV_FILE"
  fi
}
