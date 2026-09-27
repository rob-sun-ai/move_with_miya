import { connect } from 'amqplib';
import { HealthService } from './health.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));
jest.mock('./prisma/prisma.service', () => ({ PrismaService: jest.fn() }));

const connectMock = jest.mocked(connect);
const SERVICE = 'registration-service';

describe('HealthService', () => {
  const queryRaw = jest.fn();
  const originalEnv = process.env;

  function service() {
    return new HealthService({ client: { $queryRaw: queryRaw } } as never);
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-27T12:00:00.000Z') });
    process.env = { ...originalEnv, RABBITMQ_URL: 'amqp://rabbit' };
    delete process.env.OTEL_SERVICE_NAME;
    queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    connectMock.mockReset().mockResolvedValue({
      close: jest.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
  });

  it('reports liveness without touching dependencies', () => {
    expect(service().live()).toEqual({
      status: 'ok',
      service: SERVICE,
      timestamp: '2026-09-27T12:00:00.000Z',
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('names itself after OTEL_SERVICE_NAME', async () => {
    process.env.OTEL_SERVICE_NAME = 'custom-name';

    expect(service().live().service).toBe('custom-name');
    await expect(service().ready()).resolves.toMatchObject({
      service: 'custom-name',
    });
  });

  it('is ready when Postgres and RabbitMQ respond', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    connectMock.mockResolvedValue({ close } as never);

    await expect(service().ready()).resolves.toEqual({
      status: 'ok',
      service: SERVICE,
      timestamp: '2026-09-27T12:00:00.000Z',
      dependencies: { postgres: 'ok', rabbitmq: 'ok' },
    });
    expect(connectMock).toHaveBeenCalledWith('amqp://rabbit');
    expect(close).toHaveBeenCalled();
  });

  it.each([
    [
      'Postgres is down',
      () => queryRaw.mockRejectedValue(new Error('down')),
      { postgres: 'error', rabbitmq: 'ok' },
    ],
    [
      'RabbitMQ is down',
      () => connectMock.mockRejectedValue(new Error('down')),
      { postgres: 'ok', rabbitmq: 'error' },
    ],
    [
      'RabbitMQ is not configured',
      () => delete process.env.RABBITMQ_URL,
      { postgres: 'ok', rabbitmq: 'error' },
    ],
  ])('is not ready when %s', async (_label, breakIt, dependencies) => {
    breakIt();

    await expect(service().ready()).resolves.toMatchObject({
      status: 'error',
      dependencies,
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
