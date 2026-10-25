# Plan 1: Secure Paid Registration and Stripe Checkout

## Goal

Allow a member to register for a paid class only after Stripe confirms payment, while keeping free-class registration unchanged. The flow must be secure, idempotent, concurrency-safe, observable, and recoverable across duplicate clicks, repeated webhook delivery, stale prices, canceled checkouts, class cancellation, member cancellation, partial refunds, and service failures.

This plan builds on the completed registration lifecycle in [Plan 2](../2/plan.md).

## Current state

- `YogaClass` has a database `cost` field but no Stripe identifiers or payment records.
- The class detail page and class modal currently call the free-registration endpoint directly.
- Registration rows, historical cancellation, waitlisting, promotion, class cancellation, and notification outbox behavior already exist.
- `Registration` has a unique `(classId, userId)` constraint and preserves canceled rows.
- Stripe dependencies, checkout endpoints, webhook handling, refund handling, payment status APIs, and success/cancel pages do not exist.
- Class cancellation currently coordinates two databases; the payment workflow must make that coordination retryable without rolling back after an external Stripe side effect.

Relevant files include:

- `classes-service/prisma/schema.prisma`
- `classes-service/src/classes.service.ts`
- `registration-service/prisma/schema.prisma`
- `registration-service/src/registration.service.ts`
- `registration-service/src/registration.controller.ts`
- `backend/src/main.ts`
- `backend/src/app.module.ts`
- `backend/src/externalControllers/RegistrationController.ts`
- `frontend/src/components/ClassDetailClient.tsx`
- `frontend/src/components/ClassModal.tsx`

## Design decisions

1. The backend is authoritative for class eligibility, price, capacity, user identity, refund policy, and payment state. The browser sends only `classId` when starting checkout.
2. Free classes continue to use the existing registration endpoint and Plan 2 waitlist behavior.
3. Paid classes use hosted Stripe Checkout with one line item and quantity `1`.
4. Stripe webhooks, not the browser redirect, finalize registration.
5. Webhook processing, payment creation, registration finalization, and refunds are idempotent and safe when repeated or concurrent.
6. Store money as integer cents and explicit lowercase currency in payment records. Convert the class `Decimal` using exact string/integer arithmetic; reject negative values and more than two decimal places.
7. Do not add `stripePriceId` in this phase. Create a one-time `price_data` line item from the server-side class price. Do not accept an amount, currency, or product definition from the client.
8. A pending payment reserves one seat for 30 minutes. Paid classes do not use the existing free waitlist in this phase; when all seats are registered or reserved, checkout returns a full-class response.
9. Member cancellation uses the class refund tiers. Administrator cancellation defaults to a full refund and may provide an explicit validated override percentage. Class cancellation always issues a full refund.
10. Refund policy is separate from cancellation eligibility. `cancellationCutoffHours` remains the latest time a member may cancel; refund tiers determine the percentage when cancellation is allowed.

