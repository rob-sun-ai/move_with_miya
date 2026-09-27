import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import Stripe from 'stripe';

interface ClassRecord {
  id: number;
  name: string;
  cost: string | number;
  description?: string;
  capacity: number;
  startDate: string;
  endDate: string;
  status: string;
  isPrivate?: boolean;
  refundPolicy?: Array<{ hoursBeforeStart: number; percentage: number }>;
}

interface PaymentRecord {
  id: string;
  userId: string;
  classId: number;
  amountCents: number;
  currency: string;
  status: string;
  refundStatus: string;
  refundPercentage?: number | null;
  refundAmountCents?: number | null;
  stripeCheckoutSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  stripeRefundId?: string | null;
}

@Injectable()
export class StripeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe;
  private retryTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: ConfigService,
    @Inject('REGISTRATION_SERVICE') private readonly registrations: ClientProxy,
    @Inject('CLASSES_SERVICE') private readonly classes: ClientProxy,
  ) {
    this.stripe = new Stripe(
      this.config.get<string>('STRIPE_SECRET_KEY', 'sk_test_unconfigured'),
    );
  }

  onModuleInit() {
    if (this.config.get<string>('NODE_ENV') === 'production') {
      const secret = this.config.get<string>('STRIPE_SECRET_KEY');
      const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
      const publicAppUrl = this.config.get<string>('PUBLIC_APP_URL');
      const currency = this.config.get<string>('STRIPE_CURRENCY', 'usd');
      let parsedUrl: URL | undefined;
      try {
        parsedUrl = publicAppUrl ? new URL(publicAppUrl) : undefined;
      } catch {
        parsedUrl = undefined;
      }
      if (!secret)
        throw new Error('STRIPE_SECRET_KEY is required in production');
      if (!webhookSecret)
        throw new Error('STRIPE_WEBHOOK_SECRET is required in production');
      if (!parsedUrl || parsedUrl.protocol !== 'https:')
        throw new Error(
          'PUBLIC_APP_URL must be a valid HTTPS URL in production',
        );
      if (!/^[a-z]{3}$/.test(currency))
        throw new Error(
          'STRIPE_CURRENCY must be a three-letter lowercase code',
        );
    }
    this.retryTimer = setInterval(() => void this.retryRefunds(), 60_000);
  }

  onModuleDestroy() {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  private async rpc<T>(cmd: string, payload: object): Promise<T> {
    try {
      return await firstValueFrom(this.registrations.send<T>({ cmd }, payload));
    } catch (error) {
      const data = (error ?? {}) as { statusCode?: number; message?: string };
      const message = data.message ?? 'Payment service unavailable';
      if (data.statusCode === 400) throw new BadRequestException(message);
      if (data.statusCode === 404) throw new NotFoundException(message);
      if (data.statusCode === 409) throw new ConflictException(message);
      if (data.statusCode === 403) throw new ForbiddenException(message);
      throw new ServiceUnavailableException(message);
    }
  }

  private rpcClasses<T>(cmd: string, payload: object): Promise<T> {
    return firstValueFrom(this.classes.send<T>({ cmd }, payload));
  }

  private async getClass(classId: number) {
    try {
      return await this.rpcClasses<ClassRecord | null>('get_class', {
        id: classId,
      });
    } catch {
      throw new ServiceUnavailableException('Class service unavailable');
    }
  }

  private async assertUser(userId: string) {
    const userServiceUrl =
      this.config.get<string>('USER_SERVICE_URL') || 'http://localhost:3003';
    let response: Response;
    try {
      response = await fetch(
        `${userServiceUrl}/users/${encodeURIComponent(userId)}`,
        { signal: AbortSignal.timeout(5000) },
      );
    } catch {
      throw new ServiceUnavailableException('User service unreachable');
    }
    if (response.status >= 500) {
      throw new ServiceUnavailableException('User service error');
    }
    if (!response.ok) throw new ForbiddenException('Unable to verify user');
    const user = (await response.json()) as {
      banned?: boolean;
      yogaExperience?: string | null;
    };
    if (user.banned) throw new ForbiddenException('User is banned');
    return user;
  }

  private amountToCents(value: string | number) {
    const raw = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
      throw new ConflictException('Class price has invalid precision');
    }
    const [whole, fraction = ''] = raw.split('.');
    const amountCents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
      throw new ConflictException('Class price is invalid');
    }
    return amountCents;
  }

  private appUrl() {
    const value = this.config.get<string>('PUBLIC_APP_URL');
    if (!value)
      throw new ServiceUnavailableException('Payment URL is not configured');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ServiceUnavailableException('Payment URL is invalid');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new ServiceUnavailableException('Payment URL is invalid');
    }
    return url.toString().replace(/\/$/, '');
  }

  async createCheckoutSession(userId: string, classId: number) {
    const [cls, user] = await Promise.all([
      this.getClass(classId),
      this.assertUser(userId),
    ]);
    if (!cls) throw new NotFoundException(`Class ${classId} not found`);
    if (cls.status === 'Canceled' || cls.status === 'Completed') {
      throw new ForbiddenException('This class is not open for registration');
    }
    if (new Date(cls.endDate).getTime() <= Date.now()) {
      throw new ForbiddenException('This class has already ended');
    }
    if (cls.isPrivate && !user.yogaExperience?.trim()) {
      throw new ForbiddenException(
        'Yoga experience is required for this class',
      );
    }
    const amountCents = this.amountToCents(cls.cost);
    if (amountCents <= 0) {
      throw new ConflictException(
        'Free classes use the free registration flow',
      );
    }
    const currency = this.config
      .get<string>('STRIPE_CURRENCY', 'usd')
      .toLowerCase();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    let payment = await this.rpc<PaymentRecord>(
      'create_or_get_pending_payment',
      {
        userId,
        classId,
        capacity: cls.capacity,
        amountCents,
        currency,
        expiresAt: expiresAt.toISOString(),
      },
    );
    if (payment.status === 'Paid') {
      throw new ConflictException('Already registered for this class');
    }

    if (payment.stripeCheckoutSessionId) {
      const existing = await this.stripe.checkout.sessions.retrieve(
        payment.stripeCheckoutSessionId,
      );
      if (existing.status === 'open' && existing.url) {
        return { url: existing.url, paymentId: payment.id };
      }

      // A completed Checkout Session may still be waiting for its webhook to
      // reach us. Never expire it and create another session: that can charge
      // the customer twice before the duplicate is eventually refunded.
      if (
        existing.status === 'complete' ||
        existing.payment_status === 'paid'
      ) {
        if (existing.payment_status === 'paid') {
          await this.handleCheckoutSuccess(existing);
        }
        throw new ConflictException(
          'Payment is already being processed; check your dashboard',
        );
      }

      if (existing.status !== 'expired') {
        throw new ConflictException(
          'Payment is already being processed; check your dashboard',
        );
      }

      await this.rpc('mark_payment_expired', { id: payment.id });
      payment = await this.rpc<PaymentRecord>('create_or_get_pending_payment', {
        userId,
        classId,
        capacity: cls.capacity,
        amountCents,
        currency,
        expiresAt: expiresAt.toISOString(),
      });
    }

    const idempotencyKey = `checkout:${userId}:${classId}:${payment.id}`;
    try {
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          client_reference_id: payment.id,
          metadata: {
            paymentId: payment.id,
            classId: String(classId),
            userId,
          },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency,
                unit_amount: amountCents,
                product_data: {
                  name: cls.name,
                  description: cls.description?.slice(0, 500),
                },
              },
            },
          ],
          success_url: `${this.appUrl()}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${this.appUrl()}/checkout/cancel?class_id=${classId}`,
          expires_at: Math.floor(expiresAt.getTime() / 1000),
        },
        { idempotencyKey },
      );
      if (!session.url) throw new Error('Stripe did not return a Checkout URL');
      await this.rpc('attach_checkout_session', {
        paymentId: payment.id,
        stripeCheckoutSessionId: session.id,
      });
      return { url: session.url, paymentId: payment.id };
    } catch (error) {
      await this.rpc('mark_payment_failed', {
        id: payment.id,
        error:
          error instanceof Error ? error.message : 'Checkout creation failed',
      }).catch(() => undefined);
      throw new ServiceUnavailableException('Unable to start Stripe Checkout');
    }
  }

  async statusForUser(sessionId: string, userId: string) {
    if (!sessionId || sessionId.length > 200) {
      throw new NotFoundException('Payment not found');
    }
    return this.rpc('get_payment_status_for_user', {
      stripeCheckoutSessionId: sessionId,
      userId,
    });
  }

  async handleWebhook(event: Stripe.Event) {
    const claim = await this.rpc<{ claimed: boolean }>(
      'record_stripe_webhook_event',
      {
        stripeEventId: event.id,
        eventType: event.type,
      },
    );
    if (!claim.claimed) return;

    try {
      if (
        event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded'
      ) {
        await this.handleCheckoutSuccess(event.data.object);
      } else if (event.type === 'checkout.session.async_payment_failed') {
        const session = event.data.object;
        const paymentId =
          session.metadata?.paymentId ?? session.client_reference_id;
        if (paymentId) await this.rpc('mark_payment_failed', { id: paymentId });
      } else if (event.type === 'checkout.session.expired') {
        const session = event.data.object;
        const paymentId =
          session.metadata?.paymentId ?? session.client_reference_id;
        if (paymentId)
          await this.rpc('mark_payment_expired', { id: paymentId });
      } else if (
        event.type === 'refund.updated' ||
        event.type === 'charge.refunded'
      ) {
        await this.handleRefundEvent(event.data.object);
      } else if (event.type === 'refund.failed') {
        const refund = event.data.object;
        const paymentIntentId = this.getStripeObjectId(refund.payment_intent);
        const payment = paymentIntentId
          ? await this.rpc<PaymentRecord | null>(
              'get_payment_by_payment_intent',
              { paymentIntentId },
            )
          : null;
        if (payment)
          await this.rpc('fail_payment_refund', {
            paymentId: payment.id,
            error: 'Stripe reported a failed refund',
          });
      }
      await this.rpc('complete_stripe_webhook_event', {
        stripeEventId: event.id,
      });
    } catch (error) {
      await this.rpc('fail_stripe_webhook_event', {
        stripeEventId: event.id,
        error:
          error instanceof Error ? error.message : 'Webhook processing failed',
      }).catch(() => undefined);
      throw error;
    }
  }

  private async handleCheckoutSuccess(session: Stripe.Checkout.Session) {
    if (session.payment_status !== 'paid') return;
    const metadata = session.metadata ?? {};
    const paymentId = metadata.paymentId ?? session.client_reference_id;
    const classId = Number(metadata.classId);
    const userId = metadata.userId;
    const amountCents = session.amount_total;
    const currency = session.currency?.toLowerCase();
    if (
      !paymentId ||
      !userId ||
      !Number.isInteger(classId) ||
      !amountCents ||
      !currency
    ) {
      throw new ConflictException('Stripe Checkout metadata is invalid');
    }
    const payment = await this.rpc<PaymentRecord | null>('get_payment_by_id', {
      id: paymentId,
    });
    if (!payment || payment.userId !== userId || payment.classId !== classId) {
      throw new ConflictException('Stripe payment ownership is invalid');
    }
    if (payment.stripeCheckoutSessionId !== session.id) {
      throw new ConflictException(
        'Stripe Checkout session does not match payment',
      );
    }
    const cls = await this.getClass(classId);
    if (!cls) throw new NotFoundException(`Class ${classId} not found`);
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : null;
    const result = await this.rpc<{
      payment: PaymentRecord;
      needsRefund: boolean;
    }>('finalize_paid_registration', {
      paymentId,
      checkoutSessionId: session.id,
      paymentIntentId,
      amountCents,
      currency,
      capacity: cls.capacity,
      classStatus: cls.status,
      classEndAt: cls.endDate,
    });
    if (result.needsRefund) await this.refundPayment(result.payment.id, 100);
  }

  private async handleRefundEvent(object: Stripe.Refund | Stripe.Charge) {
    const paymentIntent =
      'payment_intent' in object ? object.payment_intent : null;
    const paymentIntentId = this.getStripeObjectId(paymentIntent);
    if (!paymentIntentId) return;
    const payment = await this.rpc<PaymentRecord | null>(
      'get_payment_by_payment_intent',
      { paymentIntentId },
    );
    if (!payment) return;
    if (
      'status' in object &&
      (object.status === 'failed' || object.status === 'canceled')
    ) {
      await this.rpc('fail_payment_refund', {
        paymentId: payment.id,
        error: `Stripe reported a ${object.status} refund`,
      });
      return;
    }
    if ('status' in object && object.status !== 'succeeded') return;
    if ('refunded' in object && !object.refunded) return;
    const expectedAmount = payment.refundAmountCents;
    const actualAmount =
      object.object === 'charge' ? object.amount_refunded : object.amount;
    if (
      !expectedAmount ||
      !Number.isInteger(actualAmount) ||
      actualAmount !== expectedAmount
    ) {
      await this.rpc('fail_payment_refund', {
        paymentId: payment.id,
        error: 'Stripe refund amount did not match the requested amount',
      });
      return;
    }
    const stripeRefundId = 'id' in object ? object.id : undefined;
    if (
      payment.stripeRefundId &&
      stripeRefundId &&
      payment.stripeRefundId !== stripeRefundId
    ) {
      await this.rpc('fail_payment_refund', {
        paymentId: payment.id,
        error: 'Stripe refund identity did not match the requested refund',
      });
      return;
    }
    await this.rpc('complete_payment_refund', {
      paymentId: payment.id,
      stripeRefundId,
      amountCents: expectedAmount,
    });
  }

  private getStripeObjectId(
    value: string | { id: string } | null | undefined,
  ): string | null {
    if (!value) return null;
    return typeof value === 'string' ? value : value.id;
  }

  async refundPayment(paymentId: string, overridePercentage?: number) {
    let payment = await this.rpc<PaymentRecord | null>('get_payment_by_id', {
      id: paymentId,
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (overridePercentage !== undefined || payment.refundStatus === 'None') {
      payment = await this.rpc<PaymentRecord>('begin_payment_refund', {
        paymentId,
        percentage: overridePercentage ?? 100,
      });
    }
    if (
      payment.refundStatus === 'NotEligible' ||
      payment.refundStatus === 'Succeeded'
    ) {
      return payment;
    }
    if (!payment.stripePaymentIntentId || !payment.refundAmountCents) {
      throw new ConflictException('Payment cannot be refunded yet');
    }
    try {
      const refund = await this.stripe.refunds.create(
        {
          payment_intent: payment.stripePaymentIntentId,
          amount: payment.refundAmountCents,
          reason: 'requested_by_customer',
          metadata: { paymentId },
        },
        { idempotencyKey: `refund:${paymentId}` },
      );
      if (refund.amount !== payment.refundAmountCents) {
        await this.rpc('fail_payment_refund', {
          paymentId,
          error: 'Stripe refund amount did not match the requested amount',
        });
        throw new ConflictException('Stripe refund amount did not match');
      }
      if (refund.status === 'succeeded') {
        return this.rpc('complete_payment_refund', {
          paymentId,
          stripeRefundId: refund.id,
          amountCents: payment.refundAmountCents,
        });
      }
      if (refund.status === 'pending') {
        return this.rpc('record_payment_refund', {
          paymentId,
          stripeRefundId: refund.id,
        });
      }
      await this.rpc('fail_payment_refund', {
        paymentId,
        error: `Stripe refund status: ${refund.status}`,
      });
      throw new ServiceUnavailableException('Stripe refund did not succeed');
    } catch (error) {
      await this.rpc('fail_payment_refund', {
        paymentId,
        error: error instanceof Error ? error.message : 'Refund failed',
      }).catch(() => undefined);
      throw new ServiceUnavailableException('Unable to issue Stripe refund');
    }
  }

  async refundClassPayments(classId: number) {
    const payments = await this.rpc<PaymentRecord[]>('begin_class_refunds', {
      classId,
    });
    const results: unknown[] = [];
    for (const payment of payments) {
      try {
        results.push(await this.refundPayment(payment.id));
      } catch (error) {
        this.logger.error(
          `Refund attempt failed for payment ${payment.id.slice(0, 8)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
    return results;
  }

  async retryRefunds() {
    try {
      const payments = await this.rpc<PaymentRecord[]>(
        'list_refund_pending_payments',
        {},
      );
      for (const payment of payments) {
        await this.refundPayment(payment.id).catch(() => undefined);
      }
    } catch {
      this.logger.warn('Refund retry sweep failed');
    }
  }

  getAllPayments() {
    return this.rpc<PaymentRecord[]>('get_all_payments', {});
  }
}
