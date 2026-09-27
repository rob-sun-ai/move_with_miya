import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { of, throwError } from 'rxjs';
import Stripe from 'stripe';
import { StripeService } from './stripe.service';

jest.mock('stripe', () => ({ __esModule: true, default: jest.fn() }));

const NOW = new Date('2026-09-27T12:00:00.000Z');

const openClass = {
  id: 1,
  name: 'Morning Flow',
  cost: '15.50',
  capacity: 5,
  startDate: '2099-01-01T10:00:00.000Z',
  endDate: '2099-01-01T11:00:00.000Z',
  status: 'Scheduled',
};

/** A fixed RPC reply, a function of the payload, or an RpcFailure. */
type Reply = unknown;
type ReplyFn = (payload: Record<string, unknown>) => unknown;

/** Builds a StripeService wired to fake RPC clients and a fake Stripe SDK. */
function setup(env: Record<string, string | undefined> = {}) {
  const stripe = {
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({
          id: 'cs_new',
          url: 'https://checkout.test/new',
        }),
        retrieve: jest.fn(),
        expire: jest.fn().mockResolvedValue({}),
      },
    },
    refunds: {
      create: jest.fn(),
      retrieve: jest.fn(),
      list: jest.fn().mockResolvedValue({ data: [] }),
    },
    webhooks: { constructEvent: jest.fn() },
  };
  (Stripe as unknown as jest.Mock).mockImplementation(() => stripe);

  const values: Record<string, string | undefined> = {
    PUBLIC_APP_URL: 'https://app.test',
    STRIPE_CURRENCY: 'usd',
    USER_SERVICE_URL: 'http://users.test',
    ...env,
  };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
  };

  const replies: Record<string, Reply> = {};
  const registrations = {
    send: jest.fn(
      ({ cmd }: { cmd: string }, payload: Record<string, unknown>) => {
        const reply = replies[cmd];
        const value: unknown =
          typeof reply === 'function' ? (reply as ReplyFn)(payload) : reply;
        if (value instanceof RpcFailure) return throwError(() => value.error);
        return of(cmd in replies ? value : {});
      },
    ),
  };
  const classes = { send: jest.fn().mockReturnValue(of(openClass)) };

  const service = new StripeService(
    config as never,
    registrations as never,
    classes as never,
  );
  const sent = (cmd: string) =>
    registrations.send.mock.calls
      .filter(([pattern]) => pattern.cmd === cmd)
      .map(([, payload]) => payload);
  return { service, stripe, config, replies, registrations, classes, sent };
}

/** Makes an RPC reply fail with the given error payload. */
class RpcFailure {
  constructor(readonly error: unknown) {}
}

function checkoutEvent(
  type: string,
  object: Record<string, unknown>,
): Stripe.Event {
  return { id: 'evt_1', type, data: { object } } as unknown as Stripe.Event;
}

const paidSession = {
  id: 'cs_1',
  payment_status: 'paid',
  metadata: { paymentId: 'payment-1', classId: '1', userId: 'user-1' },
  amount_total: 1550,
  currency: 'USD',
  payment_intent: 'pi_1',
};

const paidPayment = {
  id: 'payment-1',
  userId: 'user-1',
  classId: 1,
  amountCents: 1550,
  currency: 'usd',
  status: 'Paid',
  refundStatus: 'None',
  stripeCheckoutSessionId: 'cs_1',
  stripePaymentIntentId: 'pi_1',
};

