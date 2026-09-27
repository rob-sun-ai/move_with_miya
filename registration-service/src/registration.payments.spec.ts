import { RegistrationService } from './registration.service';

jest.mock('./prisma/prisma.service', () => ({ PrismaService: jest.fn() }));

const FUTURE = '2099-01-01T11:00:00.000Z';
const PAST = '2000-01-01T11:00:00.000Z';

function createPrisma() {
  const prisma = {
    registration: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    stripeWebhookEvent: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (callback: (tx: typeof prisma) => unknown) => callback(prisma),
  );
  // Updates echo the merged record so callers can inspect the result.
  prisma.payment.update.mockImplementation(
    ({ where, data }: { where: { id: string }; data: object }) =>
      Promise.resolve({ id: where.id, ...data }),
  );
  return prisma;
}

function paymentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payment-1',
    userId: 'user-1',
    classId: 10,
    amountCents: 2500,
    currency: 'usd',
    status: 'Pending',
    refundStatus: 'None',
    refundPercentage: null,
    refundAmountCents: null,
    stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: null,
    stripeRefundId: null,
    registrationId: null,
    paidAt: null,
    expiresAt: new Date(FUTURE),
    ...overrides,
  };
}

describe('RegistrationService payments', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: RegistrationService;

  beforeEach(() => {
    prisma = createPrisma();
    service = new RegistrationService({ client: prisma } as never);
  });

  describe('getClassPaymentAvailability', () => {
    it.each([0, -1, 1.5])('rejects capacity %p', async (capacity) => {
      await expect(
        service.getClassPaymentAvailability(10, capacity),
      ).rejects.toMatchObject({ message: 'Class capacity is invalid' });
    });

    it('counts registrations and unexpired pending checkouts', async () => {
      prisma.registration.count.mockResolvedValue(6);
      prisma.payment.count.mockResolvedValue(3);

      await expect(
        service.getClassPaymentAvailability(10, 10),
      ).resolves.toEqual({
        classId: 10,
        capacity: 10,
        registered: 6,
        pending: 3,
        available: 1,
      });
      expect(prisma.payment.count).toHaveBeenCalledWith({
        where: {
          classId: 10,
          status: 'Pending',
          expiresAt: { gt: expect.any(Date) as unknown },
        },
      });
    });

    it('never reports negative availability', async () => {
      prisma.registration.count.mockResolvedValue(10);
      prisma.payment.count.mockResolvedValue(2);

      await expect(
        service.getClassPaymentAvailability(10, 10),
      ).resolves.toMatchObject({ available: 0 });
    });
  });

  describe('createOrGetPendingPayment', () => {
    const input = {
      userId: 'user-1',
      classId: 10,
      capacity: 5,
      amountCents: 2500,
      currency: 'usd',
      expiresAt: FUTURE,
    };

    it.each([
      [{ amountCents: 0 }, 'Payment amount is invalid'],
      [{ amountCents: 12.5 }, 'Payment amount is invalid'],
      [{ amountCents: Number.NaN }, 'Payment amount is invalid'],
      [{ currency: 'USD' }, 'Payment currency is invalid'],
      [{ currency: 'us' }, 'Payment currency is invalid'],
      [{ userId: '' }, 'Payment owner or class is invalid'],
      [{ classId: 0 }, 'Payment owner or class is invalid'],
      [{ classId: 1.5 }, 'Payment owner or class is invalid'],
      [{ expiresAt: 'not a date' }, 'Payment expiration is invalid'],
      [{ expiresAt: PAST }, 'Payment expiration is invalid'],
    ])('rejects %o', async (overrides, message) => {
      await expect(
        service.createOrGetPendingPayment({ ...input, ...overrides }),
      ).rejects.toMatchObject({ message });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a member who is already registered', async () => {
      prisma.registration.findFirst.mockResolvedValue({ status: 'Registered' });

      await expect(
        service.createOrGetPendingPayment(input),
      ).rejects.toMatchObject({ message: 'Already registered for this class' });
    });

    it('returns a payment that is already paid', async () => {
      const paid = paymentRecord({ status: 'Paid' });
      prisma.payment.findFirst.mockResolvedValue(paid);

      await expect(service.createOrGetPendingPayment(input)).resolves.toBe(
        paid,
      );
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('reuses an unexpired pending checkout for the same price', async () => {
      const pending = paymentRecord();
      prisma.registration.findFirst.mockResolvedValue({ status: 'Canceled' });
      prisma.payment.findFirst.mockResolvedValue(pending);

      await expect(service.createOrGetPendingPayment(input)).resolves.toBe(
        pending,
      );
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it.each([
      ['has expired', { expiresAt: new Date(PAST) }],
      ['has a different amount', { amountCents: 2000 }],
      ['has a different currency', { currency: 'eur' }],
    ])(
      'expires a pending checkout that %s and creates a new one',
      async (_label, overrides) => {
        prisma.payment.findFirst.mockResolvedValue(paymentRecord(overrides));
        prisma.payment.create.mockResolvedValue({ id: 'payment-2' });

        await expect(service.createOrGetPendingPayment(input)).resolves.toEqual(
          { id: 'payment-2' },
        );
        expect(prisma.payment.update).toHaveBeenCalledWith({
          where: { id: 'payment-1' },
          data: { status: 'Expired' },
        });
      },
    );

    it('counts held checkouts against capacity', async () => {
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.registration.count.mockResolvedValue(3);
      prisma.payment.count.mockResolvedValue(2);

      await expect(
        service.createOrGetPendingPayment(input),
      ).rejects.toMatchObject({ message: 'Class is full' });
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('creates a pending payment inside a serializable transaction', async () => {
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.registration.count.mockResolvedValue(4);
      prisma.payment.create.mockResolvedValue({ id: 'payment-2' });

      await service.createOrGetPendingPayment(input);

      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          classId: 10,
          amountCents: 2500,
          currency: 'usd',
          expiresAt: new Date(FUTURE),
        },
      });
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable',
      });
    });

    it('retries serialization conflicts and then gives up', async () => {
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.payment.create.mockResolvedValue({ id: 'payment-2' });
      prisma.$transaction
        .mockRejectedValueOnce({ code: 'P2034' })
        .mockImplementationOnce((callback: (tx: typeof prisma) => unknown) =>
          callback(prisma),
        );

      await expect(service.createOrGetPendingPayment(input)).resolves.toEqual({
        id: 'payment-2',
      });

      prisma.$transaction.mockRejectedValue({ code: 'P2034' });
      await expect(
        service.createOrGetPendingPayment(input),
      ).rejects.toMatchObject({ code: 'P2034' });
    });

    it('does not retry other transaction errors', async () => {
      prisma.$transaction.mockRejectedValue(new Error('connection lost'));

      await expect(service.createOrGetPendingPayment(input)).rejects.toThrow(
        'connection lost',
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('attachCheckoutSession', () => {
    it.each([
      { paymentId: '', stripeCheckoutSessionId: 'cs_1' },
      { paymentId: 'payment-1', stripeCheckoutSessionId: '' },
    ])('requires both ids: %o', async (data) => {
      await expect(service.attachCheckoutSession(data)).rejects.toMatchObject({
        message: 'Payment and Checkout session are required',
      });
    });

    it('rejects an unknown payment', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.attachCheckoutSession({
          paymentId: 'missing',
          stripeCheckoutSessionId: 'cs_1',
        }),
      ).rejects.toMatchObject({ message: 'Payment not found' });
    });

    it('refuses to replace a different session', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({ stripeCheckoutSessionId: 'cs_other' }),
      );

      await expect(
        service.attachCheckoutSession({
          paymentId: 'payment-1',
          stripeCheckoutSessionId: 'cs_1',
        }),
      ).rejects.toMatchObject({
        message: 'Payment already has a Checkout session',
      });
    });

    it.each([null, 'cs_1'])(
      'attaches the session when the current one is %p',
      async (current) => {
        prisma.payment.findUnique.mockResolvedValue(
          paymentRecord({ stripeCheckoutSessionId: current }),
        );

        await service.attachCheckoutSession({
          paymentId: 'payment-1',
          stripeCheckoutSessionId: 'cs_1',
        });
        expect(prisma.payment.update).toHaveBeenCalledWith({
          where: { id: 'payment-1' },
          data: { stripeCheckoutSessionId: 'cs_1' },
        });
      },
    );
  });

  it('looks payments up by id, Checkout session, and PaymentIntent', async () => {
    await service.getPaymentById('payment-1');
    await service.getPaymentByCheckoutSession('cs_1');
    await service.getPaymentByPaymentIntent('pi_1');

    expect(prisma.payment.findUnique.mock.calls).toEqual([
      [{ where: { id: 'payment-1' } }],
      [{ where: { stripeCheckoutSessionId: 'cs_1' } }],
      [{ where: { stripePaymentIntentId: 'pi_1' } }],
    ]);
  });

  describe('getPaymentStatusForUser', () => {
    it.each([
      ['does not exist', null],
      ['belongs to another member', paymentRecord({ userId: 'user-2' })],
    ])('hides a payment that %s', async (_label, payment) => {
      prisma.payment.findUnique.mockResolvedValue(payment);

      await expect(
        service.getPaymentStatusForUser('cs_1', 'user-1'),
      ).rejects.toMatchObject({ message: 'Payment not found' });
    });

    it('returns no registration before fulfillment', async () => {
      prisma.payment.findUnique.mockResolvedValue(paymentRecord());

      await expect(
        service.getPaymentStatusForUser('cs_1', 'user-1'),
      ).resolves.toMatchObject({ registration: null });
      expect(prisma.registration.findUnique).not.toHaveBeenCalled();
    });

    it('returns no registration when the linked one no longer exists', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({ registrationId: 7 }),
      );
      prisma.registration.findUnique.mockResolvedValue(null);

      await expect(
        service.getPaymentStatusForUser('cs_1', 'user-1'),
      ).resolves.toMatchObject({ registration: null });
    });
  });

  describe('finalizePaidRegistration', () => {
    const input = {
      paymentId: 'payment-1',
      checkoutSessionId: 'cs_1',
      paymentIntentId: 'pi_1',
      amountCents: 2500,
      currency: 'usd',
      capacity: 10,
      classStatus: 'Scheduled',
      classEndAt: FUTURE,
    };
    const fullRefund = {
      status: 'Paid',
      refundStatus: 'Pending',
      refundPercentage: 100,
      refundAmountCents: 2500,
    };

    it.each([
      [{ amountCents: -5 }, 'Payment amount is invalid'],
      [{ currency: 'EUR' }, 'Payment currency is invalid'],
      [{ capacity: 0 }, 'Class capacity is invalid'],
      [{ classStatus: '' }, 'Class lifecycle data is invalid'],
      [{ classEndAt: 'soon' }, 'Class lifecycle data is invalid'],
    ])('rejects %o', async (overrides, message) => {
      await expect(
        service.finalizePaidRegistration({ ...input, ...overrides }),
      ).rejects.toMatchObject({ message });
    });

    it('rejects an unknown payment', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.finalizePaidRegistration(input),
      ).rejects.toMatchObject({ message: 'Payment not found' });
    });

    it.each([
      ['Checkout session', { stripeCheckoutSessionId: 'cs_other' }],
      ['amount', { amountCents: 2400 }],
      ['currency', { currency: 'eur' }],
      ['PaymentIntent', { stripePaymentIntentId: 'pi_other' }],
    ])('rejects a mismatched %s', async (_label, overrides) => {
      prisma.payment.findUnique.mockResolvedValue(paymentRecord(overrides));

      await expect(
        service.finalizePaidRegistration(input),
      ).rejects.toMatchObject({
        message: 'Stripe payment details do not match',
      });
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    describe('when the class can no longer be attended', () => {
      it.each([
        ['canceled', { classStatus: 'Canceled' }],
        ['completed', { classStatus: 'Completed' }],
        ['over', { classEndAt: PAST }],
      ])(
        'refunds a new payment in full when the class is %s',
        async (_l, o) => {
          prisma.payment.findUnique.mockResolvedValue(paymentRecord());

          const result = await service.finalizePaidRegistration({
            ...input,
            ...o,
          });

          expect(result).toMatchObject({
            registration: null,
            needsRefund: true,
            payment: { ...fullRefund, stripePaymentIntentId: 'pi_1' },
          });
          expect(prisma.registration.create).not.toHaveBeenCalled();
        },
      );

      it.each([
        ['refunded', { status: 'Refunded' }],
        ['refund-succeeded', { status: 'Paid', refundStatus: 'Succeeded' }],
        ['ineligible', { status: 'Paid', refundStatus: 'NotEligible' }],
      ])('does nothing for a %s payment', async (_label, overrides) => {
        prisma.payment.findUnique.mockResolvedValue(paymentRecord(overrides));

        await expect(
          service.finalizePaidRegistration({
            ...input,
            classStatus: 'Canceled',
          }),
        ).resolves.toMatchObject({ needsRefund: false });
        expect(prisma.payment.update).not.toHaveBeenCalled();
      });

      it('retries a failed refund without rewriting it', async () => {
        prisma.payment.findUnique.mockResolvedValue(
          paymentRecord({
            status: 'Paid',
            refundStatus: 'Failed',
            refundPercentage: 50,
          }),
        );

        await expect(
          service.finalizePaidRegistration({
            ...input,
            classStatus: 'Canceled',
          }),
        ).resolves.toMatchObject({ needsRefund: true });
        expect(prisma.payment.update).not.toHaveBeenCalled();
      });

      it('keeps the original paid-at time and PaymentIntent', async () => {
        const paidAt = new Date('2026-09-01T00:00:00.000Z');
        prisma.payment.findUnique.mockResolvedValue(
          paymentRecord({
            status: 'Paid',
            paidAt,
            stripePaymentIntentId: 'pi_1',
            registrationId: 3,
          }),
        );

        await service.finalizePaidRegistration({
          ...input,
          paymentIntentId: null,
          classStatus: 'Canceled',
        });

        expect(prisma.payment.update).toHaveBeenCalledWith({
          where: { id: 'payment-1' },
          data: expect.objectContaining({
            paidAt,
            stripePaymentIntentId: 'pi_1',
          }) as unknown,
        });
      });
    });

    it('returns an already fulfilled payment unchanged', async () => {
      const registration = { id: 3, status: 'Registered' };
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({ status: 'Paid', registrationId: 3 }),
      );
      prisma.registration.findUnique.mockResolvedValue(registration);

      await expect(
        service.finalizePaidRegistration(input),
      ).resolves.toMatchObject({ registration, needsRefund: false });
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it.each(['Expired', 'Failed'])(
      'refunds a late payment for a %s checkout in full',
      async (status) => {
        prisma.payment.findUnique.mockResolvedValue(paymentRecord({ status }));

        await expect(
          service.finalizePaidRegistration(input),
        ).resolves.toMatchObject({
          payment: fullRefund,
          registration: null,
          needsRefund: true,
        });
        expect(prisma.registration.create).not.toHaveBeenCalled();
      },
    );

    it('records a missing PaymentIntent on a paid, unregistered payment', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({ status: 'Paid', refundStatus: 'Pending' }),
      );

      await expect(
        service.finalizePaidRegistration(input),
      ).resolves.toMatchObject({ needsRefund: true });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment-1' },
        data: { stripePaymentIntentId: 'pi_1' },
      });
    });

    it('leaves a paid, unregistered payment with a PaymentIntent unchanged', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({
          status: 'Paid',
          refundStatus: 'Pending',
          stripePaymentIntentId: 'pi_1',
        }),
      );

      await expect(
        service.finalizePaidRegistration(input),
      ).resolves.toMatchObject({ needsRefund: true });
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('does not refund an already refunded payment again', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({ status: 'Refunded', stripePaymentIntentId: 'pi_1' }),
      );

      await expect(
        service.finalizePaidRegistration(input),
      ).resolves.toMatchObject({ needsRefund: false });
    });

    it('refunds a duplicate payment from a member who is already registered', async () => {
      const registration = {
        id: 4,
        classId: 10,
        userId: 'user-1',
        status: 'Registered',
      };
      prisma.payment.findUnique.mockResolvedValue(paymentRecord());
      prisma.registration.findFirst.mockResolvedValue(registration);

      await expect(
        service.finalizePaidRegistration(input),
      ).resolves.toMatchObject({
        payment: { ...fullRefund, registrationId: 4 },
        registration,
        needsRefund: true,
      });
      expect(prisma.registration.count).not.toHaveBeenCalled();
    });

    it('refunds a payment when the class filled up during checkout', async () => {
      prisma.payment.findUnique.mockResolvedValue(paymentRecord());
      prisma.registration.findFirst.mockResolvedValue(null);
      prisma.registration.count.mockResolvedValue(10);

      await expect(
        service.finalizePaidRegistration(input),
      ).resolves.toMatchObject({
        payment: fullRefund,
        registration: null,
        needsRefund: true,
      });
      expect(prisma.registration.create).not.toHaveBeenCalled();
    });

    it('registers the member, links the payment, and emits an event', async () => {
      const registration = {
        id: 5,
        classId: 10,
        userId: 'user-1',
        status: 'Registered',
      };
      prisma.payment.findUnique.mockResolvedValue(paymentRecord());
      prisma.registration.findFirst.mockResolvedValue(null);
      prisma.registration.count.mockResolvedValue(9);
      prisma.registration.create.mockResolvedValue(registration);

      await expect(
        service.finalizePaidRegistration(input),
      ).resolves.toMatchObject({
        payment: { status: 'Paid', registrationId: 5 },
        registration,
        needsRefund: false,
      });
      expect(prisma.registration.create).toHaveBeenCalledWith({
        data: {
          classId: 10,
          userId: 'user-1',
          status: 'Registered',
          source: 'stripe-webhook',
        },
      });
      expect(prisma.outboxEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'registration.confirmed',
          eventKey: 'registration:5:paid:payment-1',
          payload: expect.objectContaining({
            paymentId: 'payment-1',
          }) as unknown,
        }) as unknown,
      });
    });

    it('re-registers a member who had canceled', async () => {
      const canceled = {
        id: 6,
        classId: 10,
        userId: 'user-1',
        status: 'Canceled',
      };
      prisma.payment.findUnique.mockResolvedValue(paymentRecord());
      prisma.registration.findFirst.mockResolvedValue(canceled);
      prisma.registration.update.mockResolvedValue({
        ...canceled,
        status: 'Registered',
      });

      await service.finalizePaidRegistration({
        ...input,
        paymentIntentId: null,
      });

      expect(prisma.registration.update).toHaveBeenCalledWith({
        where: { id: 6 },
        data: expect.objectContaining({
          status: 'Registered',
          canceledAt: null,
          cancellationReason: null,
          source: 'stripe-webhook',
        }) as unknown,
      });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment-1' },
        data: expect.objectContaining({
          stripePaymentIntentId: undefined,
          registrationId: 6,
        }) as unknown,
      });
    });
  });

  describe('payment failure and expiry', () => {
    it('fails only pending payments and truncates the error', async () => {
      await service.markPaymentFailed('payment-1', 'x'.repeat(600));

      expect(prisma.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'payment-1', status: 'Pending' },
        data: { refundError: 'x'.repeat(500), status: 'Failed' },
      });
    });

    it('fails a payment without an error message', async () => {
      await service.markPaymentFailed('payment-1');

      expect(prisma.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'payment-1', status: 'Pending' },
        data: { refundError: undefined, status: 'Failed' },
      });
    });

    it('expires only pending payments', async () => {
      await service.markPaymentExpired('payment-1');

      expect(prisma.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'payment-1', status: 'Pending' },
        data: { status: 'Expired' },
      });
    });
  });

  describe('beginPaymentRefund', () => {
    it.each([-1, 101, 12.5])('rejects %p percent', async (percentage) => {
      await expect(
        service.beginPaymentRefund({ paymentId: 'payment-1', percentage }),
      ).rejects.toMatchObject({
        message: 'Refund percentage must be an integer from 0 to 100',
      });
    });

    it('rejects an unknown payment', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.beginPaymentRefund({ paymentId: 'missing', percentage: 100 }),
      ).rejects.toMatchObject({ message: 'Payment not found' });
    });

    it('only refunds paid payments', async () => {
      prisma.payment.findUnique.mockResolvedValue(paymentRecord());

      await expect(
        service.beginPaymentRefund({ paymentId: 'payment-1', percentage: 100 }),
      ).rejects.toMatchObject({
        message: 'Only paid payments can be refunded',
      });
    });

    it('returns a payment that was already refunded', async () => {
      const refunded = paymentRecord({
        status: 'Paid',
        refundStatus: 'Succeeded',
      });
      prisma.payment.findUnique.mockResolvedValue(refunded);

      await expect(
        service.beginPaymentRefund({ paymentId: 'payment-1', percentage: 100 }),
      ).resolves.toBe(refunded);
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('refuses to change a refund that is in progress', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({
          status: 'Paid',
          refundStatus: 'Pending',
          refundPercentage: 50,
        }),
      );

      await expect(
        service.beginPaymentRefund({ paymentId: 'payment-1', percentage: 100 }),
      ).rejects.toMatchObject({
        message: 'A different refund is already in progress',
      });
    });

    it('re-requests the same refund that is in progress', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({
          status: 'Paid',
          refundStatus: 'Pending',
          refundPercentage: 50,
        }),
      );

      await expect(
        service.beginPaymentRefund({ paymentId: 'payment-1', percentage: 50 }),
      ).resolves.toMatchObject({
        refundAmountCents: 1250,
        refundStatus: 'Pending',
      });
    });

    it('rounds partial refunds down to whole cents', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({ status: 'Paid', amountCents: 999 }),
      );

      await expect(
        service.beginPaymentRefund({ paymentId: 'payment-1', percentage: 50 }),
      ).resolves.toMatchObject({
        refundPercentage: 50,
        refundAmountCents: 499,
        refundStatus: 'Pending',
        refundError: null,
        refundRequestedAt: expect.any(Date) as unknown,
      });
    });

    it('marks a zero-amount refund as not eligible', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({ status: 'Paid', refundStatus: 'Failed' }),
      );

      await expect(
        service.beginPaymentRefund({ paymentId: 'payment-1', percentage: 0 }),
      ).resolves.toMatchObject({
        refundAmountCents: 0,
        refundStatus: 'NotEligible',
      });
    });
  });

  it('queues a full refund for every unrefunded paid payment in a class', async () => {
    prisma.payment.findMany.mockResolvedValue([
      { id: 'payment-1' },
      { id: 'payment-2' },
    ]);
    prisma.payment.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(paymentRecord({ id: where.id, status: 'Paid' })),
    );

    const result = await service.beginClassRefunds(10);

    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: { classId: 10, status: 'Paid', refundStatus: 'None' },
    });
    expect(result).toEqual([
      expect.objectContaining({ id: 'payment-1', refundPercentage: 100 }),
      expect.objectContaining({ id: 'payment-2', refundPercentage: 100 }),
    ]);
  });

  describe('completePaymentRefund', () => {
    it('rejects an unknown payment', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.completePaymentRefund({ paymentId: 'missing', amountCents: 1 }),
      ).rejects.toMatchObject({ message: 'Payment not found' });
    });

    it('rejects a different Stripe refund', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({ refundAmountCents: 2500, stripeRefundId: 're_1' }),
      );

      await expect(
        service.completePaymentRefund({
          paymentId: 'payment-1',
          stripeRefundId: 're_2',
          amountCents: 2500,
        }),
      ).rejects.toMatchObject({
        message: 'Stripe refund does not match payment',
      });
    });

    it('marks the payment refunded and keeps the recorded refund id', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({ refundAmountCents: 2500, stripeRefundId: 're_1' }),
      );

      await service.completePaymentRefund({
        paymentId: 'payment-1',
        amountCents: 2500,
      });

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment-1' },
        data: {
          status: 'Refunded',
          refundStatus: 'Succeeded',
          stripeRefundId: 're_1',
          refundedAt: expect.any(Date) as unknown,
          refundError: null,
        },
      });
    });

    it('records the Stripe refund id on completion', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRecord({ refundAmountCents: 2500 }),
      );

      await service.completePaymentRefund({
        paymentId: 'payment-1',
        stripeRefundId: 're_1',
        amountCents: 2500,
      });

      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ stripeRefundId: 're_1' }) as unknown,
        }),
      );
    });
  });

  it('records a Stripe refund that is still processing', async () => {
    await service.recordPaymentRefund('payment-1', 're_1');

    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 'payment-1' },
      data: expect.objectContaining({ stripeRefundId: 're_1' }) as unknown,
    });
  });

  describe('refund retry bookkeeping', () => {
    it('marks a refund failed and truncates the error', async () => {
      await service.failPaymentRefund('payment-1', 'r'.repeat(600));

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment-1' },
        data: { refundStatus: 'Failed', refundError: 'r'.repeat(500) },
      });
    });

    it('lists pending and failed refunds, oldest first', async () => {
      await service.listRefundPendingPayments();

      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: { refundStatus: { in: ['Pending', 'Failed'] } },
        orderBy: { updatedAt: 'asc' },
        take: 100,
      });
    });

    it('lists the latest payments for admins', async () => {
      await service.getAllPayments();

      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 500,
      });
    });
  });

  describe('Stripe webhook events', () => {
    it('claims a new event and stores only known fields', async () => {
      prisma.stripeWebhookEvent.create.mockResolvedValue({ id: 'e1' });

      await expect(
        service.recordStripeWebhookEvent({
          stripeEventId: 'evt_1',
          eventType: 'checkout.session.completed',
          extra: 'ignored',
        } as never),
      ).resolves.toEqual({ claimed: true, event: { id: 'e1' } });
      expect(prisma.stripeWebhookEvent.create).toHaveBeenCalledWith({
        data: {
          stripeEventId: 'evt_1',
          eventType: 'checkout.session.completed',
        },
      });
    });

    it.each([
      ['Processed', false],
      ['Failed', true],
      ['Pending', true],
    ])('re-claims a duplicate %s event: %p', async (status, claimed) => {
      prisma.stripeWebhookEvent.create.mockRejectedValue({ code: 'P2002' });
      prisma.stripeWebhookEvent.findUnique.mockResolvedValue({ status });

      await expect(
        service.recordStripeWebhookEvent({
          stripeEventId: 'evt_1',
          eventType: 't',
        }),
      ).resolves.toEqual({ claimed, event: { status } });
    });

    it('rethrows unexpected database errors', async () => {
      prisma.stripeWebhookEvent.create.mockRejectedValue(new Error('db down'));

      await expect(
        service.recordStripeWebhookEvent({
          stripeEventId: 'evt_1',
          eventType: 't',
        }),
      ).rejects.toThrow('db down');
    });

    it('marks events processed or failed', async () => {
      await service.completeStripeWebhookEvent('evt_1');
      await service.failStripeWebhookEvent('evt_2', 'e'.repeat(700));

      expect(prisma.stripeWebhookEvent.update.mock.calls).toEqual([
        [
          {
            where: { stripeEventId: 'evt_1' },
            data: {
              status: 'Processed',
              processedAt: expect.any(Date) as unknown,
              error: null,
            },
          },
        ],
        [
          {
            where: { stripeEventId: 'evt_2' },
            data: { status: 'Failed', error: 'e'.repeat(500) },
          },
        ],
      ]);
    });
  });

  describe('cancelRegistration refunds', () => {
    const registered = {
      id: 1,
      classId: 10,
      userId: 'user-1',
      status: 'Registered',
    };
    const options = { capacity: 10, source: 'admin' };

    beforeEach(() => {
      prisma.registration.findUnique.mockResolvedValue(registered);
      prisma.registration.update.mockResolvedValue({
        ...registered,
        status: 'Canceled',
      });
      prisma.registration.count.mockResolvedValue(10);
    });

    it('queues the policy refund for the member payment', async () => {
      prisma.payment.findFirst.mockResolvedValue(
        paymentRecord({ status: 'Paid' }),
      );

      await expect(
        service.cancelRegistration(1, { ...options, refundPercentage: 50 }),
      ).resolves.toMatchObject({
        status: 'Canceled',
        refundPaymentId: 'payment-1',
      });
      expect(prisma.payment.findFirst).toHaveBeenCalledWith({
        where: {
          classId: 10,
          userId: 'user-1',
          status: 'Paid',
          refundStatus: 'None',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment-1' },
        data: expect.objectContaining({
          refundPercentage: 50,
          refundAmountCents: 1250,
          refundStatus: 'Pending',
        }) as unknown,
      });
    });

    it('records an ineligible zero-percent refund', async () => {
      prisma.payment.findFirst.mockResolvedValue(
        paymentRecord({ status: 'Paid' }),
      );

      await service.cancelRegistration(1, { ...options, refundPercentage: 0 });

      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            refundStatus: 'NotEligible',
          }) as unknown,
        }),
      );
    });

    it('cancels normally when the member has no refundable payment', async () => {
      prisma.payment.findFirst.mockResolvedValue(null);

      const result = await service.cancelRegistration(1, {
        ...options,
        refundPercentage: 100,
      });

      expect(result).not.toHaveProperty('refundPaymentId');
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('rejects an invalid refund percentage', async () => {
      await expect(
        service.cancelRegistration(1, { ...options, refundPercentage: 150 }),
      ).rejects.toMatchObject({
        message: 'Refund percentage must be an integer from 0 to 100',
      });
    });

    it('does not look for a payment without a refund percentage', async () => {
      await service.cancelRegistration(1, options);

      expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    });

    it('does not refund a waitlisted registration', async () => {
      prisma.registration.findUnique.mockResolvedValue({
        ...registered,
        status: 'Waitlisted',
      });

      await service.cancelRegistration(1, {
        ...options,
        refundPercentage: 100,
      });

      expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    });
  });
});
