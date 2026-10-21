import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const TRACES_PATH = '/v1/traces';

/**
 * Resolves the OTLP/HTTP traces URL the way the OpenTelemetry spec does:
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is the full URL, while
 * OTEL_EXPORTER_OTLP_ENDPOINT is a base URL that gets /v1/traces appended
 * (unless it already ends with it).
 */
export function tracesEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const tracesUrl = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (tracesUrl) return tracesUrl;
  const baseUrl = env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, '');
  if (!baseUrl) return undefined;
  return baseUrl.endsWith(TRACES_PATH) ? baseUrl : `${baseUrl}${TRACES_PATH}`;
}

export function startTelemetry(): void {
  const endpoint = tracesEndpoint();
  if (!endpoint) return;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]:
        process.env.OTEL_SERVICE_NAME ?? 'registration-service',
      'deployment.environment.name': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  // A signal listener replaces Node's default exit, so exit once traces flush.
  const flushAndExit = () =>
    void sdk
      .shutdown()
      .catch((error: unknown) => console.error('Trace flush failed', error))
      .finally(() => process.exit(0));
  process.once('SIGTERM', flushAndExit);
  process.once('SIGINT', flushAndExit);
}

startTelemetry();
