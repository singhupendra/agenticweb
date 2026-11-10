import type { Env } from "@/core/env";

export interface TelemetryConfig {
  enabled: boolean;
  serviceName: string;
  /** Head-sampling ratio (0..1), parent-based. */
  sampleRatio: number;
}

/**
 * Telemetry is OFF unless an OTLP endpoint is configured (and OTEL_SDK_DISABLED is not true).
 * Exporter URL, headers, protocol and timeouts are read by the OTel exporters themselves from the standard
 * OTEL_EXPORTER_OTLP_* variables; we never log or copy them (headers commonly carry credentials).
 */
export function resolveTelemetryConfig(env: Pick<Env, "OTEL_SDK_DISABLED" | "OTEL_SERVICE_NAME" | "OTEL_EXPORTER_OTLP_ENDPOINT" | "OTEL_TRACES_SAMPLER_ARG">): TelemetryConfig {
  return {
    enabled: !env.OTEL_SDK_DISABLED && Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT),
    serviceName: env.OTEL_SERVICE_NAME,
    sampleRatio: env.OTEL_TRACES_SAMPLER_ARG,
  };
}
