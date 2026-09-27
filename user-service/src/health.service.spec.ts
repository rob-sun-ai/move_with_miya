import { connect } from 'amqplib';
import { createClient } from 'redis';
import { HealthService } from './health.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));
jest.mock('redis', () => ({ createClient: jest.fn() }));
jest.mock('./prisma/prisma.service', () => ({ PrismaService: jest.fn() }));

const connectMock = jest.mocked(connect);
const createClientMock = jest.mocked(createClient);

describe('HealthService', () => {
  const queryRaw = jest.fn();
  let redis: {
    isOpen: boolean;
    connect: jest.Mock;
    ping: jest.Mock;
    quit: jest.Mock;
  };
  let values: Record<string, string | undefined>;

  function service() {
    return new HealthService(
      {
        get: jest.fn(
          (key: string, fallback?: string) => values[key] ?? fallback,
        ),
      } as never,
      { client: { $queryRaw: queryRaw } } as never,
    );
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-27T12:00:00.000Z') });
    values = { RABBITMQ_URL: 'amqp://rabbit', REDIS_URL: 'redis://redis:6379' };
    queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    redis = {
      isOpen: false,
      connect: jest.fn(() => {
        redis.isOpen = true;
        return Promise.resolve();
      }),
      ping: jest.fn().mockResolvedValue('PONG'),
      quit: jest.fn(() => {
        redis.isOpen = false;
        return Promise.resolve();
      }),
    };
    createClientMock.mockReset().mockReturnValue(redis as never);
    connectMock.mockReset().mockResolvedValue({
      close: jest.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => jest.useRealTimers());

  it('reports liveness without touching dependencies', () => {
    expect(service().live()).toEqual({
      status: 'ok',
      service: 'user-service',
      timestamp: '2026-09-27T12:00:00.000Z',
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('names itself after OTEL_SERVICE_NAME', () => {
    values.OTEL_SERVICE_NAME = 'users';
    expect(service().live().service).toBe('users');
  });

  it('is ready when Postgres, Redis, and RabbitMQ respond', async () => {
    await expect(service().ready()).resolves.toEqual({
      status: 'ok',
      service: 'user-service',
      timestamp: '2026-09-27T12:00:00.000Z',
      dependencies: { postgres: 'ok', redis: 'ok', rabbitmq: 'ok' },
    });
    expect(createClientMock).toHaveBeenCalledWith({
      url: 'redis://redis:6379',
    });
    expect(redis.quit).toHaveBeenCalled();
  });

  it('defaults to a local Redis', async () => {
    values.REDIS_URL = undefined;

    await service().ready();

    expect(createClientMock).toHaveBeenCalledWith({
      url: 'redis://localhost:6379',
    });
  });

  it.each([
    [
      'Postgres is down',
      () => queryRaw.mockRejectedValue(new Error('down')),
      { postgres: 'error' },
    ],
    [
      'Redis refuses connections',
      () => redis.connect.mockRejectedValue(new Error('down')),
      { redis: 'error' },
    ],
    [
      'RabbitMQ is down',
      () => connectMock.mockRejectedValue(new Error('down')),
      { rabbitmq: 'error' },
    ],
    [
      'RabbitMQ is not configured',
      () => (values.RABBITMQ_URL = undefined),
      { rabbitmq: 'error' },
    ],
  ])('is not ready when %s', async (_label, breakIt, dependencies) => {
    breakIt();

    await expect(service().ready()).resolves.toMatchObject({
      status: 'error',
      dependencies,
    });
  });

  it('closes a Redis connection that fails its ping', async () => {
    redis.ping.mockRejectedValue(new Error('LOADING'));

    await expect(service().ready()).resolves.toMatchObject({
      dependencies: { redis: 'error' },
    });
    expect(redis.quit).toHaveBeenCalled();
  });

  it('does not close a Redis connection that never opened', async () => {
    redis.connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await service().ready();

    expect(redis.quit).not.toHaveBeenCalled();
  });

  it('reuses a readiness result for five seconds', async () => {
    const health = service();

    await health.ready();
    jest.advanceTimersByTime(4_999);
    await health.ready();
    expect(queryRaw).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    await health.ready();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight check between concurrent probes', async () => {
    const health = service();

    const [first, second] = await Promise.all([health.ready(), health.ready()]);

    expect(first).toBe(second);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
