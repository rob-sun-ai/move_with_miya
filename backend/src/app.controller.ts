import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AppService } from './app.service';
import { HealthService } from './health.service';
import { metricsRegistry } from './metrics';
import { ObservabilityService } from './observability.service';
import { AdminGuard } from './common/guards/admin.guard';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly healthService: HealthService,
    private readonly observability: ObservabilityService,
  ) {}

  @Get()
  health(): string {
    return this.appService.health();
  }

  @Get('health/live')
  live() {
    return this.healthService.live();
  }

  @Get('health/ready')
  async ready(@Res() response: Response) {
    const result = await this.healthService.ready();
    response.status(result.status === 'ok' ? 200 : 503).json(result);
  }

  @Get('metrics')
  async metrics(@Res() response: Response) {
    response
      .type(metricsRegistry.contentType)
      .send(await metricsRegistry.metrics());
  }

  @Get('admin/observability/summary')
  @UseGuards(AdminGuard)
  async observabilitySummary() {
    return this.observability.summary();
  }
}
