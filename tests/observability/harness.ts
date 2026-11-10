/** In-memory OpenTelemetry providers for tests. Global providers can only be set once per test file (vitest isolates files). */
import { context, metrics, trace } from "@opentelemetry/api";
import { TracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

export function installTelemetry() {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const spans = new InMemorySpanExporter();
  const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] });
  trace.setGlobalTracerProvider(tracerProvider);

  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 });
  const meterProvider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(meterProvider);

  return {
    spans,
    /** Latest cumulative data points for a metric, flattened to `{attributes, value}`. */
    async points(name: string): Promise<{ attributes: Record<string, unknown>; value: unknown }[]> {
      await reader.forceFlush();
      const latest = new Map<string, { attributes: Record<string, unknown>; value: unknown }>();
      for (const rm of metricExporter.getMetrics()) {
        for (const sm of rm.scopeMetrics) {
          for (const m of sm.metrics) {
            if (m.descriptor.name !== name) continue;
            for (const dp of m.dataPoints) latest.set(JSON.stringify(dp.attributes), { attributes: dp.attributes, value: dp.value });
          }
        }
      }
      return [...latest.values()];
    },
    async shutdown() {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}
