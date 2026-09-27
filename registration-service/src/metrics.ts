import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });
const requests = new Counter({
  name: 'move_with_miya_http_requests_total',
  help: 'Total HTTP requests handled by the service.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
});
const durations = new Histogram({
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
  requests.inc(labels);
  durations.observe(labels, durationMs / 1000);
}
