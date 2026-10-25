import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthService,
  type HealthResult,
  withTimeout,
} from './health.service';

/** Bounds the local readiness check and each downstream probe. */
const SUMMARY_TIMEOUT_MS = 3_000;

interface ServiceStatus {
  status: 'ok' | 'error';
  responseTimeMs: number;
}

@Injectable()
export class ObservabilityService {
  constructor(
    private readonly config: ConfigService,
    private readonly health: HealthService,
  ) {}

  async summary() {
    const localHealth = this.localHealth();
    const urls = {
      'user-service': this.config.get<string>(
        'USER_HEALTH_URL',
        'http://localhost:3003/health/ready',
      ),
      'classes-service': this.config.get<string>(
        'CLASSES_HEALTH_URL',
        'http://localhost:3004/health/ready',
      ),
      'registration-service': this.config.get<string>(
        'REGISTRATION_HEALTH_URL',
        'http://localhost:3005/health/ready',
      ),
    };
    const services = Object.fromEntries(
      await Promise.all(
        Object.entries(urls).map(async ([name, url]) => [
          name,
          await this.checkHttp(url),
        ]),
      ),
    ) as Record<string, ServiceStatus>;

    const backend = await localHealth;

    let grafanaUrl: string | null = null;
    const configuredGrafanaUrl = this.config.get<string>('GRAFANA_PUBLIC_URL');
    if (configuredGrafanaUrl) {
      try {
        const parsed = new URL(configuredGrafanaUrl);
        if (parsed.protocol === 'https:') grafanaUrl = parsed.toString();
      } catch {
        grafanaUrl = null;
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      version: this.config.get<string>('RELEASE_VERSION', 'development'),
      services: {
        backend: {
          status: backend.status,
          responseTimeMs: 0,
          dependencies: backend.dependencies,
        },
        ...services,
      },
      grafanaUrl,
    };
  }

  private async localHealth(): Promise<
    Pick<HealthResult, 'status' | 'dependencies'>
  > {
    try {
      return await withTimeout(this.health.ready(), SUMMARY_TIMEOUT_MS);
    } catch {
      return { status: 'error' };
    }
  }

  private async checkHttp(url: string): Promise<ServiceStatus> {
    const started = Date.now();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      });
      return {
        status: response.ok ? 'ok' : 'error',
        responseTimeMs: Date.now() - started,
      };
    } catch {
      return { status: 'error', responseTimeMs: Date.now() - started };
    }
  }
}
