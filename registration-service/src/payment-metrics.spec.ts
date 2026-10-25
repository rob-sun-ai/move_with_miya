jest.mock('./prisma/prisma.service', () => ({ PrismaService: jest.fn() }));

import { metricsRegistry } from './metrics';
import { PaymentMetrics } from './payment-metrics';
import { MAX_REFUND_ATTEMPTS } from './registration.service';

const GAUGES = [
  'move_with_miya_refunds_needing_attention',
  'move_with_miya_stripe_webhook_events_failed',
];

describe('PaymentMetrics', () => {
  const paymentCount = jest.fn();
  const webhookCount = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-27T12:00:00.000Z') });
    paymentCount.mockReset().mockResolvedValue(0);
    webhookCount.mockReset().mockResolvedValue(0);
    new PaymentMetrics({
      client: {
        payment: { count: paymentCount },
        stripeWebhookEvent: { count: webhookCount },
      },
    } as never).onModuleInit();
  });

  afterEach(() => {
    GAUGES.forEach((name) => metricsRegistry.removeSingleMetric(name));
    jest.useRealTimers();
  });

  it('reports refunds needing attention and failed Stripe webhooks', async () => {
    paymentCount.mockResolvedValue(2);
    webhookCount.mockResolvedValue(1);

    const metrics = await metricsRegistry.metrics();

    expect(metrics).toContain('move_with_miya_refunds_needing_attention 2');
    expect(metrics).toContain('move_with_miya_stripe_webhook_events_failed 1');
  });

  it('reports zero when nothing needs attention', async () => {
    const metrics = await metricsRegistry.metrics();

    expect(metrics).toContain('move_with_miya_refunds_needing_attention 0');
    expect(metrics).toContain('move_with_miya_stripe_webhook_events_failed 0');
  });

  it('counts refunds whose automatic retries are exhausted', async () => {
    await metricsRegistry.metrics();

    expect(paymentCount).toHaveBeenCalledWith({
      where: {
        refundStatus: 'Failed',
        refundAttempts: { gte: MAX_REFUND_ATTEMPTS },
      },
    });
  });

  it('only counts webhook failures Stripe may still retry (three days)', async () => {
    await metricsRegistry.metrics();

    expect(webhookCount).toHaveBeenCalledWith({
      where: {
        status: 'Failed',
        createdAt: { gte: new Date('2026-09-24T12:00:00.000Z') },
      },
    });
  });

  it('reads fresh values on every scrape', async () => {
    paymentCount.mockResolvedValueOnce(3).mockResolvedValueOnce(0);

    expect(await metricsRegistry.metrics()).toContain(
      'move_with_miya_refunds_needing_attention 3',
    );
    expect(await metricsRegistry.metrics()).toContain(
      'move_with_miya_refunds_needing_attention 0',
    );
  });
});
