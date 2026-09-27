import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { StripeController } from './StripeController';

describe('StripeController', () => {
  const stripeService = {
    createCheckoutSession: jest.fn().mockResolvedValue({ url: 'u' }),
    constructWebhookEvent: jest.fn(),
    handleWebhook: jest.fn().mockResolvedValue(undefined),
    statusForUser: jest.fn().mockResolvedValue({ payment: {} }),
    getAllPayments: jest.fn().mockResolvedValue([]),
    refundPayment: jest.fn().mockResolvedValue({}),
  };
  let publicAppUrl: string | undefined;
  let controller: StripeController;

  beforeEach(() => {
    jest.clearAllMocks();
    publicAppUrl = 'https://app.test';
    controller = new StripeController(
      stripeService as never,
      { get: jest.fn(() => publicAppUrl) } as never,
    );
  });

  function request(
    overrides: {
      userId?: string;
      origin?: string;
      headers?: Record<string, unknown>;
      body?: unknown;
    } = {},
  ) {
    return {
      session: overrides.userId ? { userId: overrides.userId } : {},
      headers: {
        ...(overrides.origin ? { origin: overrides.origin } : {}),
        ...overrides.headers,
      },
      body: overrides.body,
    } as unknown as Request;
  }

  describe('create-session', () => {
    it('starts checkout for the signed-in member', async () => {
      await expect(
        controller.createSession(
          request({ userId: 'user-1', origin: 'https://app.test' }),
          { classId: 3 },
        ),
      ).resolves.toEqual({ url: 'u' });
      expect(stripeService.createCheckoutSession).toHaveBeenCalledWith(
        'user-1',
        3,
      );
    });

    it('accepts requests without an Origin header', () => {
      void controller.createSession(request({ userId: 'user-1' }), {
        classId: 3,
      });
      expect(stripeService.createCheckoutSession).toHaveBeenCalled();
    });

    it('accepts a numeric string class id', () => {
      void controller.createSession(request({ userId: 'user-1' }), {
        classId: '3' as never,
      });
      expect(stripeService.createCheckoutSession).toHaveBeenCalledWith(
        'user-1',
        3,
      );
    });

    it.each([
      ['a different origin', 'https://evil.test', 'https://app.test'],
      ['an unconfigured app URL', 'https://app.test', undefined],
      ['an invalid app URL', 'https://app.test', 'not a url'],
    ])('rejects %s', (_label, origin, configured) => {
      publicAppUrl = configured;

      expect(() =>
        controller.createSession(request({ userId: 'user-1', origin }), {
          classId: 3,
        }),
      ).toThrow(new ForbiddenException('Invalid request origin'));
    });

    it('requires a signed-in member', () => {
      expect(() => controller.createSession(request(), { classId: 3 })).toThrow(
        new UnauthorizedException('Not authenticated'),
      );
    });

    it.each([
      [undefined, 'Invalid checkout request'],
      [{ classId: 3, amountCents: 1 }, 'Invalid checkout request'],
      [{}, 'classId must be a positive integer'],
      [{ classId: 0 }, 'classId must be a positive integer'],
      [{ classId: 1.5 }, 'classId must be a positive integer'],
      [{ classId: 'abc' }, 'classId must be a positive integer'],
    ])('rejects body %j', (body, message) => {
      expect(() =>
        controller.createSession(request({ userId: 'user-1' }), body as never),
      ).toThrow(new BadRequestException(message));
      expect(stripeService.createCheckoutSession).not.toHaveBeenCalled();
    });
  });

  describe('webhook', () => {
    it('verifies the signature over the raw body and handles the event', async () => {
      const body = Buffer.from('{}');
      const event = { id: 'evt_1' };
      stripeService.constructWebhookEvent.mockReturnValue(event);

      await expect(
        controller.webhook(
          request({ headers: { 'stripe-signature': 'sig' }, body }),
        ),
      ).resolves.toEqual({ received: true });
      expect(stripeService.constructWebhookEvent).toHaveBeenCalledWith(
        body,
        'sig',
      );
      expect(stripeService.handleWebhook).toHaveBeenCalledWith(event);
    });

    it.each([
      ['no signature', {}, Buffer.from('{}')],
      [
        'repeated signatures',
        { 'stripe-signature': ['a', 'b'] },
        Buffer.from('{}'),
      ],
      ['a parsed body', { 'stripe-signature': 'sig' }, { id: 'evt_1' }],
    ])('rejects a webhook with %s', async (_label, headers, body) => {
      await expect(
        controller.webhook(request({ headers, body })),
      ).rejects.toThrow(new BadRequestException('Invalid Stripe webhook'));
      expect(stripeService.handleWebhook).not.toHaveBeenCalled();
    });
  });

  describe('status', () => {
    it('returns the payment status for the signed-in member', async () => {
      await expect(
        controller.status(request({ userId: 'user-1' }), 'cs_1'),
      ).resolves.toEqual({ payment: {} });
      expect(stripeService.statusForUser).toHaveBeenCalledWith(
        'cs_1',
        'user-1',
      );
    });

    it('requires a signed-in member', () => {
      expect(() => controller.status(request(), 'cs_1')).toThrow(
        UnauthorizedException,
      );
    });

    it('requires a session id', () => {
      expect(() => controller.status(request({ userId: 'user-1' }))).toThrow(
        new BadRequestException('session_id is required'),
      );
    });
  });

  it('lists payments for admins', async () => {
    await expect(controller.payments()).resolves.toEqual([]);
  });

  describe('refund', () => {
    it.each([
      [undefined, undefined],
      [{}, undefined],
      [{ percentage: 50 }, 50],
    ])('refunds with body %j', async (body, percentage) => {
      await controller.refund(
        request({ origin: 'https://app.test' }),
        'payment-1',
        body,
      );
      expect(stripeService.refundPayment).toHaveBeenCalledWith(
        'payment-1',
        percentage,
      );
    });

    it('rejects unexpected fields', () => {
      expect(() =>
        controller.refund(request(), 'payment-1', {
          percentage: 50,
          amountCents: 1,
        } as never),
      ).toThrow(new BadRequestException('Invalid refund request'));
    });

    it('rejects cross-origin refund requests', () => {
      expect(() =>
        controller.refund(request({ origin: 'https://evil.test' }), 'p', {}),
      ).toThrow(ForbiddenException);
      expect(stripeService.refundPayment).not.toHaveBeenCalled();
    });
  });
});
