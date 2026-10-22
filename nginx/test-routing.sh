#!/usr/bin/env bash
# Runs nginx.prod.conf with a throwaway certificate and checks its routing:
# HTTP redirects, blocked internal endpoints, proxied routes, and HSTS.
# Upstreams are unreachable on purpose, so proxied routes answer 502.
set -euo pipefail
cd "$(dirname "$0")/.."

host=ci.example.test
container=miya-nginx-routing-test
work=$(mktemp -d)
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/acme/.well-known/acme-challenge"
echo acme-token >"$work/acme/.well-known/acme-challenge/token"
chmod -R a+rX "$work"

docker run --rm -v "$work:/out" alpine/openssl req -x509 -newkey rsa:2048 \
  -nodes -days 1 -subj "/CN=$host" \
  -keyout /out/privkey.pem -out /out/fullchain.pem >/dev/null 2>&1
docker run -d --name "$container" -p 127.0.0.1::80 -p 127.0.0.1::443 \
  --add-host user-service:127.0.0.1 \
  --add-host frontend:127.0.0.1 \
  --add-host backend:127.0.0.1 \
  -e PUBLIC_HOST="$host" \
  -e TLS_CERT_FILE=/etc/nginx/tls/fullchain.pem \
  -e TLS_KEY_FILE=/etc/nginx/tls/privkey.pem \
  -v "$PWD/nginx/nginx.prod.conf:/etc/nginx/templates/default.conf.template:ro" \
  -v "$work:/etc/nginx/tls:ro" \
  -v "$work/acme:/var/www/acme:ro" \
  nginx:1.31.7-alpine >/dev/null
http_port=$(docker port "$container" 80 | head -1 | cut -d: -f2)
https_port=$(docker port "$container" 443 | head -1 | cut -d: -f2)

https() {
  curl -sk --resolve "$host:$https_port:127.0.0.1" "$@"
}
for _ in $(seq 1 30); do
  https -o /dev/null "https://$host:$https_port/" && break
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
# Usage: status PATH [CURL_ARGS...]
status() {
  local path=$1
  shift
  https -o /dev/null -w '%{http_code}' "$@" "https://$host:$https_port$path"
}
uuid=0b9f3c1e-8a52-4d0e-9a6f-2f6c1d7e4b3a

check 'HTTP redirects to HTTPS on the public host' \
  "308 https://$host/classes?x=1" \
  "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' \
    -H "Host: $host" "http://127.0.0.1:$http_port/classes?x=1")"
check 'ACME challenges are served over HTTP, not redirected' 'acme-token 200' \
  "$(curl -s -w ' %{http_code}' -H "Host: $host" \
    "http://127.0.0.1:$http_port/.well-known/acme-challenge/token" | tr -d '\n')"
# Express matches routes case-insensitively, so case variants must be blocked too.
for path in /metrics /api/metrics /api/metrics/ /api//metrics '/api/%6Detrics' \
  /api/METRICS /api/Metrics /api/MeTrIcS/ '/api/%4Detrics' \
  /api/users /api/users/ /api//users /api/users/batch?ids=1 /api/users/me \
  /api/users/$uuid/role/x; do
  check "$path is blocked" 404 "$(status "$path")"
done
for path in /health/live /health/ready /api/classes /api/auth/google /classes; do
  check "$path is proxied" 502 "$(status "$path")"
done
# Browsers may only PATCH a user; reading or deleting one is internal.
for path in "/api/users/$uuid" "/api/users/$uuid/role" "/api/users/$uuid/ban"; do
  check "PATCH $path is proxied" 502 "$(status "$path" -X PATCH)"
  check "GET $path is refused" 403 "$(status "$path")"
done
check "DELETE /api/users/$uuid is refused" 403 "$(status "/api/users/$uuid" -X DELETE)"
check 'HSTS is sent, even on errors' 1 \
  "$(https -D - -o /dev/null "https://$host:$https_port/api/metrics" \
    | grep -ci '^strict-transport-security: max-age=31536000; includeSubDomains')"
check 'security headers are sent, even on errors' 2 \
  "$(https -D - -o /dev/null "https://$host:$https_port/api/metrics" \
    | grep -ci -e '^x-content-type-options: nosniff' -e '^x-frame-options: SAMEORIGIN')"
check 'the nginx version is not advertised' 0 \
  "$(curl -s -D - -o /dev/null -H "Host: $host" "http://127.0.0.1:$http_port/" \
    | grep -ci '^server: nginx/' || true)"
check 'request bodies are capped at 256k' 413 \
  "$(head -c 300000 /dev/zero | https -o /dev/null -w '%{http_code}' \
    -X POST --data-binary @- "https://$host:$https_port/api/contact")"

[ "$failures" -eq 0 ] || { echo "$failures nginx routing check(s) failed" >&2; exit 1; }
echo 'nginx routing checks passed.'
