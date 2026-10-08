import { baseLogger } from './logger.js';

/**
 * Optional OpenTelemetry tracing. Enabled when OTEL_EXPORTER_OTLP_ENDPOINT is set; traces for
 * inbound/outbound HTTP (incl. S3, webhooks, Cloudflare) and Redis are exported over OTLP/HTTP.
 * Must be started before the instrumented modules handle traffic.
 */
let shutdownFn: (() => Promise<void>) | null = null;

export async function startTelemetry(serviceName: string): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  try {
    const [{ NodeSDK }, { OTLPTraceExporter }, { HttpInstrumentation }, { IORedisInstrumentation }, { resourceFromAttributes }, sem] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/instrumentation-http'),
      import('@opentelemetry/instrumentation-ioredis'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ]);
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({ [sem.ATTR_SERVICE_NAME]: serviceName, [sem.ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '2.0.0' }),
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
      instrumentations: [
        new HttpInstrumentation({
          // Health probes and metrics scrapes are noise.
          ignoreIncomingRequestHook: (req) => Boolean(req.url?.startsWith('/health') || req.url === '/metrics'),
        }),
        new IORedisInstrumentation(),
      ],
    });
    sdk.start();
    shutdownFn = () => sdk.shutdown();
    baseLogger.info({ endpoint, service: serviceName }, 'OpenTelemetry tracing enabled');
  } catch (err) {
    baseLogger.error({ err }, 'failed to start OpenTelemetry');
  }
}

export async function stopTelemetry(): Promise<void> {
  if (shutdownFn) await shutdownFn().catch(() => undefined);
}
