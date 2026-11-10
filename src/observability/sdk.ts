/**
 * OpenTelemetry SDK bootstrap (Node runtime only). Imported lazily from `src/instrumentation.ts`.
 * No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set. Exporters read OTEL_EXPORTER_OTLP_* (endpoint, headers, protocol,
 * timeout) from the environment themselves. Next.js emits the HTTP server spans once a tracer provider is registered;
 * our spans (capability.*) nest under them.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { envDetector } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace";
import { resolveTelemetryConfig, type TelemetryConfig } from "./config";
import type { Env } from "@/core/env";

export interface TelemetryHandle {
  config: TelemetryConfig;
  shutdown(): Promise<void>;
}

const NOOP: Pick<TelemetryHandle, "shutdown"> = { shutdown: async () => {} };
let started: TelemetryHandle | undefined;

export function startTelemetry(env: Parameters<typeof resolveTelemetryConfig>[0] & Partial<Pick<Env, "NODE_ENV">>): TelemetryHandle {
  if (started) return started;
  const config = resolveTelemetryConfig(env);
  if (!config.enabled) return (started = { config, ...NOOP });

  const sdk = new NodeSDK({
    serviceName: config.serviceName,
    // Only OTEL_RESOURCE_ATTRIBUTES: the default host/process detectors would export process.command_args, host id
    // and OS user, which can carry secrets/PII. Add deployment attributes via OTEL_RESOURCE_ATTRIBUTES instead.
    resourceDetectors: [envDetector],
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRatio) }),
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 })],
  });
  sdk.start();
  const handle: TelemetryHandle = { config, shutdown: () => sdk.shutdown() };
  // Flush on graceful termination so the last spans/metrics are not lost.
  process.once("SIGTERM", () => void handle.shutdown());
  return (started = handle);
}
