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

  function serviceWith(overrides: Record<string, jest.Mock> = {}) {
    return {
      consumeIp: jest.fn().mockResolvedValue(decision),
      consumeUser: jest.fn().mockResolvedValue(decision),
      consumeRefundIp: jest.fn().mockResolvedValue(decision),
      applyHeaders: jest.fn(),
      ...overrides,
    };
  }

  function guardFor(mocks: Record<string, jest.Mock>) {
    return new CheckoutRateLimitGuard(
      mocks as unknown as CheckoutRateLimitService,
    );
  }

  it('uses the refund bucket for refund routes and reports both scopes', async () => {
    const service = serviceWith();
    const guard = guardFor(service);
    const { context: executionContext, response } = context(
      '/checkout/payments/p1/refund',
    );

    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(service.consumeRefundIp).toHaveBeenCalledWith(
      '/checkout/payments/p1/refund',
      '198.51.100.1',
    );
    expect(service.consumeIp).not.toHaveBeenCalled();
    expect(service.applyHeaders).toHaveBeenCalledWith(response, decision, 'IP');
    expect(service.applyHeaders).toHaveBeenCalledWith(
      response,
      decision,
      'User',
    );
  });

  it('blocks when the member bucket is exhausted', async () => {
    const guard = guardFor(
      serviceWith({
        consumeUser: jest
          .fn()
          .mockResolvedValue({ ...decision, allowed: false }),
      }),
    );

    await expect(guard.canActivate(context().context)).rejects.toMatchObject({
      status: 429,
    });
  });

  it('fails closed when Redis is unavailable', async () => {
    const guard = guardFor(
      serviceWith({
        consumeIp: jest.fn().mockRejectedValue(new Error('Redis down')),
      }),
    );

    await expect(guard.canActivate(context().context)).rejects.toThrow(
      'Payment service is temporarily unavailable',
    );
  });

  it.each([
    [
      'the socket address',
      { ip: undefined, socket: { remoteAddress: '203.0.113.9' } },
      '203.0.113.9',
    ],
    [
      'unknown',
      { ip: undefined, socket: { remoteAddress: undefined } },
      'unknown',
    ],
  ])('falls back to %s for the client IP', async (_label, overrides, ip) => {
    const service = serviceWith();
    const guard = guardFor(service);
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          path: '',
          session: {},
          ...overrides,
        }),
        getResponse: () => ({ header: jest.fn() }),
      }),
    } as unknown as ExecutionContext;

    await guard.canActivate(executionContext);

    expect(service.consumeIp).toHaveBeenCalledWith('checkout', ip);
  });
});
