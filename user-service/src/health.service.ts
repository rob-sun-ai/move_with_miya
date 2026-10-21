import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
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
    const [postgres, redis] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
    ]);
    const dependencies = { postgres, redis };
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
      await withTimeout(this.prisma.client.$queryRaw`SELECT 1`);
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private async checkRedis(): Promise<'ok' | 'error'> {
    // A probe must not retry: with the default reconnect strategy a failed
    // connect leaves the client open, and quitting it then never settles.
    const client = createClient({
      url: this.config.get<string>('REDIS_URL', 'redis://localhost:6379'),
      socket: { connectTimeout: CHECK_TIMEOUT_MS, reconnectStrategy: false },
    });
    // Failures surface through connect() and ping(); without a listener an
    // 'error' event would crash the process.
    client.on('error', () => undefined);
    try {
      await withTimeout(
        (async () => {
          await client.connect();
          await client.ping();
        })(),
      );
      return 'ok';
    } catch {
      return 'error';
    } finally {
      if (client.isOpen) client.destroy();
    }
  }
}