Stripe supports inline `price_data` with integer smallest-unit amounts, and Checkout expiration may be set between 30 minutes and 24 hours. See the [Checkout Session API](https://docs.stripe.com/api/checkout/sessions/create).

## Data model changes

### Classes service

Extend `YogaClass` with:

- `refundPolicy Json` with a default policy preserving the current 24-hour cutoff behavior;
- existing `cancellationCutoffHours` remains the hard member-cancellation boundary.

Represent refund tiers as an array of:

```ts
{
  hoursBeforeStart: number;
  percentage: number;
}
```

Validate on create and update:

- thresholds are unique, non-negative integers;
- percentages are integers from `0` through `100`;
- tiers are normalized into deterministic descending threshold order;
- the policy contains a tier applicable at the member cancellation boundary;
- invalid JSON, missing fields, or impossible values are rejected server-side.

Example policy:

```json
[
  { "hoursBeforeStart": 48, "percentage": 100 },
  { "hoursBeforeStart": 24, "percentage": 50 }
]
```

With a 24-hour cancellation cutoff, cancellation at least 48 hours before class receives 100%; cancellation between 24 and 48 hours receives 50%; cancellation after 24 hours is rejected for members.

The admin class form must expose refund tiers as repeatable validated rows rather than requiring administrators to edit raw JSON.

### Registration service

Add a `Payment` model containing:

- `id`, `userId`, and `classId`;
- nullable unique `stripeCheckoutSessionId`;
- nullable unique `stripePaymentIntentId`;
- nullable unique `stripeRefundId`;
- `amountCents` and `currency`;
- payment status: `Pending`, `Paid`, `Failed`, `Expired`, `Refunded`;
- refund status: `None`, `Pending`, `Succeeded`, `Failed`, `NotEligible`;
- nullable `registrationId`;
- `refundPercentage`, `refundAmountCents`, `refundRequestedAt`, `refundedAt`, and `refundError`;
- `expiresAt`, `createdAt`, `updatedAt`, and `paidAt`.

Do not make `registrationId` unique because Plan 2 reuses a canceled registration row and a user may have multiple historical payments for that row.

Add indexes for `(userId, classId, status)`, `(classId, status)`, `(status, expiresAt)`, and refund status. Add a PostgreSQL partial unique index allowing only one active `Pending` or `Paid` payment per user/class.

Add a `StripeWebhookEvent` model or equivalent durable record with unique Stripe event ID, event type, processing status, timestamps, and bounded error text. This prevents replayed events from becoming unobservable.

## Configuration and deployment

Add and validate:

- `STRIPE_SECRET_KEY`;
- `STRIPE_WEBHOOK_SECRET`;
- `STRIPE_CURRENCY=usd`;
- `PUBLIC_APP_URL`.

`STRIPE_PUBLISHABLE_KEY` is not required for hosted Checkout and should not be added unless a later frontend integration needs it.

Install the Stripe server SDK only in `backend`. Pass the configuration through `.env.example` and production Docker configuration. Production startup must fail closed when required Stripe settings are missing or malformed.

## Backend checkout implementation

Create `StripeController` with:

- `POST /checkout/create-session`, authenticated;
- `POST /checkout/webhook`, unauthenticated but signature-verified;
- `GET /checkout/status?session_id=...`, authenticated and ownership-checked;
- `GET /checkout/payments`, admin-only;
- `POST /checkout/payments/:id/refund`, admin-only retry/override.

### `POST /checkout/create-session`

Implementation sequence:

1. Read the user ID from the authenticated session; reject anonymous requests.
2. Validate the request body strictly and accept only a positive integer `classId`.
3. Fetch the class from the classes service.
4. Re-run the same checks as free registration: class exists, is open, has not ended, is not canceled/completed, user is not banned, private-class requirements are satisfied, and capacity is available.
5. Convert `cost` to exact cents and reject free/invalid amounts on this paid path.
6. Ask the registration service to create or reuse a pending payment in a serializable transaction. Count registered registrations plus non-expired pending payments against capacity.
7. Reuse a pending payment only when its stored amount, currency, and expiration remain valid. If the class price changed, expire the old payment and create a new one. A later successful event for an expired payment must be refunded rather than registered.
8. Create a Stripe Checkout session with:
   - `mode: payment`;
   - one server-created `price_data` line item;
   - quantity `1`;
   - `client_reference_id` set to the internal payment ID;
   - metadata containing only `paymentId`, `classId`, and `userId`;
   - success and cancel URLs built only from the allowlisted `PUBLIC_APP_URL` and containing `{CHECKOUT_SESSION_ID}`;
   - `expires_at` set to 30 minutes after creation.
9. Use an idempotency key derived from the authenticated user, class, and payment ID.
10. Persist the Checkout Session ID and return only `{ url, paymentId }`.
11. If Stripe session creation fails, mark the pending payment failed/expired so its reservation is released.

The endpoint must never trust a client-provided amount, currency, user ID, refund policy, redirect URL, or Stripe identifier.

## Webhook implementation

Configure the Nest/Express startup path so `/checkout/webhook` receives the exact raw request bytes before JSON parsing. Stripe requires the unmodified raw body for signature verification; see [Stripe webhook signature guidance](https://docs.stripe.com/webhooks/signature).

Handle at least:

- `checkout.session.completed`;
- `checkout.session.async_payment_succeeded`;
- `checkout.session.async_payment_failed`;
- `checkout.session.expired`;
- `refund.updated`;
- `refund.failed`;
- `charge.refunded`.

For successful checkout events:

1. Verify the signature before parsing or acting on the payload.
2. Persist/deduplicate the Stripe event ID.
3. Retrieve or validate the Checkout Session and confirm `payment_status === paid`.
4. Verify the Checkout Session ID, payment ID, class ID, user ID, amount, currency, and PaymentIntent ID against the database payment.
5. Fetch the class and reject registration if it is canceled or ended.
6. Run a serializable registration-service transaction that changes the payment to `Paid` and creates or restores exactly one `Registered` registration.
7. If the reserved seat is no longer available, do not create a registration; issue a full idempotent refund.
8. Return success for safely handled duplicates. Return a retryable error only for temporary service/database failures.

Failed and expired sessions release their pending reservation. A delayed payment remains unfulfilled until `async_payment_succeeded` arrives.

Stripe recommends webhook-driven fulfillment and requires fulfillment to tolerate repeated or concurrent processing. See [Stripe fulfillment guidance](https://docs.stripe.com/checkout/fulfillment).

## Registration-service RPC contracts

Add message patterns for:

- `get_class_payment_availability`;
- `create_or_get_pending_payment`;
- `attach_checkout_session`;
- `get_payment_by_id`;
- `get_payment_by_checkout_session`;
- `get_payment_status_for_user`;
- `finalize_paid_registration`;
- `mark_payment_failed`;
- `mark_payment_expired`;
- `begin_registration_refund`;
- `begin_class_refunds`;
- `complete_payment_refund`;
- `fail_payment_refund`;
- `list_refund_pending_payments`;
- `record_stripe_webhook_event`;
- `get_all_payments`.

No frontend endpoint or RPC may mark a payment paid. Only the signature-verified webhook flow may finalize a paid registration.

## Cancellation and refund integration

Update the existing Plan 2 cancellation transactions so they preserve history, release seats, promote eligible free-class waitlisted members, and create a durable refund intent in the same registration-service transaction.

Refund calculation:

1. Compute hours until class start using server time.
2. For member cancellation, reject after `cancellationCutoffHours`; otherwise select the applicable refund tier.
3. For administrator cancellation, use the supplied percentage or default to `100`.
4. For class cancellation, use `100` for every paid registration.
5. Calculate `refundAmountCents` with integer arithmetic and round down.
6. Persist the percentage and amount before calling Stripe.
7. For a non-zero amount, call Stripe Refunds using the PaymentIntent and an idempotency key such as `refund:<paymentId>`.
8. Store the Refund ID returned by Stripe. Mark the refund succeeded only after Stripe reports `succeeded` and the event/API response matches the persisted Refund ID, PaymentIntent, and exact expected amount. Keep provider-pending refunds pending. For zero amount, mark `NotEligible` without calling Stripe.
9. On failure, keep the refund `Pending` or `Failed`, expose the error to administrators, and retry safely.

Stripe refunds must use a PaymentIntent or Charge and may be partial; see the [Stripe Refund API](https://docs.stripe.com/api/refunds/create).

The backend must include a retry worker for refund-pending or failed payments. Class cancellation must be monotonic: cancel registrations before beginning refunds, never roll the class back after any side effect, and make repeated cancellation attempts safely converge on canceled registrations plus completed/retried refunds.

Paid webhook finalization must re-check the class lifecycle at the registration-service state-machine boundary. Canceled, completed, or already-ended classes must never receive a new registration; the paid payment is converted into a durable full-refund intent instead.

## Frontend implementation

Create a shared registration decision path used by `ClassDetailClient` and `ClassModal`:

1. If `cost === 0`, call the existing free-registration flow.
2. If `cost > 0`, call `/api/checkout/create-session` with only `{ classId }`.
3. Disable the button while the request is in flight.
4. Redirect to the returned Stripe URL.
5. Preserve private-class yoga-experience collection before either path.
6. Show meaningful full, closed, banned, unavailable, payment-pending, canceled, and refund-pending states.

Add:

- `/checkout/success`: show “Payment received; confirming registration,” poll the authenticated payment-status endpoint, and display confirmation only after webhook finalization;
- `/checkout/cancel`: explain that no registration was created and provide a retry action.

Extend frontend types and administrator views with payment status, refund percentage, refund amount, refund status, and refund errors. Add sanitized availability/reservation data to class responses where needed for accurate UI messaging.

## Security requirements

Security review is required for every changed endpoint, RPC, state transition, migration, and frontend flow.

- Keep Stripe secrets exclusively server-side.
- Enforce authentication, ownership checks, and `AdminGuard`/staff authorization.
- Reject unknown request fields and validate all IDs, amounts, percentages, dates, enums, and JSON policy data.
- Never accept price, amount, currency, user ID, payment ID, refund amount, or refund percentage from ordinary members.
- Verify Stripe signatures before parsing or acting on webhook payloads.
- Use raw-body handling, webhook event deduplication, unique constraints, serializable transactions, and idempotency keys.
- Protect browser state-changing endpoints against CSRF and enforce exact allowed origins.
- Use HTTPS and secure, HttpOnly, SameSite cookies in production.
- Apply body-size limits and rate limits to Checkout creation, status polling, and refund operations.
- Build redirects only from allowlisted configuration; never accept client redirect URLs.
- Fail closed when production payment, CORS, session-secret, or TLS configuration is missing; require HTTPS public origins and strong non-placeholder session secrets.
- Serve production traffic through configured TLS certificates, redirect HTTP to HTTPS, set forwarded-protocol headers, and emit HSTS.
- Strictly validate refund-policy objects: numeric safe-integer primitives only, exactly the allowed keys, unique thresholds, and a tier compatible with the effective cancellation cutoff on both create and update.
- Do not log secrets, signatures, raw payment payloads, full customer payment data, or full Stripe identifiers.
- Use bounded error text and sanitized administrator responses.
- Run dependency, secret, lint, typecheck, and security checks in CI.

## Testing and coverage

Maximize coverage for all new and modified code. Critical payment, refund, authorization, validation, concurrency, and webhook state-machine branches should target 100% coverage. New payment-related modules should target at least 95% statements, branches, functions, and lines without lowering existing repository coverage.

### Unit tests

- exact decimal-to-cents conversion, precision rejection, negative values, rounding, and currency validation;
- refund-policy validation, ordering, boundary times, full/partial/zero refunds, and invalid policies;
- free versus paid routing in both frontend entry points;
- Checkout line-item, metadata, URL, expiration, and idempotency-key construction;
- pending-seat reservation, stale payment expiration, price changes, and duplicate payment creation;
- existing registration/payment handling;
- every payment/refund/webhook state transition;
- signature rejection, replayed events, malformed events, and unsupported event types;
- tampered class ID, user ID, amount, currency, payment intent, or refund data;
- admin/member authorization, CSRF, rate limits, missing configuration, and body-size limits;
- repeated/concurrent success webhooks not duplicating registrations;
- Stripe refund success, failure, partial refund, already-refunded, and retry behavior.
- delayed paid webhooks after class cancellation/completion/end time;
- cancellation dependency failure, retry/convergence, and duplicate cancellation behavior;
- distributed Redis-backed checkout/status/refund rate limits and normal success-page polling budget;
- production startup rejection for missing/placeholder secrets, non-HTTPS origins, and absent TLS files.

### HTTP/integration/E2E tests

- authenticated member can start paid checkout;
- anonymous, banned, unauthorized, and malformed requests are rejected;
- paid classes never reach the free-registration path;
- registered plus pending reservations never exceed capacity under concurrency;
- success redirect before webhook does not show registration confirmation;
- completed and delayed-success webhooks finalize exactly one registration;
- failed/expired Checkout releases its reservation;
- paid member cancellation applies the correct refund tier;
- administrator and class cancellation issue full refunds;
- refund failures remain visible and retryable;
- class cancellation cannot strand active paid registrations;
- payment and registration history are visible to administrators;
- free-class Plan 2 registration, waitlisting, promotion, cancellation, and notifications remain unchanged.

Use Stripe mocks/test doubles in CI. Do not require live Stripe credentials. Add a staging smoke test using Stripe test mode and Stripe CLI webhook forwarding.

## Acceptance criteria

- A paid class cannot be registered through either frontend entry point without verified successful Stripe payment.
- Free classes continue to work exactly as before.
- Capacity cannot be exceeded by registered members or concurrent pending checkouts.
- Amounts and refund percentages are always derived and validated server-side.
- Refund tiers are configurable per class and correctly apply at their boundaries.
- Member, administrator, and class cancellations produce the documented refund percentage.
- Webhook processing is signature-verified, idempotent, observable, and retryable.
- Duplicate clicks and duplicate webhook deliveries do not create duplicate registrations or charges.
- Interrupted refunds remain recoverable and visible to administrators.
- Security checks pass and no new critical/high security findings remain.
- New payment/refund code meets the required coverage targets and the complete test suite passes.
- Payment, registration, cancellation, and refund states are visible to administrators.

## Defaults and out-of-scope items

- Currency defaults to USD.
- Checkout sessions and pending reservations expire after 30 minutes.
- One paid class produces one Checkout line item with quantity `1`.
- Default member cancellation cutoff remains 24 hours unless configured per class.
- Default refund policy preserves the existing full-refund-before-cutoff behavior.
- Taxes, coupons, subscriptions, saved payment methods, Stripe-managed catalog prices, and paid waitlists are out of scope.
