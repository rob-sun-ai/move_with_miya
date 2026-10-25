import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis.service';
import {
  applyRateLimitHeaders,
  consumeFixedWindow,
  positiveIntegerSetting,
  type RateLimitDecision,
} from './fixed-window-rate-limit';

export type CheckoutRateLimitDecision = RateLimitDecision;

const WINDOW_MS = 60 * 1000;

@Injectable()
export class CheckoutRateLimitService {
  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  // One-minute windows: a client blocked by mistake (members of an
  // institution sharing one IP) recovers within a minute. Flood protection
  // is nginx's per-second limit; these cap Stripe calls and seat holds.

  consumeIp(route: string, ip: string): Promise<CheckoutRateLimitDecision> {
    return this.consume(
      'ip',
      `${route}:${ip || 'unknown'}`,
      this.getPositiveInteger('CHECKOUT_IP_ATTEMPT_LIMIT', 60),
      this.getPositiveInteger('CHECKOUT_IP_ATTEMPT_TTL_MS', WINDOW_MS),
    );
  }

  consumeUser(
    route: string,
    userId: string,
  ): Promise<CheckoutRateLimitDecision> {
    return this.consume(
      'user',
      `${route}:${userId || 'anonymous'}`,
      this.getPositiveInteger('CHECKOUT_USER_ATTEMPT_LIMIT', 5),
      this.getPositiveInteger('CHECKOUT_USER_ATTEMPT_TTL_MS', WINDOW_MS),
    );
  }

  consumeRefundIp(
    route: string,
    ip: string,
  ): Promise<CheckoutRateLimitDecision> {
    return this.consume(
      'refund-ip',
      `${route}:${ip || 'unknown'}`,
      this.getPositiveInteger('CHECKOUT_REFUND_ATTEMPT_LIMIT', 30),
      this.getPositiveInteger('CHECKOUT_REFUND_ATTEMPT_TTL_MS', WINDOW_MS),
    );
  }

  consumeRefundUser(
    route: string,
    userId: string,
  ): Promise<CheckoutRateLimitDecision> {
    return this.consume(
      'refund-user',
      `${route}:${userId || 'anonymous'}`,
      this.getPositiveInteger('CHECKOUT_REFUND_USER_ATTEMPT_LIMIT', 10),
      this.getPositiveInteger('CHECKOUT_REFUND_USER_ATTEMPT_TTL_MS', WINDOW_MS),
    );
  }

  consumeStatusIp(
    route: string,
    ip: string,
  ): Promise<CheckoutRateLimitDecision> {
    return this.consume(
      'status-ip',
      `${route}:${ip || 'unknown'}`,
      this.getPositiveInteger('CHECKOUT_STATUS_ATTEMPT_LIMIT', 300),
      this.getPositiveInteger('CHECKOUT_STATUS_ATTEMPT_TTL_MS', WINDOW_MS),
    );
  }

  consumeStatusUser(
    route: string,
    userId: string,
  ): Promise<CheckoutRateLimitDecision> {
    return this.consume(
      'status-user',
      `${route}:${userId || 'anonymous'}`,
      this.getPositiveInteger('CHECKOUT_STATUS_USER_ATTEMPT_LIMIT', 30),
      this.getPositiveInteger('CHECKOUT_STATUS_USER_ATTEMPT_TTL_MS', WINDOW_MS),
    );
  }

  applyHeaders(
    response: { header(name: string, value: string): unknown },
    decision: CheckoutRateLimitDecision,
    scope: string,
  ): void {
    applyRateLimitHeaders(response, decision, scope);
  }

  private consume(
    scope: string,
    identifier: string,
    limit: number,
    ttlMs: number,
  ): Promise<CheckoutRateLimitDecision> {
    const prefix = this.configService.get<string>(
      'CHECKOUT_RATE_LIMIT_PREFIX',
      'checkout-rate-limit',
    );
    return consumeFixedWindow(this.redisService.getClient(), {
      keyPrefix: `${prefix}:${scope}`,
      identifier,
      secret: this.configService.get<string>('SESSION_SECRET'),
      limit,
      ttlMs,
    });
  }

  private getPositiveInteger(key: string, fallback: number): number {
    return positiveIntegerSetting(this.configService, key, fallback);
  }
}