describe('StripeService lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ banned: false })));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('configuration', () => {
    it('creates the Stripe client with the configured secret key', () => {
      setup({ STRIPE_SECRET_KEY: 'sk_live_key' });
      expect(Stripe).toHaveBeenLastCalledWith('sk_live_key');
    });

    it('falls back to a placeholder key outside production', () => {
      setup({ STRIPE_SECRET_KEY: undefined });
      expect(Stripe).toHaveBeenLastCalledWith('sk_test_unconfigured');
    });

    it('sweeps refunds every minute until the module is destroyed', () => {
      const { service } = setup();
      const sweep = jest
        .spyOn(service, 'retryRefunds')
        .mockResolvedValue(undefined);

      service.onModuleInit();
      jest.advanceTimersByTime(60_000);
      expect(sweep).toHaveBeenCalledTimes(1);

      service.onModuleDestroy();
      jest.advanceTimersByTime(120_000);
      expect(sweep).toHaveBeenCalledTimes(1);
    });

    it('can be destroyed before it was initialized', () => {
      expect(() => setup().service.onModuleDestroy()).not.toThrow();
    });

    const production = {
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_key',
      STRIPE_WEBHOOK_SECRET: 'whsec_1',
      PUBLIC_APP_URL: 'https://app.test',
      STRIPE_CURRENCY: 'usd',
    };

    it('accepts complete production configuration', () => {
      const { service } = setup(production);
      expect(() => service.onModuleInit()).not.toThrow();
      service.onModuleDestroy();
    });

    it.each([
      [{ STRIPE_SECRET_KEY: undefined }, 'STRIPE_SECRET_KEY is required'],
      [
        { STRIPE_WEBHOOK_SECRET: undefined },
        'STRIPE_WEBHOOK_SECRET is required',
      ],
      [
        { PUBLIC_APP_URL: undefined },
        'PUBLIC_APP_URL must be a valid HTTPS URL',
      ],
      [
        { PUBLIC_APP_URL: 'not a url' },
        'PUBLIC_APP_URL must be a valid HTTPS URL',
      ],
      [
        { PUBLIC_APP_URL: 'http://app.test' },
        'PUBLIC_APP_URL must be a valid HTTPS URL',
      ],
      [{ STRIPE_CURRENCY: 'USD' }, 'STRIPE_CURRENCY must be a three-letter'],
    ])('rejects production configuration %o', (overrides, message) => {
      const { service } = setup({ ...production, ...overrides });
      expect(() => service.onModuleInit()).toThrow(message);
    });
  });

  describe('payment service errors', () => {
    it.each([
      [400, BadRequestException],
      [404, NotFoundException],
      [409, ConflictException],
      [403, ForbiddenException],
      [500, ServiceUnavailableException],
    ])('maps status %p to %p', async (statusCode, type) => {
      const { service, replies } = setup();
      replies.get_payment_status_for_user = new RpcFailure({
        statusCode,
        message: 'from payments',
      });

      await expect(service.statusForUser('cs_1', 'user-1')).rejects.toEqual(
        new type('from payments'),
      );
    });

    it('reports an unavailable payment service for unknown errors', async () => {
      const { service, replies } = setup();
      replies.get_payment_status_for_user = new RpcFailure(null);

      await expect(service.statusForUser('cs_1', 'user-1')).rejects.toEqual(
        new ServiceUnavailableException('Payment service unavailable'),
      );
    });
  });

  describe('createCheckoutSession', () => {
    function withPendingPayment(
      ctx: ReturnType<typeof setup>,
      overrides: Record<string, unknown> = {},
    ) {
      ctx.replies.create_or_get_pending_payment = {
        id: 'payment-1',
        status: 'Pending',
        ...overrides,
      };
    }

    it('reports an unavailable class service', async () => {
      const ctx = setup();
      ctx.classes.send.mockReturnValue(throwError(() => new Error('down')));

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toEqual(
        new ServiceUnavailableException('Class service unavailable'),
      );
    });

    it('rejects an unknown class', async () => {
      const ctx = setup();
      ctx.classes.send.mockReturnValue(of(null));

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toEqual(new NotFoundException('Class 1 not found'));
    });

    it.each(['Canceled', 'Completed'])('rejects a %s class', async (status) => {
      const ctx = setup();
      ctx.classes.send.mockReturnValue(of({ ...openClass, status }));

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toThrow('This class is not open for registration');
    });

    it('requires yoga experience for a private class', async () => {
      const ctx = setup();
      ctx.classes.send.mockReturnValue(of({ ...openClass, isPrivate: true }));
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({ banned: false, yogaExperience: ' ' })),
        );

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toThrow('Yoga experience is required for this class');
    });

    it('lets experienced members pay for a private class', async () => {
      const ctx = setup();
      ctx.classes.send.mockReturnValue(of({ ...openClass, isPrivate: true }));
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({ yogaExperience: 'Two years' })),
        );
      withPendingPayment(ctx);

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).resolves.toEqual({
        url: 'https://checkout.test/new',
        paymentId: 'payment-1',
      });
    });

    it('rejects a banned member', async () => {
      const ctx = setup();
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ banned: true })));

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toThrow('User is banned');
    });

    it('sends free classes to the free registration flow', async () => {
      const ctx = setup();
      ctx.classes.send.mockReturnValue(of({ ...openClass, cost: '0' }));

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toThrow('Free classes use the free registration flow');
    });

    it.each(['abc', '-5', '1e3'])('rejects price %p', async (cost) => {
      const ctx = setup();
      ctx.classes.send.mockReturnValue(of({ ...openClass, cost }));

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toThrow('Class price has invalid precision');
    });

    it('rejects a price too large to charge exactly', async () => {
      const ctx = setup();
      ctx.classes.send.mockReturnValue(
        of({ ...openClass, cost: '900719925474099.99' }),
      );

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toThrow('Class price is invalid');
    });

    it('charges numeric prices and normalizes the currency', async () => {
      const ctx = setup({ STRIPE_CURRENCY: 'EUR' });
      ctx.classes.send.mockReturnValue(of({ ...openClass, cost: 20 }));
      withPendingPayment(ctx);

      await ctx.service.createCheckoutSession('user-1', 1);

      expect(ctx.sent('create_or_get_pending_payment')[0]).toMatchObject({
        amountCents: 2000,
        currency: 'eur',
      });
    });

    it('rejects a payment that is already paid', async () => {
      const ctx = setup();
      withPendingPayment(ctx, { status: 'Paid' });

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toThrow('Already registered for this class');
    });

    it('creates a session that expires 35 minutes out, like its payment', async () => {
      const ctx = setup({ PUBLIC_APP_URL: 'https://app.test/' });
      ctx.classes.send.mockReturnValue(
        of({ ...openClass, description: 'd'.repeat(600) }),
      );
      withPendingPayment(ctx);

      await ctx.service.createCheckoutSession('user-1', 1);

      const expiresAt = new Date(NOW.getTime() + 35 * 60 * 1000);
      expect(ctx.sent('create_or_get_pending_payment')[0]).toMatchObject({
        userId: 'user-1',
        classId: 1,
        capacity: 5,
        expiresAt: expiresAt.toISOString(),
      });
      expect(ctx.stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          expires_at: expiresAt.getTime() / 1000,
          success_url:
            'https://app.test/checkout/success?session_id={CHECKOUT_SESSION_ID}',
          cancel_url: 'https://app.test/checkout/cancel?class_id=1',
          line_items: [
            expect.objectContaining({
              price_data: expect.objectContaining({
                product_data: {
                  name: 'Morning Flow',
                  description: 'd'.repeat(500),
                },
              }) as unknown,
            }),
          ],
        }),
        { idempotencyKey: 'checkout:user-1:1:payment-1' },
      );
    });

    it('returns the open session that is already attached', async () => {
      const ctx = setup();
      withPendingPayment(ctx, { stripeCheckoutSessionId: 'cs_1' });
      ctx.stripe.checkout.sessions.retrieve.mockResolvedValue({
        status: 'open',
        url: 'https://checkout.test/existing',
      });

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).resolves.toEqual({
        url: 'https://checkout.test/existing',
        paymentId: 'payment-1',
      });
      expect(ctx.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('does not replace an open session that has no URL', async () => {
      const ctx = setup();
      withPendingPayment(ctx, { stripeCheckoutSessionId: 'cs_1' });
      ctx.stripe.checkout.sessions.retrieve.mockResolvedValue({
        status: 'open',
        url: null,
      });

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toThrow('Payment is already being processed');
      expect(ctx.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('replaces an expired session with a new payment and session', async () => {
      const ctx = setup();
      let calls = 0;
      ctx.replies.create_or_get_pending_payment = () =>
        ++calls === 1
          ? {
              id: 'payment-1',
              status: 'Pending',
              stripeCheckoutSessionId: 'cs_old',
            }
          : { id: 'payment-2', status: 'Pending' };
      ctx.stripe.checkout.sessions.retrieve.mockResolvedValue({
        status: 'expired',
      });

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).resolves.toEqual({
        url: 'https://checkout.test/new',
        paymentId: 'payment-2',
      });
      expect(ctx.sent('mark_payment_expired')).toEqual([{ id: 'payment-1' }]);
      expect(ctx.sent('attach_checkout_session')).toEqual([
        { paymentId: 'payment-2', stripeCheckoutSessionId: 'cs_new' },
      ]);
    });

    it('fails the payment and closes the session when Stripe returns no URL', async () => {
      const ctx = setup();
      withPendingPayment(ctx);
      ctx.stripe.checkout.sessions.create.mockResolvedValue({
        id: 'cs_new',
        url: null,
      });

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toEqual(
        new ServiceUnavailableException('Unable to start Stripe Checkout'),
      );
      expect(ctx.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
        'cs_new',
      );
      expect(ctx.sent('mark_payment_failed')).toEqual([
        { id: 'payment-1', error: 'Stripe did not return a Checkout URL' },
      ]);
    });

    it('fails the payment without expiring anything when Stripe rejects the session', async () => {
      const ctx = setup();
      withPendingPayment(ctx);
      ctx.stripe.checkout.sessions.create.mockRejectedValue('rate limited');
      ctx.replies.mark_payment_failed = new RpcFailure({ statusCode: 500 });

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toThrow('Unable to start Stripe Checkout');
      expect(ctx.stripe.checkout.sessions.expire).not.toHaveBeenCalled();
      expect(ctx.sent('mark_payment_failed')).toEqual([
        { id: 'payment-1', error: 'Checkout creation failed' },
      ]);
    });

    it('still fails cleanly when the unlinked session cannot be expired', async () => {
      const ctx = setup();
      withPendingPayment(ctx);
      ctx.replies.attach_checkout_session = new RpcFailure({ statusCode: 500 });
      ctx.stripe.checkout.sessions.expire.mockRejectedValue(new Error('gone'));

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toThrow('Unable to start Stripe Checkout');
      expect(ctx.sent('mark_payment_failed')).toHaveLength(1);
    });

    it.each([
      [undefined, 'Payment URL is not configured'],
      ['not a url', 'Payment URL is invalid'],
      ['ftp://app.test', 'Payment URL is invalid'],
    ])('fails checkout when PUBLIC_APP_URL is %p', async (url, error) => {
      const ctx = setup({ PUBLIC_APP_URL: url });
      withPendingPayment(ctx);

      await expect(
        ctx.service.createCheckoutSession('user-1', 1),
      ).rejects.toThrow('Unable to start Stripe Checkout');
      expect(ctx.sent('mark_payment_failed')).toEqual([
        { id: 'payment-1', error },
      ]);
    });
  });

  describe('statusForUser', () => {
    it.each(['', 'x'.repeat(201)])('hides session id %p', async (sessionId) => {
      const { service, registrations } = setup();

      await expect(service.statusForUser(sessionId, 'user-1')).rejects.toEqual(
        new NotFoundException('Payment not found'),
      );
      expect(registrations.send).not.toHaveBeenCalled();
    });

    it('asks the payment service for the member-scoped status', async () => {
      const ctx = setup();
      ctx.replies.get_payment_status_for_user = { payment: { status: 'Paid' } };

      await expect(
        ctx.service.statusForUser('cs_1', 'user-1'),
      ).resolves.toEqual({
        payment: { status: 'Paid' },
      });
      expect(ctx.sent('get_payment_status_for_user')).toEqual([
        { stripeCheckoutSessionId: 'cs_1', userId: 'user-1' },
      ]);
    });
  });

  describe('constructWebhookEvent', () => {
    it('rejects webhooks when no signing secret is configured', () => {
      const { service } = setup();

      expect(() =>
        service.constructWebhookEvent(Buffer.from('{}'), 'sig'),
      ).toThrow(new BadRequestException('Invalid Stripe webhook'));
    });

    it('rejects an invalid signature', () => {
      const { service, stripe } = setup({ STRIPE_WEBHOOK_SECRET: 'whsec_1' });
      stripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error('bad signature');
      });

      expect(() =>
        service.constructWebhookEvent(Buffer.from('{}'), 'sig'),
      ).toThrow(new BadRequestException('Invalid Stripe webhook signature'));
    });

    it('verifies the raw body with the signing secret', () => {
      const { service, stripe } = setup({ STRIPE_WEBHOOK_SECRET: 'whsec_1' });
      const event = { id: 'evt_1' };
      const body = Buffer.from('{}');
      stripe.webhooks.constructEvent.mockReturnValue(event);

      expect(service.constructWebhookEvent(body, 'sig')).toBe(event);
      expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(
        body,
        'sig',
        'whsec_1',
      );
    });
  });

  describe('handleWebhook', () => {
    function claimed(ctx: ReturnType<typeof setup>) {
      ctx.replies.record_stripe_webhook_event = { claimed: true };
      return ctx;
    }

    it('records the event type and completes events it does not handle', async () => {
      const ctx = claimed(setup());

      await ctx.service.handleWebhook(checkoutEvent('customer.created', {}));

      expect(ctx.sent('record_stripe_webhook_event')).toEqual([
        { stripeEventId: 'evt_1', eventType: 'customer.created' },
      ]);
      expect(ctx.sent('complete_stripe_webhook_event')).toEqual([
        { stripeEventId: 'evt_1' },
      ]);
    });

    it.each([
      ['checkout.session.async_payment_failed', 'mark_payment_failed'],
      ['checkout.session.expired', 'mark_payment_expired'],
    ])('handles %s by payment id', async (type, cmd) => {
      const ctx = claimed(setup());

      await ctx.service.handleWebhook(
        checkoutEvent(type, { metadata: { paymentId: 'payment-1' } }),
      );
      await ctx.service.handleWebhook(
        checkoutEvent(type, {
          metadata: null,
          client_reference_id: 'payment-2',
        }),
      );
      await ctx.service.handleWebhook(
        checkoutEvent(type, { metadata: {}, client_reference_id: null }),
      );

      expect(ctx.sent(cmd)).toEqual([{ id: 'payment-1' }, { id: 'payment-2' }]);
    });

    it.each([
      ['a PaymentIntent id', 'pi_1'],
      ['an expanded PaymentIntent', { id: 'pi_1' }],
    ])('fails the refund for refund.failed with %s', async (_label, pi) => {
      const ctx = claimed(setup());
      ctx.replies.get_payment_by_payment_intent = { id: 'payment-1' };

      await ctx.service.handleWebhook(
        checkoutEvent('refund.failed', { payment_intent: pi }),
      );

      expect(ctx.sent('get_payment_by_payment_intent')).toEqual([
        { paymentIntentId: 'pi_1' },
      ]);
      expect(ctx.sent('fail_payment_refund')).toEqual([
        { paymentId: 'payment-1', error: 'Stripe reported a failed refund' },
      ]);
    });

    it('ignores refund.failed without a known payment', async () => {
      const ctx = claimed(setup());
      ctx.replies.get_payment_by_payment_intent = null;

      await ctx.service.handleWebhook(
        checkoutEvent('refund.failed', { payment_intent: null }),
      );
      await ctx.service.handleWebhook(
        checkoutEvent('refund.failed', { payment_intent: 'pi_unknown' }),
      );

      expect(ctx.sent('get_payment_by_payment_intent')).toHaveLength(1);
      expect(ctx.sent('fail_payment_refund')).toEqual([]);
    });

    it('records the failure and rethrows when handling fails', async () => {
      const ctx = claimed(setup());
      const event = checkoutEvent('checkout.session.completed', {
        ...paidSession,
        metadata: {},
        client_reference_id: null,
      });

      await expect(ctx.service.handleWebhook(event)).rejects.toThrow(
        'Stripe Checkout metadata is invalid',
      );
      expect(ctx.sent('fail_stripe_webhook_event')).toEqual([
        {
          stripeEventId: 'evt_1',
          error: 'Stripe Checkout metadata is invalid',
        },
      ]);
      expect(ctx.sent('complete_stripe_webhook_event')).toEqual([]);
    });

    it('records a generic message when a handler throws a non-Error', async () => {
      const ctx = claimed(setup());
      jest
        .spyOn(
          ctx.service as unknown as { handleRefundEvent: () => Promise<void> },
          'handleRefundEvent',
        )
        .mockRejectedValue('boom');

      await expect(
        ctx.service.handleWebhook(checkoutEvent('refund.updated', {})),
      ).rejects.toBe('boom');
      expect(ctx.sent('fail_stripe_webhook_event')).toEqual([
        { stripeEventId: 'evt_1', error: 'Webhook processing failed' },
      ]);
    });

    it('records a generic failure for non-Error throws and survives a failed record', async () => {
      const ctx = claimed(setup());
      ctx.replies.mark_payment_expired = new RpcFailure('boom');
      ctx.replies.fail_stripe_webhook_event = new RpcFailure({
        statusCode: 500,
      });

      await expect(
        ctx.service.handleWebhook(
          checkoutEvent('checkout.session.expired', {
            metadata: { paymentId: 'payment-1' },
          }),
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(ctx.sent('fail_stripe_webhook_event')).toEqual([
        { stripeEventId: 'evt_1', error: 'Payment service unavailable' },
      ]);
    });

    describe('successful checkout', () => {
      function fulfillment(ctx: ReturnType<typeof setup>) {
        claimed(ctx);
        ctx.replies.get_payment_by_id = paidPayment;
        ctx.replies.finalize_paid_registration = {
          payment: paidPayment,
          needsRefund: false,
        };
        return ctx;
      }

      it.each([
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
      ])('finalizes the registration for %s', async (type) => {
        const ctx = fulfillment(setup());

        await ctx.service.handleWebhook(checkoutEvent(type, paidSession));

        expect(ctx.sent('finalize_paid_registration')).toEqual([
          {
            paymentId: 'payment-1',
            checkoutSessionId: 'cs_1',
            paymentIntentId: 'pi_1',
            amountCents: 1550,
            currency: 'usd',
            capacity: 5,
            classStatus: 'Scheduled',
            classEndAt: openClass.endDate,
          },
        ]);
        expect(ctx.sent('begin_payment_refund')).toEqual([]);
      });

      it('waits for unpaid sessions to be paid', async () => {
        const ctx = fulfillment(setup());

        await ctx.service.handleWebhook(
          checkoutEvent('checkout.session.completed', {
            ...paidSession,
            payment_status: 'unpaid',
          }),
        );

        expect(ctx.sent('get_payment_by_id')).toEqual([]);
      });

      it('falls back to the client reference id and an expanded PaymentIntent', async () => {
        const ctx = fulfillment(setup());

        await ctx.service.handleWebhook(
          checkoutEvent('checkout.session.completed', {
            ...paidSession,
            metadata: { classId: '1', userId: 'user-1' },
            client_reference_id: 'payment-1',
            payment_intent: { id: 'pi_1' },
          }),
        );

        expect(ctx.sent('finalize_paid_registration')[0]).toMatchObject({
          paymentId: 'payment-1',
          paymentIntentId: null,
        });
      });

      it.each([
        ['no user', { metadata: { paymentId: 'payment-1', classId: '1' } }],
        [
          'a non-numeric class',
          {
            metadata: {
              paymentId: 'payment-1',
              classId: 'x',
              userId: 'user-1',
            },
          },
        ],
        ['no metadata', { metadata: null, client_reference_id: 'payment-1' }],
        ['no amount', { amount_total: null }],
        ['no currency', { currency: null }],
      ])('rejects a session with %s', async (_label, overrides) => {
        const ctx = fulfillment(setup());

        await expect(
          ctx.service.handleWebhook(
            checkoutEvent('checkout.session.completed', {
              ...paidSession,
              ...overrides,
            }),
          ),
        ).rejects.toThrow('Stripe Checkout metadata is invalid');
      });

      it.each([
        ['is unknown', null],
        ['belongs to another member', { ...paidPayment, userId: 'user-2' }],
        ['is for another class', { ...paidPayment, classId: 2 }],
      ])('rejects a payment that %s', async (_label, payment) => {
        const ctx = fulfillment(setup());
        ctx.replies.get_payment_by_id = payment;

        await expect(
          ctx.service.handleWebhook(
            checkoutEvent('checkout.session.completed', paidSession),
          ),
        ).rejects.toThrow('Stripe payment ownership is invalid');
      });

      it('rejects a payment linked to a different session', async () => {
        const ctx = fulfillment(setup());
        ctx.replies.get_payment_by_id = {
          ...paidPayment,
          stripeCheckoutSessionId: 'cs_other',
        };

        await expect(
          ctx.service.handleWebhook(
            checkoutEvent('checkout.session.completed', paidSession),
          ),
        ).rejects.toThrow('Stripe Checkout session does not match payment');
      });

      it('rejects a payment for a class that no longer exists', async () => {
        const ctx = fulfillment(setup());
        ctx.classes.send.mockReturnValue(of(null));

        await expect(
          ctx.service.handleWebhook(
            checkoutEvent('checkout.session.completed', paidSession),
          ),
        ).rejects.toThrow('Class 1 not found');
      });

      it('refunds in full when the seat cannot be granted', async () => {
        const ctx = fulfillment(setup());
        ctx.replies.finalize_paid_registration = {
          payment: paidPayment,
          needsRefund: true,
        };
        ctx.replies.begin_payment_refund = {
          ...paidPayment,
          refundStatus: 'Pending',
          refundAmountCents: 1550,
        };
        ctx.stripe.refunds.create.mockResolvedValue({
          id: 're_1',
          amount: 1550,
          status: 'succeeded',
        });

        await ctx.service.handleWebhook(
          checkoutEvent('checkout.session.completed', paidSession),
        );

        expect(ctx.sent('begin_payment_refund')).toEqual([
          { paymentId: 'payment-1', percentage: 100 },
        ]);
        expect(ctx.sent('complete_payment_refund')).toHaveLength(1);
      });
    });

    describe('refund events', () => {
      const pendingRefund = {
        ...paidPayment,
        refundStatus: 'Pending',
        refundAmountCents: 1550,
        stripeRefundId: 're_1',
      };

      function refundEvent(
        type: 'refund.updated' | 'charge.refunded',
        object: Record<string, unknown>,
      ) {
        return checkoutEvent(type, {
          object: type === 'refund.updated' ? 'refund' : 'charge',
          payment_intent: 'pi_1',
          ...object,
        });
      }

      function withPayment(payment: unknown) {
        const ctx = claimed(setup());
        ctx.replies.get_payment_by_payment_intent = payment;
        return ctx;
      }

      it('completes a succeeded refund', async () => {
        const ctx = withPayment(pendingRefund);

        await ctx.service.handleWebhook(
          refundEvent('refund.updated', {
            id: 're_1',
            status: 'succeeded',
            amount: 1550,
          }),
        );

        expect(ctx.sent('complete_payment_refund')).toEqual([
          { paymentId: 'payment-1', stripeRefundId: 're_1', amountCents: 1550 },
        ]);
      });

      it('completes a fully refunded charge without treating the charge id as the refund id', async () => {
        const ctx = withPayment(pendingRefund);

        await ctx.service.handleWebhook(
          refundEvent('charge.refunded', {
            id: 'ch_1',
            status: 'succeeded',
            refunded: true,
            amount_refunded: 1550,
          }),
        );

        expect(ctx.sent('fail_payment_refund')).toEqual([]);
        expect(ctx.sent('complete_payment_refund')).toEqual([
          {
            paymentId: 'payment-1',
            stripeRefundId: undefined,
            amountCents: 1550,
          },
        ]);
      });

      it('ignores a partially refunded charge', async () => {
        const ctx = withPayment(pendingRefund);

        await ctx.service.handleWebhook(
          refundEvent('charge.refunded', {
            refunded: false,
            amount_refunded: 500,
          }),
        );

        expect(ctx.sent('complete_payment_refund')).toEqual([]);
        expect(ctx.sent('fail_payment_refund')).toEqual([]);
      });

      it('ignores events for a refund that already succeeded', async () => {
        const ctx = withPayment({
          ...pendingRefund,
          refundStatus: 'Succeeded',
        });

        await ctx.service.handleWebhook(
          refundEvent('charge.refunded', {
            refunded: true,
            amount_refunded: 1550,
          }),
        );

        expect(ctx.sent('complete_payment_refund')).toEqual([]);
      });

      it.each(['failed', 'canceled'])('fails a %s refund', async (status) => {
        const ctx = withPayment(pendingRefund);

        await ctx.service.handleWebhook(
          refundEvent('refund.updated', { id: 're_1', status, amount: 1550 }),
        );

        expect(ctx.sent('fail_payment_refund')).toEqual([
          {
            paymentId: 'payment-1',
            error: `Stripe reported a ${status} refund`,
          },
        ]);
      });

      it('waits while Stripe is still processing the refund', async () => {
        const ctx = withPayment(pendingRefund);

        await ctx.service.handleWebhook(
          refundEvent('refund.updated', {
            id: 're_1',
            status: 'pending',
            amount: 1550,
          }),
        );

        expect(ctx.sent('complete_payment_refund')).toEqual([]);
        expect(ctx.sent('fail_payment_refund')).toEqual([]);
      });

      it.each([
        ['a different amount', pendingRefund, 1000],
        [
          'no requested amount',
          { ...pendingRefund, refundAmountCents: null },
          1550,
        ],
      ])('fails a refund with %s', async (_label, payment, amount) => {
        const ctx = withPayment(payment);

        await ctx.service.handleWebhook(
          refundEvent('refund.updated', {
            id: 're_1',
            status: 'succeeded',
            amount,
          }),
        );

        expect(ctx.sent('fail_payment_refund')).toEqual([
          {
            paymentId: 'payment-1',
            error: 'Stripe refund amount did not match the requested amount',
          },
        ]);
      });

      it('fails a refund that is not the one recorded for the payment', async () => {
        const ctx = withPayment(pendingRefund);

        await ctx.service.handleWebhook(
          refundEvent('refund.updated', {
            id: 're_2',
            status: 'succeeded',
            amount: 1550,
          }),
        );

        expect(ctx.sent('fail_payment_refund')).toEqual([
          {
            paymentId: 'payment-1',
            error: 'Stripe refund identity did not match the requested refund',
          },
        ]);
      });

      it('ignores refunds without a PaymentIntent or a known payment', async () => {
        const ctx = withPayment(null);

        await ctx.service.handleWebhook(
          refundEvent('refund.updated', { payment_intent: null }),
        );
        await ctx.service.handleWebhook(
          refundEvent('refund.updated', { id: 're_1', status: 'succeeded' }),
        );

        expect(ctx.sent('get_payment_by_payment_intent')).toHaveLength(1);
        expect(ctx.sent('complete_payment_refund')).toEqual([]);
      });
    });
  });

  describe('refundPayment', () => {
    const pending = {
      ...paidPayment,
      refundStatus: 'Pending',
      refundAmountCents: 1550,
    };

    it('rejects an unknown payment', async () => {
      const ctx = setup();
      ctx.replies.get_payment_by_id = null;

      await expect(ctx.service.refundPayment('missing')).rejects.toEqual(
        new NotFoundException('Payment not found'),
      );
    });

    it('requests a full refund for a payment without one', async () => {
      const ctx = setup();
      ctx.replies.get_payment_by_id = paidPayment;
      ctx.replies.begin_payment_refund = pending;
      ctx.stripe.refunds.create.mockResolvedValue({
        id: 're_1',
        amount: 1550,
        status: 'succeeded',
      });

      await ctx.service.refundPayment('payment-1');

      expect(ctx.sent('begin_payment_refund')).toEqual([
        { paymentId: 'payment-1', percentage: 100 },
      ]);
      expect(ctx.stripe.refunds.create).toHaveBeenCalledWith(
        {
          payment_intent: 'pi_1',
          amount: 1550,
          reason: 'requested_by_customer',
          metadata: { paymentId: 'payment-1' },
        },
        { idempotencyKey: 'refund:payment-1:1550' },
      );
    });

    it('retries a queued refund without requesting a new one', async () => {
      const ctx = setup();
      ctx.replies.get_payment_by_id = pending;
      ctx.stripe.refunds.create.mockResolvedValue({
        id: 're_1',
        amount: 1550,
        status: 'pending',
      });

      await ctx.service.refundPayment('payment-1');

      expect(ctx.sent('begin_payment_refund')).toEqual([]);
      expect(ctx.sent('record_payment_refund')).toEqual([
        { paymentId: 'payment-1', stripeRefundId: 're_1' },
      ]);
    });

    it('returns an already refunded payment', async () => {
      const ctx = setup();
      const refunded = { ...pending, refundStatus: 'Succeeded' };
      ctx.replies.get_payment_by_id = refunded;

      await expect(ctx.service.refundPayment('payment-1')).resolves.toEqual(
        refunded,
      );
      expect(ctx.stripe.refunds.create).not.toHaveBeenCalled();
    });

    it.each([
      ['no PaymentIntent', { stripePaymentIntentId: null }],
      ['no refund amount', { refundAmountCents: null }],
    ])('cannot refund a payment with %s yet', async (_label, overrides) => {
      const ctx = setup();
      ctx.replies.get_payment_by_id = { ...pending, ...overrides };

      await expect(ctx.service.refundPayment('payment-1')).rejects.toEqual(
        new ConflictException('Payment cannot be refunded yet'),
      );
    });

    it('re-checks the refund already recorded for the payment', async () => {
      const ctx = setup();
      ctx.replies.get_payment_by_id = { ...pending, stripeRefundId: 're_1' };
      ctx.stripe.refunds.retrieve.mockResolvedValue({
        id: 're_1',
        amount: 1550,
        status: 'succeeded',
      });

      await ctx.service.refundPayment('payment-1');

      expect(ctx.stripe.refunds.retrieve).toHaveBeenCalledWith('re_1');
      expect(ctx.stripe.refunds.list).not.toHaveBeenCalled();
      expect(ctx.stripe.refunds.create).not.toHaveBeenCalled();
      expect(ctx.sent('complete_payment_refund')).toHaveLength(1);
    });

    it('ignores refunds for other payments or that failed when looking for one to reuse', async () => {
      const ctx = setup();
      ctx.replies.get_payment_by_id = pending;
      ctx.stripe.refunds.list.mockResolvedValue({
        data: [
          { id: 're_a', status: 'succeeded', metadata: { paymentId: 'other' } },
          {
            id: 're_b',
            status: 'failed',
            metadata: { paymentId: 'payment-1' },
          },
          {
            id: 're_c',
            status: 'canceled',
            metadata: { paymentId: 'payment-1' },
          },
          { id: 're_d', status: 'succeeded', metadata: null },
        ],
      });
      ctx.stripe.refunds.create.mockResolvedValue({
        id: 're_new',
        amount: 1550,
        status: 'succeeded',
      });

      await ctx.service.refundPayment('payment-1');

      expect(ctx.stripe.refunds.list).toHaveBeenCalledWith({
        payment_intent: 'pi_1',
        limit: 100,
      });
      expect(ctx.sent('complete_payment_refund')).toEqual([
        { paymentId: 'payment-1', stripeRefundId: 're_new', amountCents: 1550 },
      ]);
    });

    it.each([
      [new Error('card_declined'), 'card_declined'],
      ['timeout', 'Refund failed'],
    ])('records Stripe error %p as a failed refund', async (error, message) => {
      const ctx = setup();
      ctx.replies.get_payment_by_id = pending;
      ctx.stripe.refunds.create.mockRejectedValue(error);

      await expect(ctx.service.refundPayment('payment-1')).rejects.toEqual(
        new ServiceUnavailableException('Unable to issue Stripe refund'),
      );
      expect(ctx.sent('fail_payment_refund')).toEqual([
        { paymentId: 'payment-1', error: message },
      ]);
    });

    it('still reports the Stripe failure when recording it fails', async () => {
      const ctx = setup();
      ctx.replies.get_payment_by_id = pending;
      ctx.replies.fail_payment_refund = new RpcFailure({ statusCode: 500 });
      ctx.stripe.refunds.create.mockRejectedValue(new Error('down'));

      await expect(ctx.service.refundPayment('payment-1')).rejects.toThrow(
        'Unable to issue Stripe refund',
      );
    });

    it('fails a refund when Stripe refunded a different amount', async () => {
      const ctx = setup();
      ctx.replies.get_payment_by_id = pending;
      ctx.stripe.refunds.create.mockResolvedValue({
        id: 're_1',
        amount: 1000,
        status: 'succeeded',
      });

      await expect(ctx.service.refundPayment('payment-1')).rejects.toEqual(
        new ConflictException('Stripe refund amount did not match'),
      );
      expect(ctx.sent('fail_payment_refund')).toEqual([
        {
          paymentId: 'payment-1',
          error: 'Stripe refund amount did not match the requested amount',
        },
      ]);
      expect(ctx.sent('complete_payment_refund')).toEqual([]);
    });

    it('fails a refund Stripe could not process', async () => {
      const ctx = setup();
      ctx.replies.get_payment_by_id = pending;
      ctx.stripe.refunds.create.mockResolvedValue({
        id: 're_1',
        amount: 1550,
        status: 'failed',
      });

      await expect(ctx.service.refundPayment('payment-1')).rejects.toEqual(
        new ServiceUnavailableException('Stripe refund did not succeed'),
      );
      expect(ctx.sent('fail_payment_refund')).toEqual([
        { paymentId: 'payment-1', error: 'Stripe refund status: failed' },
      ]);
    });
  });

  describe('class refunds and the retry sweep', () => {
    it('refunds every payment of a canceled class and continues past failures', async () => {
      const ctx = setup();
      const error = jest
        .spyOn(
          (ctx.service as unknown as { logger: { error: jest.Mock } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);
      ctx.replies.begin_class_refunds = [
        { id: 'payment-1' },
        { id: 'payment-2' },
      ];
      const refund = jest
        .spyOn(ctx.service, 'refundPayment')
        .mockRejectedValueOnce(new Error('declined'))
        .mockResolvedValueOnce({ id: 'payment-2' });

      await expect(ctx.service.refundClassPayments(1)).resolves.toEqual([
        { id: 'payment-2' },
      ]);
      expect(ctx.sent('begin_class_refunds')).toEqual([{ classId: 1 }]);
      expect(refund.mock.calls).toEqual([['payment-1'], ['payment-2']]);
      expect(error).toHaveBeenCalledWith(
        'Refund attempt failed for payment payment-',
        expect.any(String),
      );
    });

    it('logs non-Error refund failures without a stack', async () => {
      const ctx = setup();
      const error = jest
        .spyOn(
          (ctx.service as unknown as { logger: { error: jest.Mock } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);
      ctx.replies.begin_class_refunds = [{ id: 'payment-1' }];
      jest.spyOn(ctx.service, 'refundPayment').mockRejectedValue('declined');

      await ctx.service.refundClassPayments(1);

      expect(error).toHaveBeenCalledWith(
        'Refund attempt failed for payment payment-',
        undefined,
      );
    });

    it('retries every due refund and keeps going after a failure', async () => {
      const ctx = setup();
      ctx.replies.list_refund_pending_payments = [
        { id: 'payment-1' },
        { id: 'payment-2' },
      ];
      const refund = jest
        .spyOn(ctx.service, 'refundPayment')
        .mockRejectedValueOnce(new Error('declined'))
        .mockResolvedValueOnce({});

      await ctx.service.retryRefunds();

      expect(refund.mock.calls).toEqual([['payment-1'], ['payment-2']]);
    });

    it('logs a sweep that cannot list refunds', async () => {
      const ctx = setup();
      const warn = jest
        .spyOn(
          (ctx.service as unknown as { logger: { warn: jest.Mock } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      ctx.replies.list_refund_pending_payments = new RpcFailure({
        statusCode: 500,
      });

      await ctx.service.retryRefunds();

      expect(warn).toHaveBeenCalledWith('Refund retry sweep failed');
    });
  });

  it('lists payments for admins', async () => {
    const ctx = setup();
    ctx.replies.get_all_payments = [{ id: 'payment-1' }];

    await expect(ctx.service.getAllPayments()).resolves.toEqual([
      { id: 'payment-1' },
    ]);
  });
});
