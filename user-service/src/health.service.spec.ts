import { createServer } from 'node:net';
import { createClient } from 'redis';
import { HealthService } from './health.service';

jest.mock('redis', () => ({ createClient: jest.fn() }));
jest.mock('./prisma/prisma.service', () => ({ PrismaService: jest.fn() }));

const createClientMock = jest.mocked(createClient);

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('HealthService', () => {
  const queryRaw = jest.fn();
  let redis: {
    isOpen: boolean;
    on: jest.Mock;
    connect: jest.Mock;
    ping: jest.Mock;
    destroy: jest.Mock;
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
    values = { REDIS_URL: 'redis://redis:6379' };
    queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    redis = {
      isOpen: false,
      on: jest.fn(),
      connect: jest.fn(() => {
        redis.isOpen = true;
        return Promise.resolve();
      }),
      ping: jest.fn().mockResolvedValue('PONG'),
      destroy: jest.fn(() => {
        redis.isOpen = false;
      }),
    };
    createClientMock.mockReset().mockReturnValue(redis as never);
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

  it('is ready when Postgres and Redis respond', async () => {
    await expect(service().ready()).resolves.toEqual({
      status: 'ok',
      service: 'user-service',
      timestamp: '2026-09-27T12:00:00.000Z',
      dependencies: { postgres: 'ok', redis: 'ok' },
    });
    expect(createClientMock).toHaveBeenCalledWith({
      url: 'redis://redis:6379',
      socket: { connectTimeout: 2_000, reconnectStrategy: false },
    });
    expect(redis.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(redis.destroy).toHaveBeenCalled();
  });

  it('defaults to a local Redis', async () => {
    values.REDIS_URL = undefined;

    await service().ready();

    expect(createClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'redis://localhost:6379' }),
    );
  });

  it.each([
    [
      'Postgres is down',
      () => queryRaw.mockRejectedValue(new Error('down')),
      { postgres: 'error', redis: 'ok' },
    ],
    [
      'Redis refuses connections',
      () => redis.connect.mockRejectedValue(new Error('down')),
      { postgres: 'ok', redis: 'error' },
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
    expect(redis.destroy).toHaveBeenCalled();
  });

  it('does not close a Redis connection that never opened', async () => {
    redis.connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await service().ready();

    expect(redis.destroy).not.toHaveBeenCalled();
  });

  it('gives up on a Redis connect that hangs and drops the client', async () => {
    redis.connect.mockImplementation(() => {
      redis.isOpen = true;
      return new Promise(() => undefined);
    });

    const result = service().ready();
    await jest.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toMatchObject({
      dependencies: { redis: 'error' },
    });
    expect(redis.destroy).toHaveBeenCalled();
  });

  it('checks dependencies in parallel', async () => {
    queryRaw.mockReturnValue(new Promise(() => undefined));
    redis.ping.mockReturnValue(new Promise(() => undefined));

    const result = service().ready();
    await jest.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toMatchObject({
      dependencies: { postgres: 'error', redis: 'error' },
    });
  });

  it('recovers after Redis refused a real connection', async () => {
    jest.useRealTimers();
    const { createClient: realCreateClient } =
      jest.requireActual<typeof import('redis')>('redis');
    createClientMock.mockImplementation(realCreateClient);
    values.REDIS_URL = `redis://127.0.0.1:${await closedPort()}`;
    const health = service();

    // A refused connect used to leave the client open, so quitting it in the
    // cleanup never settled and every later probe shared the stuck check.
    await expect(health.ready()).resolves.toMatchObject({
      dependencies: { redis: 'error' },
    });
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
