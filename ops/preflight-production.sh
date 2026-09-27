#!/usr/bin/env sh
set -eu

required='NODE_ENV PUBLIC_HOST POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB RABBITMQ_USER RABBITMQ_PASS SESSION_SECRET CORS_ORIGIN PUBLIC_APP_URL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_CALLBACK_URL NEXT_PUBLIC_AUTH_URL NEXT_PUBLIC_TURNSTILE_SITE_KEY CONTACT_CHALLENGE_SECRET TURNSTILE_SECRET_KEY TURNSTILE_HOSTNAME RESEND_API_KEY CONTACT_EMAIL_TO RESEND_FROM_EMAIL STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_CURRENCY TLS_CERT_FILE TLS_KEY_FILE GRAFANA_ADMIN_PASSWORD ALERT_EMAIL_TO AGE_RECIPIENT BACKUP_REMOTE'
for key in $required; do
  eval "value=\${$key-}"
  if [ -z "$value" ]; then
    echo "Missing required production variable: $key" >&2
    exit 1
  fi
done
[ "$NODE_ENV" = production ] || { echo 'NODE_ENV must be production' >&2; exit 1; }

for key in $required; do
  eval "value=\${$key-}"
  case "$value" in
    *change-me*|*replace-with*|*guest*|*localhost*|*your-domain*|*example.com*|*example.org*)
      echo "$key contains a placeholder value" >&2
      exit 1
      ;;
  esac
done
[ "${#SESSION_SECRET}" -ge 32 ] || { echo 'SESSION_SECRET must be at least 32 characters' >&2; exit 1; }
[ "${#GRAFANA_ADMIN_PASSWORD}" -ge 20 ] || { echo 'GRAFANA_ADMIN_PASSWORD must be at least 20 characters' >&2; exit 1; }

case "$PUBLIC_APP_URL" in https://*) ;; *) echo 'PUBLIC_APP_URL must use HTTPS' >&2; exit 1 ;; esac
case "$CORS_ORIGIN" in https://*) ;; *) echo 'CORS_ORIGIN must use HTTPS' >&2; exit 1 ;; esac
case "$PUBLIC_HOST" in
  *[!A-Za-z0-9.-]*|.*|*.) echo 'PUBLIC_HOST must be a hostname without shell or URL characters' >&2; exit 1 ;;
esac
case "$ALERT_EMAIL_TO" in
  *[!A-Za-z0-9._%+@-]*|*@*@*|@*|*@) echo 'ALERT_EMAIL_TO must be a single email address' >&2; exit 1 ;;
  *@*.*) ;;
  *) echo 'ALERT_EMAIL_TO must be a single email address' >&2; exit 1 ;;
esac
case "$AGE_RECIPIENT" in age1*) ;; *) echo 'AGE_RECIPIENT must be an age public key (age1...)' >&2; exit 1 ;; esac
for command_name in docker age rclone sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "Missing required command: $command_name" >&2; exit 1; }
done
[ -r "$TLS_CERT_FILE" ] || { echo 'TLS certificate is not readable' >&2; exit 1; }
[ -r "$TLS_KEY_FILE" ] || { echo 'TLS key is not readable' >&2; exit 1; }

echo 'Production configuration preflight passed.'
