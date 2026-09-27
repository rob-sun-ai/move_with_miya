import { ConfigService } from '@nestjs/config';
import { CheckoutRateLimitService } from './checkout-rate-limit.service';
import { RedisService } from '../redis.service';

describe('CheckoutRateLimitService', () => {
  const sendCommand = jest.fn();
  const redis = {
    getClient: () => ({ sendCommand }),
  } as unknown as RedisService;
  const config = new ConfigService({
    SESSION_SECRET: 'test-secret',
    CHECKOUT_RATE_LIMIT_PREFIX: 'test-checkout',
    CHECKOUT_IP_ATTEMPT_LIMIT: '2',
    CHECKOUT_IP_ATTEMPT_TTL_MS: '60000',
    CHECKOUT_USER_ATTEMPT_LIMIT: '3',
    CHECKOUT_USER_ATTEMPT_TTL_MS: '60000',
  });

  beforeEach(() => {
    sendCommand.mockReset();
    sendCommand.mockResolvedValue(['1', '60000']);
  });

  it('uses an atomic Redis bucket for an IP and user', async () => {
    const service = new CheckoutRateLimitService(redis, config);
    const [ip, user] = await Promise.all([
      service.consumeIp('/checkout/create-session', '198.51.100.1'),
      service.consumeUser('/checkout/create-session', 'user-1'),
    ]);

    expect(ip).toMatchObject({ allowed: true, limit: 2, remaining: 1 });
    expect(user).toMatchObject({ allowed: true, limit: 3, remaining: 2 });
    expect(sendCommand).toHaveBeenCalledTimes(2);
    const firstCommand = sendCommand.mock.calls[0] as unknown[];
    expect(firstCommand[0] as unknown[]).toEqual(
      expect.arrayContaining(['EVAL', expect.any(String), '1']),
    );
  });

  it('fails closed when the Redis command fails', async () => {
    sendCommand.mockRejectedValue(new Error('Redis unavailable'));
    const service = new CheckoutRateLimitService(redis, config);

    await expect(
      service.consumeIp('/checkout/status', '198.51.100.1'),
    ).rejects.toThrow('Redis unavailable');
  });

  it('uses the refund limits for refund requests', async () => {
    const service = new CheckoutRateLimitService(
      redis,
      new ConfigService({
        SESSION_SECRET: 'test-secret',
        CHECKOUT_REFUND_ATTEMPT_LIMIT: '5',
        CHECKOUT_REFUND_ATTEMPT_TTL_MS: '30000',
      }),
    );

    await expect(
      service.consumeRefundIp('/checkout/payments/p/refund', ''),
    ).resolves.toMatchObject({ allowed: true, limit: 5, remaining: 4 });
    const [command] = sendCommand.mock.calls[0] as [string[]];
    expect(command[3]).toMatch(/^checkout-rate-limit:refund-ip:[0-9a-f]{64}$/);
    expect(command[4]).toBe('30000');
  });

  it('never stores the raw IP or user id in Redis keys', async () => {
    const service = new CheckoutRateLimitService(redis, config);
    await service.consumeIp('/checkout/status', '198.51.100.1');
    await service.consumeUser('/checkout/status', '');
    await service.consumeIp('/checkout/status', '');

    const keys = sendCommand.mock.calls.map(
      ([command]) => (command as string[])[3],
    );
    expect(keys[0]).toMatch(/^test-checkout:ip:[0-9a-f]{64}$/);
    expect(keys[1]).toMatch(/^test-checkout:user:[0-9a-f]{64}$/);
    expect(keys.join()).not.toContain('198.51.100.1');
  });

  it('starts a new bucket in the next window', async () => {
    const service = new CheckoutRateLimitService(redis, config);
    const now = jest.spyOn(Date, 'now').mockReturnValue(60_000 * 10);
    await service.consumeIp('/checkout/status', '198.51.100.1');
    now.mockReturnValue(60_000 * 11);
    await service.consumeIp('/checkout/status', '198.51.100.1');

    const [first, second] = sendCommand.mock.calls.map(
      ([command]) => (command as string[])[3],
    );
    expect(first).not.toBe(second);
    now.mockRestore();
  });

  it('blocks once the bucket is over its limit', async () => {
    sendCommand.mockResolvedValue([3, 1000]);
    const service = new CheckoutRateLimitService(redis, config);

    await expect(
      service.consumeIp('/checkout/create-session', '198.51.100.1'),
    ).resolves.toMatchObject({ allowed: false, limit: 2, remaining: 0 });
  });

  it('falls back to defaults for missing or invalid limits', async () => {
    const service = new CheckoutRateLimitService(
      redis,
      new ConfigService({
        SESSION_SECRET: 'test-secret',
        CHECKOUT_IP_ATTEMPT_LIMIT: '0',
        CHECKOUT_IP_ATTEMPT_TTL_MS: 'soon',
      }),
    );

    await expect(
      service.consumeIp('/checkout/create-session', '198.51.100.1'),
    ).resolves.toMatchObject({ limit: 30 });
    await expect(
      service.consumeUser('/checkout/create-session', 'user-1'),
    ).resolves.toMatchObject({ limit: 10 });
    expect((sendCommand.mock.calls[0] as [string[]])[0][4]).toBe('600000');
  });

  it('refuses to count attempts without a hashing secret', async () => {
    const service = new CheckoutRateLimitService(redis, new ConfigService({}));

    await expect(
      service.consumeIp('/checkout/status', '198.51.100.1'),
    ).rejects.toThrow('Rate-limit secret is not configured');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('reports limits in response headers and Retry-After when blocked', () => {
    const service = new CheckoutRateLimitService(redis, config);
    const response = { header: jest.fn() };

    service.applyHeaders(
      response,
      { allowed: true, limit: 10, remaining: 9, resetSeconds: 30 },
      'IP',
    );
    service.applyHeaders(
      response,
      { allowed: false, limit: 10, remaining: 0, resetSeconds: 12 },
      'User',
    );

    expect(response.header.mock.calls).toEqual([
      ['X-RateLimit-IP-Limit', '10'],
      ['X-RateLimit-IP-Remaining', '9'],
      ['X-RateLimit-IP-Reset', '30'],
      ['X-RateLimit-User-Limit', '10'],
      ['X-RateLimit-User-Remaining', '0'],
      ['X-RateLimit-User-Reset', '12'],
      ['Retry-After', '12'],
    ]);
  });
});
