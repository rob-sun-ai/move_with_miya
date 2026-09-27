import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';
import { metricsRegistry } from './metrics';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}
  @Get('health/live') live() {
    return this.health.live();
  }
  @Get('health/ready') async ready(@Res() response: Response) {
    const result = await this.health.ready();
    response.status(result.status === 'ok' ? 200 : 503).json(result);
  }
  @Get('metrics') async metrics(@Res() response: Response) {
    response
      .type(metricsRegistry.contentType)
      .send(await metricsRegistry.metrics());
  }
}
