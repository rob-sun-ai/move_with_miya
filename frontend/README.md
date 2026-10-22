# Move with Miya frontend

Next.js (App Router) frontend for the studio: class browsing and registration,
Stripe Checkout, the member dashboard, and the admin dashboard.

## Development

```bash
npm install
npm run dev   # http://localhost:5173
```

Server-rendered pages call the services directly using `BACKEND_URL`
(default `http://localhost:3002`) and `USER_SERVICE_URL` (default
`http://localhost:3003`). In the browser, `/api/*` is proxied to the same
services: by nginx in production (`docker-compose.prod.yml`), or by the
rewrites in `next.config.ts` in local development.

Build-time variables (inlined into the client bundle):

- `NEXT_PUBLIC_AUTH_URL` — where "Sign in with Google" starts.
- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` — Cloudflare Turnstile key for the contact
  form.

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```
