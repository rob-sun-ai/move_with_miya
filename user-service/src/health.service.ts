import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect } from 'amqplib';
import { createClient } from 'redis';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class HealthService {
  private readonly readinessCacheTtlMs = 5_000;
  private cachedReadiness?: {
    checkedAt: number;
    result: Awaited<ReturnType<HealthService['checkReadiness']>>;
  };
  private readinessCheck?: ReturnType<HealthService['checkReadiness']>;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  live() {
    return {
      status: 'ok',
      service: this.config.get<string>('OTEL_SERVICE_NAME', 'user-service'),
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
      postgres: await this.checkPostgres(),
      redis: await this.checkRedis(),
      rabbitmq: await this.checkRabbitMq(),
    };
    const ready = Object.values(dependencies).every((value) => value === 'ok');
    return {
      status: ready ? 'ok' : 'error',
      service: this.config.get<string>('OTEL_SERVICE_NAME', 'user-service'),
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }

  private async checkPostgres(): Promise<'ok' | 'error'> {
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private async checkRedis(): Promise<'ok' | 'error'> {
    const client = createClient({
      url: this.config.get<string>('REDIS_URL', 'redis://localhost:6379'),
    });
    try {
      await client.connect();
      await client.ping();
      return 'ok';
    } catch {
      return 'error';
    } finally {
      if (client.isOpen) await client.quit();
    }
  }

  private async checkRabbitMq(): Promise<'ok' | 'error'> {
    const url = this.config.get<string>('RABBITMQ_URL');
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
