import { connect } from 'amqplib';
import { HealthService } from './health.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

const connectMock = jest.mocked(connect);

describe('HealthService', () => {
  const ping = jest.fn();
  let values: Record<string, string | undefined>;

  function service() {
    return new HealthService(
      {
        get: jest.fn(
          (key: string, fallback?: string) => values[key] ?? fallback,
        ),
      } as never,
      { getClient: () => ({ ping }) } as never,
    );
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-27T12:00:00.000Z') });
    values = { RABBITMQ_URL: 'amqp://rabbit' };
    ping.mockReset().mockResolvedValue('PONG');
    connectMock.mockReset().mockResolvedValue({
      close: jest.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => jest.useRealTimers());

  it('reports liveness without touching dependencies', () => {
    expect(service().live()).toEqual({
      status: 'ok',
      service: 'backend',
      timestamp: '2026-09-27T12:00:00.000Z',
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it('names itself after OTEL_SERVICE_NAME', () => {
    values.OTEL_SERVICE_NAME = 'gateway';
    expect(service().live().service).toBe('gateway');
  });

  it('is ready when Redis and RabbitMQ respond', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    connectMock.mockResolvedValue({ close } as never);

    await expect(service().ready()).resolves.toEqual({
      status: 'ok',
      service: 'backend',
      timestamp: '2026-09-27T12:00:00.000Z',
      dependencies: { redis: 'ok', rabbitmq: 'ok' },
    });
    expect(connectMock).toHaveBeenCalledWith('amqp://rabbit');
    expect(close).toHaveBeenCalled();
  });

  it.each([
    [
      'Redis is down',
      () => ping.mockRejectedValue(new Error('down')),
      { redis: 'error', rabbitmq: 'ok' },
    ],
    [
      'RabbitMQ is down',
      () => connectMock.mockRejectedValue(new Error('down')),
      { redis: 'ok', rabbitmq: 'error' },
    ],
    [
      'RabbitMQ is not configured',
      () => (values.RABBITMQ_URL = undefined),
      { redis: 'ok', rabbitmq: 'error' },
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
    expect(ping).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    await health.ready();
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight check between concurrent probes', async () => {
    const health = service();

    const [first, second] = await Promise.all([health.ready(), health.ready()]);

    expect(first).toBe(second);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});
