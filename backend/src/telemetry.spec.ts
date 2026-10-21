import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

const start = jest.fn();
const shutdown = jest.fn().mockResolvedValue(undefined);

jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: jest.fn(() => ({ start, shutdown })),
}));
jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: jest.fn(() => ['auto-instrumentations']),
}));
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: jest.fn(),
}));
jest.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: jest.fn((attributes: unknown) => ({ attributes })),
}));

const DEFAULT_SERVICE = 'backend';

describe('telemetry', () => {
  const handlers = new Map<string | symbol, () => void>();
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    process.env = { ...originalEnv };
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_SERVICE_NAME;
    jest.spyOn(process, 'once').mockImplementation((event, handler) => {
      handlers.set(event, handler as () => void);
      return process;
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  /** Imports telemetry.ts fresh; it starts tracing as a side effect. */
  function load() {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./telemetry');
    });
  }

  it('stays off without an OTLP endpoint', () => {
    load();

    expect(NodeSDK).not.toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  });

  it('exports traces to the configured endpoint on import', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318/v1/traces';
    process.env.NODE_ENV = 'production';

    load();

    expect(OTLPTraceExporter).toHaveBeenCalledWith({
      url: 'http://collector:4318/v1/traces',
    });
    expect(resourceFromAttributes).toHaveBeenCalledWith({
      'service.name': DEFAULT_SERVICE,
      'deployment.environment.name': 'production',
    });
    expect(NodeSDK).toHaveBeenCalledWith(
      expect.objectContaining({
        instrumentations: [['auto-instrumentations']],
      }),
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('names the service and environment from the process environment', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318/v1/traces';
    process.env.OTEL_SERVICE_NAME = 'custom-name';
    delete process.env.NODE_ENV;

    load();

    expect(resourceFromAttributes).toHaveBeenCalledWith({
      'service.name': 'custom-name',
      'deployment.environment.name': 'development',
    });
  });

  it.each([
    ['http://collector:4318', 'http://collector:4318/v1/traces'],
    ['http://collector:4318/', 'http://collector:4318/v1/traces'],
    ['http://collector:4318/v1/traces', 'http://collector:4318/v1/traces'],
  ])('treats OTEL_EXPORTER_OTLP_ENDPOINT=%s as a base URL', (base, url) => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = base;

    load();

    expect(OTLPTraceExporter).toHaveBeenCalledWith({ url });
  });

  it('prefers the full OTEL_EXPORTER_OTLP_TRACES_ENDPOINT URL', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      'http://traces:9999/ingest';

    load();

    expect(OTLPTraceExporter).toHaveBeenCalledWith({
      url: 'http://traces:9999/ingest',
    });
  });

  it.each(['SIGTERM', 'SIGINT'])(
    'flushes traces and exits on %s',
    async (signal) => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
      const exit = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);

      load();
      handlers.get(signal)?.();

      expect(shutdown).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(exit).toHaveBeenCalledWith(0);
    },
  );

  it('exits even when flushing traces fails', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
    shutdown.mockRejectedValueOnce(new Error('collector down'));
    const logError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    load();
    handlers.get('SIGTERM')?.();

    await new Promise((resolve) => setImmediate(resolve));
    expect(logError).toHaveBeenCalledWith(
      'Trace flush failed',
      expect.any(Error),
    );
    expect(exit).toHaveBeenCalledWith(0);
  });
});
