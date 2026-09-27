jest.mock('./prisma/prisma.service', () => ({ PrismaService: jest.fn() }));

import { metricsRegistry } from './metrics';
import { PaymentMetrics } from './payment-metrics';
import { MAX_REFUND_ATTEMPTS } from './registration.service';

describe('PaymentMetrics', () => {
  it('reports refunds needing attention and failed Stripe webhooks', async () => {
    const paymentCount = jest.fn().mockResolvedValue(2);
    const webhookCount = jest.fn().mockResolvedValue(1);
    new PaymentMetrics({
      client: {
        payment: { count: paymentCount },
        stripeWebhookEvent: { count: webhookCount },
      },
    } as never).onModuleInit();

    const metrics = await metricsRegistry.metrics();

    expect(metrics).toContain('move_with_miya_refunds_needing_attention 2');
    expect(metrics).toContain('move_with_miya_stripe_webhook_events_failed 1');
    expect(paymentCount).toHaveBeenCalledWith({
      where: {
        refundStatus: 'Failed',
        refundAttempts: { gte: MAX_REFUND_ATTEMPTS },
      },
    });
    expect(webhookCount).toHaveBeenCalledWith({
      where: expect.objectContaining({ status: 'Failed' }) as unknown,
    });
  });
});
