import { HealthController } from './health.controller';

jest.mock('./health.service', () => ({ HealthService: jest.fn() }));

describe('HealthController', () => {
  const health = { live: jest.fn(), ready: jest.fn() };
  const controller = new HealthController(health as never);

  function response() {
    const res = {
      status: jest.fn(),
      json: jest.fn(),
      type: jest.fn(),
      send: jest.fn(),
    };
    res.status.mockReturnValue(res);
    res.type.mockReturnValue(res);
    return res;
  }

  it('reports liveness', () => {
    health.live.mockReturnValue({ status: 'ok' });
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it.each([
    ['ok', 200],
    ['error', 503],
  ])('answers readiness %s with HTTP %p', async (status, code) => {
    const res = response();
    health.ready.mockResolvedValue({ status });

    await controller.ready(res as never);

    expect(res.status).toHaveBeenCalledWith(code);
    expect(res.json).toHaveBeenCalledWith({ status });
  });

  it('serves Prometheus metrics', async () => {
    const res = response();

    await controller.metrics(res as never);

    expect(res.type).toHaveBeenCalledWith(
      expect.stringContaining('text/plain'),
    );
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining('move_with_miya_http_requests_total'),
    );
  });
});
