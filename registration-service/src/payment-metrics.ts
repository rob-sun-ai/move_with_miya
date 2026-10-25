import { Injectable, OnModuleInit } from '@nestjs/common';
import { Gauge } from 'prom-client';
import { metricsRegistry } from './metrics';
import { PrismaService } from './prisma/prisma.service';
import { REFUND_NEEDS_ATTENTION_WHERE } from './registration.service';

/** Stripe stops retrying a webhook delivery after three days. */
const STRIPE_WEBHOOK_RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Payment health gauges, read from the database on each Prometheus scrape. */
@Injectable()
export class PaymentMetrics implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const { client } = this.prisma;
    new Gauge({
      name: 'move_with_miya_refunds_needing_attention',
      help: 'Refunds whose automatic retries are exhausted.',
      registers: [metricsRegistry],
      async collect() {
        this.set(
          await client.payment.count({ where: REFUND_NEEDS_ATTENTION_WHERE }),
        );
      },
    });
    new Gauge({
      name: 'move_with_miya_stripe_webhook_events_failed',
      help: 'Stripe webhook events from the retry window whose processing failed.',
      registers: [metricsRegistry],
      async collect() {
        this.set(
          await client.stripeWebhookEvent.count({
            where: {
              status: 'Failed',
              createdAt: {
                gte: new Date(Date.now() - STRIPE_WEBHOOK_RETRY_WINDOW_MS),
              },
            },
          }),
        );
      },
    });
  }
}
