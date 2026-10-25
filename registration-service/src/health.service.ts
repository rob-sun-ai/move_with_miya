import { Injectable } from '@nestjs/common';
import { connect } from 'amqplib';
import { PrismaService } from './prisma/prisma.service';

/** Upper bound for each dependency check, so a hung dependency fails fast. */
export const CHECK_TIMEOUT_MS = 2_000;

/** Rejects when `check` has not settled within `ms`. */
export async function withTimeout<T>(
  check: Promise<T>,
  ms = CHECK_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      check,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
    const [postgres, rabbitmq] = await Promise.all([
      this.postgres(),
      this.rabbitmq(),
    ]);
    const dependencies = { postgres, rabbitmq };
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
      await withTimeout(this.prisma.client.$queryRaw`SELECT 1`);
      return 'ok';
    } catch {
      return 'error';
    }
  }
  private async rabbitmq(): Promise<'ok' | 'error'> {
    const url = process.env.RABBITMQ_URL;
    if (!url) return 'error';
    const connecting = connect(url, { timeout: CHECK_TIMEOUT_MS });
    try {
      const connection = await withTimeout(connecting);
      await withTimeout(connection.close());
      return 'ok';
    } catch {
      // Close a connection that only opened after the check gave up on it.
      void connecting
        .then((connection) => connection.close())
        .catch(() => undefined);
      return 'error';
    }
  }
}
