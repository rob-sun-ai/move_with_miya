import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { RedisClient } from '../redis.service';

const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('PTTL', KEYS[1]) }
`;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export interface FixedWindowOptions {
  /** Redis key prefix, e.g. `contact-rate-limit:ip`. */
  keyPrefix: string;
  /** What is being limited; hashed so raw IPs and ids never reach Redis. */
  identifier: string;
  /** HMAC key for the identifier hash. */
  secret: string | undefined;
  limit: number;
  ttlMs: number;
}

/**
 * Counts one attempt against a fixed window, atomically in Redis. Throws when
 * Redis fails so callers can fail closed.
 */
export async function consumeFixedWindow(
  client: RedisClient,
  { keyPrefix, identifier, secret, limit, ttlMs }: FixedWindowOptions,
): Promise<RateLimitDecision> {
  if (!secret) throw new Error('Rate-limit secret is not configured');
  const window = Math.floor(Date.now() / ttlMs);
  const hash = createHmac('sha256', secret)
    .update(`${identifier}:${window}`)
    .digest('hex');
  const result = await client.sendCommand([
    'EVAL',
    INCREMENT_SCRIPT,
    '1',
    `${keyPrefix}:${hash}`,
    String(ttlMs),
  ]);
  const [countValue] = result as unknown as [string | number, string | number];
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

/** Sets `X-RateLimit-<scope>-*` headers, plus Retry-After when blocked. */
export function applyRateLimitHeaders(
  response: { header(name: string, value: string): unknown },
  decision: RateLimitDecision,
  scope: string,
): void {
  response.header(`X-RateLimit-${scope}-Limit`, String(decision.limit));
  response.header(`X-RateLimit-${scope}-Remaining`, String(decision.remaining));
  response.header(`X-RateLimit-${scope}-Reset`, String(decision.resetSeconds));
  if (!decision.allowed) {
    response.header('Retry-After', String(decision.resetSeconds));
  }
}

/** Reads a positive integer setting, falling back on anything else. */
export function positiveIntegerSetting(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const value = Number(config.get<string>(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
