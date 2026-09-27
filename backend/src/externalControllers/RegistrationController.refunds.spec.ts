import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import type { Request } from 'express';
import { RegistrationController } from './RegistrationController';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const HOUR = 3_600_000;

function startsIn(hours: number) {
  return new Date(NOW.getTime() + hours * HOUR).toISOString();
}

describe('RegistrationController refunds on cancellation', () => {
  let registrations: { send: jest.Mock };
  let classes: { send: jest.Mock };
  let stripe: { refundPayment: jest.Mock };
  let controller: RegistrationController;
  let warn: jest.SpyInstance;

  const member = { session: { userId: 'user-1' } } as unknown as Request;

  function withClass(cls: Record<string, unknown>) {
    classes.send.mockReturnValue(of({ id: 10, capacity: 5, ...cls }));
  }

  function lastPayload() {
    const calls = registrations.send.mock.calls as unknown[][];
    return calls[calls.length - 1][1] as Record<string, unknown>;
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    registrations = { send: jest.fn().mockReturnValue(of({ id: 1 })) };
    classes = { send: jest.fn() };
    stripe = { refundPayment: jest.fn().mockResolvedValue({}) };
    controller = new RegistrationController(
      registrations as never,
      classes as never,
      stripe as never,
    );
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('member refund percentage', () => {
    const policy = [
      { hoursBeforeStart: 72, percentage: 100 },
      { hoursBeforeStart: 24, percentage: 50 },
    ];

    it.each([
      ['well ahead of the class', 100, 100],
      ['exactly at the 72h threshold', 72, 100],
      ['inside the 72h tier', 48, 50],
      ['exactly at the 24h threshold', 24.5, 50],
    ])('pays the matching tier %s', async (_label, hours, percentage) => {
      withClass({
        startDate: startsIn(hours),
        cancellationCutoffHours: 12,
        refundPolicy: policy,
      });

      await controller.cancelMyRegistration(member, 10);

      expect(lastPayload()).toMatchObject({
        classId: 10,
        userId: 'user-1',
        source: 'member',
        cancellationCutoffHours: 12,
        refundPercentage: percentage,
      });
    });

    it('pays nothing when no tier applies before the cutoff', async () => {
      withClass({
        startDate: startsIn(20),
        cancellationCutoffHours: 12,
        refundPolicy: policy,
      });

      await controller.cancelMyRegistration(member, 10);

      expect(lastPayload()).toMatchObject({ refundPercentage: 0 });
    });

    it('leaves the refund undecided once the cutoff has passed', async () => {
      withClass({ startDate: startsIn(10), cancellationCutoffHours: 12 });

      await controller.cancelMyRegistration(member, 10);

      expect(lastPayload().refundPercentage).toBeUndefined();
    });

    it('defaults to a full refund until a 24-hour cutoff', async () => {
      withClass({ startDate: startsIn(30) });

      await controller.cancelMyRegistration(member, 10);

      expect(lastPayload()).toMatchObject({
        cancellationCutoffHours: 24,
        refundPercentage: 100,
      });
    });

    it('ignores malformed tiers', async () => {
      withClass({
        startDate: startsIn(100),
        refundPolicy: [
          { hoursBeforeStart: 96.5, percentage: 100 },
          { hoursBeforeStart: 48, percentage: 75.5 },
          { hoursBeforeStart: 36, percentage: 40 },
        ],
      });

      await controller.cancelMyRegistration(member, 10);

      expect(lastPayload()).toMatchObject({ refundPercentage: 40 });
    });
  });

  describe('issuing the refund', () => {
    beforeEach(() => withClass({ startDate: startsIn(100) }));

    it('refunds the payment the cancellation queued', async () => {
      registrations.send.mockReturnValue(
        of({ id: 1, refundPaymentId: 'payment-1' }),
      );

      await expect(
        controller.cancelMyRegistration(member, 10),
      ).resolves.toMatchObject({ refundPaymentId: 'payment-1' });
      expect(stripe.refundPayment).toHaveBeenCalledWith('payment-1');
    });

    it('does not call Stripe when nothing was paid', async () => {
      await controller.cancelMyRegistration(member, 10);

      expect(stripe.refundPayment).not.toHaveBeenCalled();
    });

    it.each([
      [new Error('card_declined'), 'card_declined'],
      ['timeout', 'timeout'],
    ])(
      'keeps the cancellation and logs Stripe failure %p for the retry sweep',
      async (error, detail) => {
        registrations.send.mockReturnValue(
          of({ id: 1, refundPaymentId: 'payment-12345678' }),
        );
        stripe.refundPayment.mockRejectedValue(error);

        await expect(
          controller.cancelMyRegistration(member, 10),
        ).resolves.toMatchObject({ id: 1 });
        expect(warn).toHaveBeenCalledWith(
          `Refund for payment payment- will be retried: ${detail}`,
        );
      },
    );

    it('works without Stripe configured', async () => {
      controller = new RegistrationController(
        registrations as never,
        classes as never,
      );
      registrations.send.mockReturnValue(
        of({ id: 1, refundPaymentId: 'payment-1' }),
      );

      await expect(
        controller.cancelMyRegistration(member, 10),
      ).resolves.toMatchObject({ refundPaymentId: 'payment-1' });
    });
  });

  describe('cancellation guards', () => {
    it('requires a signed-in member', async () => {
      await expect(
        controller.cancelMyRegistration(
          { session: {} } as unknown as Request,
          10,
        ),
      ).rejects.toThrow('Not authenticated');
    });

    it.each([
      ['does not exist', null],
      ['has no capacity', { id: 10, startDate: startsIn(100) }],
      ['has no start date', { id: 10, capacity: 5 }],
    ])('rejects a member cancellation for a class that %s', async (_l, cls) => {
      classes.send.mockReturnValue(of(cls));

      await expect(controller.cancelMyRegistration(member, 10)).rejects.toThrow(
        'Class 10 not found',
      );
      expect(registrations.send).not.toHaveBeenCalled();
    });

    it('rejects an admin cancellation for a missing class', async () => {
      registrations.send.mockReturnValue(of({ id: 1, classId: 10 }));
      classes.send.mockReturnValue(of(null));

      await expect(controller.cancelRegistration(1, {})).rejects.toThrow(
        'Class 10 not found',
      );
    });
  });

  describe('admin cancellation', () => {
    beforeEach(() => {
      withClass({ startDate: startsIn(100), cancellationCutoffHours: 6 });
      registrations.send.mockImplementation(({ cmd }: { cmd: string }) =>
        of(
          cmd === 'get_registration'
            ? { id: 1, classId: 10 }
            : { id: 1, refundPaymentId: 'payment-1' },
        ),
      );
    });

    it('refunds in full by default', async () => {
      await controller.cancelRegistration(1, { reason: '  ' });

      expect(lastPayload()).toEqual({
        id: 1,
        capacity: 5,
        classStartAt: startsIn(100),
        cancellationCutoffHours: 6,
        source: 'admin',
        reason: 'Admin cancellation',
        refundPercentage: 100,
      });
      expect(stripe.refundPayment).toHaveBeenCalledWith('payment-1');
    });

    it('uses the refund percentage the admin chose', async () => {
      await controller.cancelRegistration(1, {
        reason: ' Injury ',
        refundPercentage: 30,
      });

      expect(lastPayload()).toMatchObject({
        reason: 'Injury',
        refundPercentage: 30,
      });
    });

    it('refunds in full through the legacy delete route', async () => {
      await controller.cancelRegistrationLegacy(1);

      expect(lastPayload()).toMatchObject({ refundPercentage: 100 });
    });
  });
});
