import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminGuard } from './common/guards/admin.guard';
import { ConfigService } from '@nestjs/config';
import { HealthService } from './health.service';
import { ObservabilityService } from './observability.service';

describe('AppController', () => {
  let appController: AppController;
  const health = { live: jest.fn(), ready: jest.fn() };
  const observability = { summary: jest.fn() };

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

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        AdminGuard,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: HealthService, useValue: health },
        { provide: ObservabilityService, useValue: observability },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "OK"', () => {
      expect(appController.health()).toBe('OK');
    });
  });

  it('reports liveness', () => {
    health.live.mockReturnValue({ status: 'ok' });
    expect(appController.live()).toEqual({ status: 'ok' });
  });

  it.each([
    ['ok', 200],
    ['error', 503],
  ])('answers readiness %s with HTTP %p', async (status, code) => {
    const res = response();
    health.ready.mockResolvedValue({ status });

    await appController.ready(res as never);

    expect(res.status).toHaveBeenCalledWith(code);
    expect(res.json).toHaveBeenCalledWith({ status });
  });

  it('serves Prometheus metrics', async () => {
    const res = response();

    await appController.metrics(res as never);

    expect(res.type).toHaveBeenCalledWith(
      expect.stringContaining('text/plain'),
    );
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining('move_with_miya_http_requests_total'),
    );
  });

  it('returns the admin observability summary', async () => {
    observability.summary.mockResolvedValue({ version: 'abc' });

    await expect(appController.observabilitySummary()).resolves.toEqual({
      version: 'abc',
    });
  });

  it('protects the observability summary with the admin guard', () => {
    const handler = Object.getOwnPropertyDescriptor(
      AppController.prototype,
      'observabilitySummary',
    )?.value as object;
    const guards = Reflect.getMetadata('__guards__', handler) as unknown[];
    expect(guards).toEqual([AdminGuard]);
  });
});
