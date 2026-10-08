/**
 * Preload for OpenTelemetry: `node --import ./dist/otel.js dist/server.js`.
 * ESM modules can only be instrumented when the loader hook is registered before they are
 * imported, so tracing is started here rather than in main(). No-op without
 * OTEL_EXPORTER_OTLP_ENDPOINT.
 */
import { register } from 'node:module';
import { startTelemetry } from './lib/telemetry.js';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  await startTelemetry(process.env.SERVICE_NAME ?? 'cdn-api');
}
