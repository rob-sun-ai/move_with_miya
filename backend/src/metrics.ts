import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestsTotal = new Counter({
  name: 'move_with_miya_http_requests_total',
  help: 'Total HTTP requests handled by the service.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'move_with_miya_http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

export function recordHttpRequest(
  method: string,
  route: string,
  statusCode: number,
  durationMs: number,
): void {
  const labels = {
    method,
    route: route.replace(/\d+/g, ':id'),
    status_code: String(statusCode),
  };
  httpRequestsTotal.inc(labels);
  httpRequestDurationSeconds.observe(labels, durationMs / 1000);
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Propagates (or assigns) an X-Request-ID, records request metrics, and writes
 * one structured JSON log line per request.
 */
export function requestTelemetry(defaultService: string) {
  const service = process.env.OTEL_SERVICE_NAME ?? defaultService;
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = Date.now();
    const incomingRequestId = req.header('x-request-id');
    const requestId =
      incomingRequestId && REQUEST_ID_PATTERN.test(incomingRequestId)
        ? incomingRequestId
        : randomUUID();
    res.setHeader('X-Request-ID', requestId);
    res.on('finish', () => {
      const durationMs = Date.now() - started;
      const route = (req as { route?: { path?: unknown } }).route;
      recordHttpRequest(
        req.method,
        typeof route?.path === 'string' ? route.path : 'unmatched',
        res.statusCode,
        durationMs,
      );
      console.log(
        JSON.stringify({
          event: 'http_request',
          service,
          requestId,
          traceparent: req.header('traceparent') ?? null,
          method: req.method,
          route: req.path.replace(/\d+/g, ':id'),
          statusCode: res.statusCode,
          durationMs,
        }),
      );
    });
    next();
  };
}
