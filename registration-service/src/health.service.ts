import { Injectable } from '@nestjs/common';
import { connect } from 'amqplib';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class HealthService {
  private readonly readinessCacheTtlMs = 5_000;
  private cachedReadiness?: {
    checkedAt: number;
    result: Awaited<ReturnType<HealthService['checkReadiness']>>;
  };
  private readinessCheck?: ReturnType<HealthService['checkReadiness']>;

  constructor(private readonly prisma: PrismaService) {}
  live() {
    return {
      status: 'ok',
      service: process.env.OTEL_SERVICE_NAME ?? 'registration-service',
      timestamp: new Date().toISOString(),
    };
  }
  async ready() {
    if (
      this.cachedReadiness &&
      Date.now() - this.cachedReadiness.checkedAt < this.readinessCacheTtlMs
    ) {
      return this.cachedReadiness.result;
    }
    if (this.readinessCheck) return this.readinessCheck;
    this.readinessCheck = this.checkReadiness();
    try {
      const result = await this.readinessCheck;
      this.cachedReadiness = { checkedAt: Date.now(), result };
      return result;
    } finally {
      this.readinessCheck = undefined;
    }
  }

  private async checkReadiness() {
    const dependencies = {
      postgres: await this.postgres(),
      rabbitmq: await this.rabbitmq(),
    };
    return {
      status: Object.values(dependencies).every((value) => value === 'ok')
        ? 'ok'
        : 'error',
      service: process.env.OTEL_SERVICE_NAME ?? 'registration-service',
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }
  private async postgres(): Promise<'ok' | 'error'> {
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
      return 'ok';
    } catch {
      return 'error';
    }
  }
  private async rabbitmq(): Promise<'ok' | 'error'> {
    const url = process.env.RABBITMQ_URL;
    if (!url) return 'error';
    try {
      const connection = await connect(url);
      await connection.close();
      return 'ok';
    } catch {
      return 'error';
    }
  }
}
