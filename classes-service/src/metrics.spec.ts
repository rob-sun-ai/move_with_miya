import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { Counter } from 'prom-client';
import {
  metricsRegistry,
  recordHttpRequest,
  requestTelemetry,
} from './metrics';

const DEFAULT_SERVICE = 'classes-service';

async function requestCount(labels: Record<string, string>) {
  const metric = metricsRegistry.getSingleMetric(
    'move_with_miya_http_requests_total',
  ) as Counter;
  const { values } = await metric.get();
  return (
    values.find(({ labels: actual }) =>
      Object.entries(labels).every(([key, value]) => actual[key] === value),
    )?.value ?? 0
  );
}

function exchange(
  options: {
    requestId?: string;
    traceparent?: string;
    route?: { path?: unknown };
    path?: string;
  } = {},
) {
  const headers: Record<string, string | undefined> = {
    'x-request-id': options.requestId,
    traceparent: options.traceparent,
  };
  const req = {
    method: 'GET',
    path: options.path ?? '/classes/12',
    route: options.route,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: jest.fn(),
  });
  const next = jest.fn();
  return { req, res, next };
}

function run(options: Parameters<typeof exchange>[0] = {}, service?: string) {
  const ctx = exchange(options);
  requestTelemetry(service ?? DEFAULT_SERVICE)(
    ctx.req,
    ctx.res as unknown as Response,
    ctx.next,
  );
  return ctx;
}

describe('metrics', () => {
  let log: jest.SpyInstance;

  function loggedLine() {
    const [[line]] = log.mock.calls as [string][];
    return JSON.parse(line) as Record<string, unknown>;
  }

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.OTEL_SERVICE_NAME;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('records requests with numeric path segments collapsed', async () => {
    recordHttpRequest('POST', '/record/12/items/3', 201, 150);

    await expect(
      requestCount({
        method: 'POST',
        route: '/record/:id/items/:id',
        status_code: '201',
      }),
    ).resolves.toBe(1);
    expect(await metricsRegistry.metrics()).toContain(
      'move_with_miya_http_request_duration_seconds_bucket{le="0.25",method="POST",route="/record/:id/items/:id",status_code="201"} 1',
    );
  });

  describe('requestTelemetry', () => {
    it('keeps a well-formed incoming request id', () => {
      const { res, next } = run({ requestId: 'abc-123._:x' });

      expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'abc-123._:x');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['missing', undefined],
      ['with unsafe characters', 'id<script>'],
      ['too long', 'a'.repeat(129)],
      ['empty', ''],
    ])('assigns a new request id when the incoming one is %s', (_l, id) => {
      const { res } = run({ requestId: id });

      expect(res.setHeader).toHaveBeenCalledWith(
        'X-Request-ID',
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      );
    });

    it('does not record anything until the response finishes', () => {
      run();

      expect(log).not.toHaveBeenCalled();
    });

    it('records the matched route and logs one JSON line when the response finishes', async () => {
      jest.useFakeTimers({ now: 1_000 });
      const { res } = run({
        requestId: 'req-1',
        traceparent: '00-abc-def-01',
        route: { path: '/telemetry/:id' },
        path: '/telemetry/42',
      });
      jest.setSystemTime(1_250);
      res.statusCode = 404;
      res.emit('finish');

      await expect(
        requestCount({ route: '/telemetry/:id', status_code: '404' }),
      ).resolves.toBe(1);
      expect(loggedLine()).toEqual({
        event: 'http_request',
        service: DEFAULT_SERVICE,
        requestId: 'req-1',
        traceparent: '00-abc-def-01',
        method: 'GET',
        route: '/telemetry/:id',
        statusCode: 404,
        durationMs: 250,
      });
    });

    it.each([
      ['no route matched', undefined],
      ['a non-string route', { path: /regex/ }],
    ])('labels requests with %s as unmatched', async (_label, route) => {
      const before = await requestCount({ route: 'unmatched' });
      const { res } = run({ route });
      res.emit('finish');

      await expect(requestCount({ route: 'unmatched' })).resolves.toBe(
        before + 1,
      );
      expect(loggedLine()).toMatchObject({
        traceparent: null,
      });
    });

    it('uses OTEL_SERVICE_NAME when it is set', () => {
      process.env.OTEL_SERVICE_NAME = 'custom-name';
      const { res } = run();
      res.emit('finish');

      expect(loggedLine()).toMatchObject({
        service: 'custom-name',
      });
    });
  });
});
