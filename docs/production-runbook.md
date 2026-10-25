# Production Runbook

## Deployment prerequisites

1. Point the production domain and `www` behavior to the host.
2. Provision a trusted certificate and key (see [TLS certificates](#tls-certificates)), and set `TLS_CERT_DIR`, `TLS_CERT_FILE` and `TLS_KEY_FILE` in the deployment-host environment file.
3. Register the exact HTTPS Google OAuth callback URL.
4. Restrict Turnstile to the production hostname.
5. Verify the Resend sending domain and configure SPF, DKIM, and DMARC.
6. Register the Stripe webhook at `/api/checkout/webhook`.
7. Set a strong `GRAFANA_ADMIN_PASSWORD`; do not expose Grafana's container port publicly.

The populated environment file must live outside the repository with restrictive file permissions (`chmod 600`).

`POSTGRES_PASSWORD` and `RABBITMQ_PASS` are embedded in connection URLs, so they must be URL-safe (letters, digits, `-`, `_`, `.`, `~`); `openssl rand -hex 32` generates a suitable one. `RELEASE_VERSION` is required and tags every image, so set it to the commit being deployed.

## Application stack

`docker-compose.prod.yml` builds images tagged `move-with-miya/<service>:${RELEASE_VERSION}`. Each service's Prisma migrations run as a one-shot `*-migrate` job, and the service only starts after its job completes successfully. Every service exposes `/health/live` and `/health/ready`; Compose healthchecks use the readiness endpoint, and nginx only starts once the services behind it are healthy.

nginx terminates TLS, redirects HTTP to HTTPS, and blocks the internal `/metrics` endpoints and the user-service collection route (`/api/users`, used only by internal callers). Recreate it after recreating application containers or changing `nginx/nginx.prod.conf`; a reload re-resolves upstream addresses but does not apply a new config, because the image renders the template only at container start and the single-file bind mount keeps the file as it was before `git checkout`:

```bash
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml up -d --no-deps --force-recreate nginx
```

Use `--no-deps` here and for any other single-service `up`: without it Compose also re-runs the migration jobs of the release recorded in the env file (after a rollback, the older release's).

CI enforces these rules: `ops/check-compose.py` checks the Compose invariants (only nginx publishes ports, images are tagged by release, services restart and wait for their migrations), and `nginx/test-routing.sh` runs the real nginx config and checks redirects, blocked endpoints, proxied routes, HSTS, and the body-size limit. Both run locally with Docker.

## TLS certificates

nginx mounts `TLS_CERT_DIR` (default `/etc/letsencrypt`) read-only at the same path, so `TLS_CERT_FILE` and `TLS_KEY_FILE` must point inside it. Certbot makes its `live/` and `archive/` directories root-only, so start the stack as root or grant that user read access. Mounting the whole tree keeps Let's Encrypt's `live/` symlinks resolving to the current `archive/` files after a renewal. Port 80 serves `/.well-known/acme-challenge/` from `ACME_WEBROOT` (default `/var/www/acme`) and redirects everything else to HTTPS.

Run certbot on the host. nginx can't start without a certificate, so issue the first one with the standalone plugin before the stack is up, then switch renewals to the webroot that nginx serves:

```bash
sudo certbot certonly --standalone -d your-domain.example
# After the stack is running:
sudo certbot reconfigure --cert-name your-domain.example \
  --webroot -w /var/www/acme \
  --deploy-hook 'docker compose --env-file /path/to/.env.production -f /path/to/docker-compose.prod.yml exec -T nginx nginx -s reload'
sudo certbot renew --dry-run
```

certbot's packaged timer runs `certbot renew` twice a day using the stored webroot and deploy hook. nginx only reads certificates at start or reload, so the hook is what puts a renewed certificate into service.

## Observability

Prometheus, Grafana, Loki (with Promtail), Tempo, and the OpenTelemetry Collector run on the same Compose host. Their ports are internal-only; reach Grafana through an SSH tunnel or a separately protected proxy (`GRAFANA_PUBLIC_URL` adds a link to it in the admin area). The admin area exposes a controlled health summary at `/admin/observability`.

- Metrics: Prometheus scrapes each service's `/metrics` every 15 seconds and keeps `PROMETHEUS_RETENTION` (default 14 days), capped at `PROMETHEUS_RETENTION_SIZE` (default 10GB) because it shares the host's disk. Prometheus starts independently of the applications, so it keeps recording while one of them is unhealthy.
- Logs: Promtail ships container logs to Loki, which keeps 14 days. Each service's json-file logs record its Compose service name, which becomes the `service` label (for example `{service="backend"}`).
- Traces: services export OTLP traces to the collector, which forwards them to Tempo.

Same-host monitoring means observability is unavailable during a host outage. Metrics, logs, and traces are diagnostic data and are not part of the business-data backup set.

## Alerting

Prometheus evaluates [ops/observability/alerts.yml](../ops/observability/alerts.yml) and sends firing alerts to Alertmanager, which emails `ALERT_EMAIL_TO` through Resend's SMTP relay (`smtp.resend.com`, authenticated with `RESEND_API_KEY`, sent from `RESEND_FROM_EMAIL`). The API key reaches Alertmanager as a Compose secret, which needs Docker Compose 2.23 or newer.

| Alert | Fires when | Response |
|---|---|---|
| `Watchdog` | Always (it is a heartbeat, never emailed) | If the dead man's switch at `ALERT_HEARTBEAT_URL` reports missing pings, Prometheus or Alertmanager is down or cannot send |
| `ServiceDown` | A service's metrics endpoint is unreachable for 2 minutes | Check `docker compose ps` and the service logs |
| `HighHttpErrorRate` | More than 5% of requests return 5xx for 5 minutes (with at least 5 requests in the window; `/metrics` and `/health/*` probes are excluded) | Check logs in Grafana/Loki by `requestId` |
| `HighHttpLatency` | p95 latency, excluding probes, is above 1 second for 10 minutes | Check dependency health and traces in Tempo |
| `RefundsNeedAttention` | A refund exhausted its 10 automatic retries | Admin → Payments: read the error, then retry or resolve it in Stripe |
| `StripeWebhookProcessingFailed` | A Stripe webhook event failed processing for 15 minutes | Fix the cause from the backend logs; Stripe retries for 3 days, after that resend the event from the Stripe dashboard |

Without a heartbeat nothing reports a stopped Prometheus or Alertmanager, so set `ALERT_HEARTBEAT_URL` to an external dead man's switch, for example a [healthchecks.io](https://healthchecks.io) check with a 5-minute period and a 10-minute grace time. Alertmanager pings it with the always-firing `Watchdog` alert every 5 minutes, and the service alerts you when the pings stop. Leaving it empty discards the heartbeat.

Links in alert emails use `ALERTMANAGER_EXTERNAL_URL` (default `http://localhost:9093`, which works through an SSH tunnel to the Alertmanager container). Recipient and sender values are substituted literally, so quotes and `&` in `RESEND_FROM_EMAIL` are safe; they must fit on one line.

Send a test alert after every change to the alerting setup:

```bash
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml exec alertmanager \
  amtool alert add TestAlert severity=warning \
  --annotation='summary="Test alert"' --alertmanager.url=http://localhost:9093
```

Every rule is unit-tested in [ops/observability/alerts.test.yml](../ops/observability/alerts.test.yml) (`promtool test rules`), and [ops/observability/test-alertmanager.sh](../ops/observability/test-alertmanager.sh) starts the real Alertmanager service to check its rendered recipients and secret; CI runs both.
