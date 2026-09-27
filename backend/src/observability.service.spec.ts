import { ObservabilityService } from './observability.service';

function href(input: string | URL | Request) {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

describe('ObservabilityService', () => {
  let values: Record<string, string | undefined>;
  const ready = jest.fn();

  function service() {
    return new ObservabilityService(
      {
        get: jest.fn(
          (key: string, fallback?: string) => values[key] ?? fallback,
        ),
      } as never,
      { ready } as never,
    );
  }

  beforeEach(() => {
    values = {};
    ready.mockResolvedValue({
      status: 'ok',
      dependencies: { redis: 'ok', rabbitmq: 'ok' },
    });
    jest.useFakeTimers({ now: new Date('2026-09-27T12:00:00.000Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('summarizes the gateway and every downstream service', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation((url) =>
      Promise.resolve(
        new Response('{}', {
          status: href(url).includes('3004') ? 503 : 200,
        }),
      ),
    );

    await expect(service().summary()).resolves.toEqual({
      generatedAt: '2026-09-27T12:00:00.000Z',
      version: 'development',
      grafanaUrl: null,
      services: {
        backend: {
          status: 'ok',
          responseTimeMs: 0,
          dependencies: { redis: 'ok', rabbitmq: 'ok' },
        },
        'user-service': { status: 'ok', responseTimeMs: 0 },
        'classes-service': { status: 'error', responseTimeMs: 0 },
        'registration-service': { status: 'ok', responseTimeMs: 0 },
      },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:3003/health/ready',
      'http://localhost:3004/health/ready',
      'http://localhost:3005/health/ready',
    ]);
    expect(fetchMock.mock.calls[0][1]).toEqual({
      signal: expect.any(AbortSignal) as unknown,
    });
  });

  it('uses configured health URLs and release version', async () => {
    values = {
      USER_HEALTH_URL: 'http://user-service:3001/health/ready',
      CLASSES_HEALTH_URL: 'http://classes-service:3004/health/ready',
      REGISTRATION_HEALTH_URL: 'http://registration-service:3005/health/ready',
      RELEASE_VERSION: 'abc123',
    };
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}'));

    const summary = await service().summary();

    expect(summary.version).toBe('abc123');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      values.USER_HEALTH_URL,
      values.CLASSES_HEALTH_URL,
      values.REGISTRATION_HEALTH_URL,
    ]);
  });

  it('reports an unreachable service with its response time', async () => {
    jest.spyOn(global, 'fetch').mockImplementation((url) => {
      if (!href(url).includes('3003')) {
        return Promise.resolve(new Response('{}'));
      }
      jest.advanceTimersByTime(3_000);
      return Promise.reject(new Error('timeout'));
    });

    const summary = await service().summary();

    expect(summary.services['user-service']).toEqual({
      status: 'error',
      responseTimeMs: 3_000,
    });
  });

  it.each([
    ['https://grafana.studio.test/d/abc', 'https://grafana.studio.test/d/abc'],
    ['http://grafana.studio.test', null],
    ['not a url', null],
    ['', null],
  ])('links Grafana %p only over HTTPS', async (url, expected) => {
    values.GRAFANA_PUBLIC_URL = url;
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));

    await expect(service().summary()).resolves.toMatchObject({
      grafanaUrl: expected,
    });
  });
});
