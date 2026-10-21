#!/bin/sh
# Alertmanager cannot read the environment, so render alertmanager.yml.tmpl
# from it and then exec Alertmanager with any extra arguments.
#
# Values are substituted literally (no regex or `&` handling) and escaped for
# the template's single-quoted YAML scalars, so names such as
# "O'Brien & Co <ops@example.com>" are safe. With --render-only it writes the
# config and exits, which the tests use.
set -eu

template=/etc/alertmanager/alertmanager.yml.tmpl
config=${ALERTMANAGER_CONFIG:-/tmp/alertmanager.yml}

awk '
  function quoted(name,   value) {
    value = ENVIRON[name]
    if (index(value, "\n")) {
      printf "%s must be a single line\n", name > "/dev/stderr"
      exit 1
    }
    gsub("\047", "\047\047", value)
    return value
  }
  function replace(text, placeholder, value,   out, at) {
    out = ""
    while ((at = index(text, placeholder)) > 0) {
      out = out substr(text, 1, at - 1) value
      text = substr(text, at + length(placeholder))
    }
    return out text
  }
  BEGIN {
    to = quoted("ALERT_EMAIL_TO")
    from = quoted("ALERT_EMAIL_FROM")
    heartbeat = quoted("ALERT_HEARTBEAT_URL")
  }
  /__ALERT_HEARTBEAT_WEBHOOK__/ {
    if (heartbeat != "") {
      print "    webhook_configs:"
      print "      - url: \047" heartbeat "\047"
      print "        send_resolved: false"
    }
    next
  }
  {
    line = replace($0, "__ALERT_EMAIL_TO__", to)
    print replace(line, "__ALERT_EMAIL_FROM__", from)
  }
' "$template" >"$config"

if [ "${1:-}" = --render-only ]; then
  exit 0
fi
exec /bin/alertmanager --config.file="$config" --storage.path=/alertmanager "$@"
