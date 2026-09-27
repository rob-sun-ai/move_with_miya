import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminGuard } from './common/guards/admin.guard';
import { ConfigService } from '@nestjs/config';
import { HealthService } from './health.service';
import { ObservabilityService } from './observability.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        AdminGuard,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: HealthService, useValue: {} },
        { provide: ObservabilityService, useValue: {} },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "OK"', () => {
      expect(appController.health()).toBe('OK');
    });
  });
});
