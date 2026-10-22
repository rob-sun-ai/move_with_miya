# Production Runbook

## Deployment prerequisites

1. Point the production domain and `www` behavior to the host.
2. Provision a trusted certificate and key (see [TLS certificates](#tls-certificates)), and set `TLS_CERT_DIR`, `TLS_CERT_FILE` and `TLS_KEY_FILE` in the deployment-host environment file.
3. Register the exact HTTPS Google OAuth callback URL.
4. Restrict Turnstile to the production hostname.
5. Verify the Resend sending domain and configure SPF, DKIM, and DMARC.
6. Register the Stripe webhook at `/api/checkout/webhook`.

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
