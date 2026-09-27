import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthService } from './health.service';

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
    const localHealth = await this.health.ready();
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
          status: localHealth.status,
          responseTimeMs: 0,
          dependencies: localHealth.dependencies,
        },
        ...services,
      },
      grafanaUrl,
    };
  }

  private async checkHttp(url: string): Promise<ServiceStatus> {
    const started = Date.now();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3000),
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
