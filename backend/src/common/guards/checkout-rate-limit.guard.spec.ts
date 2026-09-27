import { ExecutionContext } from '@nestjs/common';
import { CheckoutRateLimitGuard } from './checkout-rate-limit.guard';
import { CheckoutRateLimitService } from '../checkout-rate-limit.service';

describe('CheckoutRateLimitGuard', () => {
  const decision = {
    allowed: true,
    limit: 10,
    remaining: 9,
    resetSeconds: 60,
  };

  function context(
    path = '/checkout/create-session',
    userId: string | null = 'user-1',
  ) {
    const request = {
      path,
      ip: '198.51.100.1',
      socket: { remoteAddress: undefined },
      session: userId === null ? {} : { userId },
    };
    const response = { header: jest.fn() };
    return {
      context: {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => response,
        }),
      } as unknown as ExecutionContext,
      response,
    };
  }

  it('checks both the IP and authenticated user buckets', async () => {
    const consumeIp = jest.fn().mockResolvedValue(decision);
    const consumeUser = jest.fn().mockResolvedValue(decision);
    const service = {
      consumeIp,
      consumeUser,
      consumeRefundIp: jest.fn().mockResolvedValue(decision),
      applyHeaders: jest.fn(),
    } as unknown as CheckoutRateLimitService;
    const guard = new CheckoutRateLimitGuard(service);
    const { context: executionContext } = context();

    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(consumeIp).toHaveBeenCalledWith(
      '/checkout/create-session',
      '198.51.100.1',
    );
    expect(consumeUser).toHaveBeenCalledWith(
      '/checkout/create-session',
      'user-1',
    );
  });

  it('blocks when either bucket is exhausted', async () => {
    const consumeIp = jest
      .fn()
      .mockResolvedValue({ ...decision, allowed: false });
    const service = {
      consumeIp,
      consumeUser: jest.fn().mockResolvedValue(decision),
      consumeRefundIp: jest.fn().mockResolvedValue(decision),
      applyHeaders: jest.fn(),
    } as unknown as CheckoutRateLimitService;
    const guard = new CheckoutRateLimitGuard(service);
    const { context: executionContext } = context();

    await expect(guard.canActivate(executionContext)).rejects.toThrow(
      'Too many payment requests',
    );
  });

  it('does not share an anonymous user bucket across clients', async () => {
    const consumeIp = jest.fn().mockResolvedValue(decision);
    const consumeUser = jest.fn().mockResolvedValue(decision);
    const service = {
      consumeIp,
      consumeUser,
      consumeRefundIp: jest.fn().mockResolvedValue(decision),
      applyHeaders: jest.fn(),
    } as unknown as CheckoutRateLimitService;
    const guard = new CheckoutRateLimitGuard(service);
    const { context: executionContext } = context(
      '/checkout/create-session',
      null,
    );

    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(consumeIp).toHaveBeenCalled();
    expect(consumeUser).not.toHaveBeenCalled();
  });
});
