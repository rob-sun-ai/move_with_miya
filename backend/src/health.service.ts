import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect } from 'amqplib';
import { RedisService } from './redis.service';

export interface HealthResult {
  status: 'ok' | 'error';
  service: string;
  timestamp: string;
  dependencies?: Record<string, 'ok' | 'error'>;
}

@Injectable()
export class HealthService {
  private readonly readinessCacheTtlMs = 5_000;
  private cachedReadiness?: { checkedAt: number; result: HealthResult };
  private readinessCheck?: Promise<HealthResult>;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  live(): HealthResult {
    return {
      status: 'ok',
      service: this.config.get<string>('OTEL_SERVICE_NAME', 'backend'),
      timestamp: new Date().toISOString(),
    };
  }

  async ready(): Promise<HealthResult> {
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

  private async checkReadiness(): Promise<HealthResult> {
    const [redis, rabbitmq] = await Promise.all([
      this.checkRedis(),
      this.checkRabbitMq(),
    ]);
    const dependencies = { redis, rabbitmq };
    const ready = Object.values(dependencies).every((value) => value === 'ok');
    return {
      status: ready ? 'ok' : 'error',
      service: this.config.get<string>('OTEL_SERVICE_NAME', 'backend'),
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }

  private async checkRedis(): Promise<'ok' | 'error'> {
    try {
      await this.redis.getClient().ping();
      return 'ok';
    } catch {
      return 'error';
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
