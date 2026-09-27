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
});
