import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis.service';

const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('PTTL', KEYS[1]) }
`;

export interface CheckoutRateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

@Injectable()
export class CheckoutRateLimitService {
  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  consumeIp(route: string, ip: string): Promise<CheckoutRateLimitDecision> {
    return this.consume(
      'ip',
      `${route}:${ip || 'unknown'}`,
      this.getPositiveInteger('CHECKOUT_IP_ATTEMPT_LIMIT', 30),
      this.getPositiveInteger('CHECKOUT_IP_ATTEMPT_TTL_MS', 10 * 60 * 1000),
    );
  }

  consumeUser(
    route: string,
    userId: string,
  ): Promise<CheckoutRateLimitDecision> {
    return this.consume(
      'user',
      `${route}:${userId || 'anonymous'}`,
      this.getPositiveInteger('CHECKOUT_USER_ATTEMPT_LIMIT', 10),
      this.getPositiveInteger('CHECKOUT_USER_ATTEMPT_TTL_MS', 10 * 60 * 1000),
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
      this.getPositiveInteger('CHECKOUT_REFUND_ATTEMPT_TTL_MS', 10 * 60 * 1000),
    );
  }

  applyHeaders(
    response: { header(name: string, value: string): unknown },
    decision: CheckoutRateLimitDecision,
    scope: string,
  ): void {
    response.header(`X-RateLimit-${scope}-Limit`, String(decision.limit));
    response.header(
      `X-RateLimit-${scope}-Remaining`,
      String(decision.remaining),
    );
    response.header(
      `X-RateLimit-${scope}-Reset`,
      String(decision.resetSeconds),
    );
    if (!decision.allowed) {
      response.header('Retry-After', String(decision.resetSeconds));
    }
  }

  private async consume(
    scope: string,
    identifier: string,
    limit: number,
    ttlMs: number,
  ): Promise<CheckoutRateLimitDecision> {
    const window = Math.floor(Date.now() / ttlMs);
    const key = `${this.configService.get<string>(
      'CHECKOUT_RATE_LIMIT_PREFIX',
      'checkout-rate-limit',
    )}:${scope}:${this.hash(`${identifier}:${window}`)}`;
    const result = await this.redisService
      .getClient()
      .sendCommand(['EVAL', INCREMENT_SCRIPT, '1', key, String(ttlMs)]);
    const [countValue] = result as unknown as [
      string | number,
      string | number,
    ];
    const count = Number(countValue);
    const resetSeconds = Math.max(
      1,
      Math.ceil((ttlMs - (Date.now() % ttlMs)) / 1000),
    );
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetSeconds,
    };
  }

  private hash(value: string): string {
    const secret = this.configService.get<string>('SESSION_SECRET');
    if (!secret) throw new Error('Rate-limit secret is not configured');
    return createHmac('sha256', secret).update(value).digest('hex');
  }

  private getPositiveInteger(key: string, fallback: number): number {
    const value = Number(this.configService.get<string>(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
