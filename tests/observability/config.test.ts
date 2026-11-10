import { describe, expect, it } from "vitest";
import { loadEnv } from "@/core/env";
import { resolveTelemetryConfig } from "@/observability";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };
describe("telemetry config", () => {
  it("is a no-op by default (no endpoint)", () => {
    expect(resolveTelemetryConfig(loadEnv(base)).enabled).toBe(false);
  });
  it("enables when an OTLP endpoint is set", () => {
    const c = resolveTelemetryConfig(loadEnv({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318", OTEL_SERVICE_NAME: "svc", OTEL_TRACES_SAMPLER_ARG: "0.25" }));
    expect(c).toMatchObject({ enabled: true, serviceName: "svc", sampleRatio: 0.25 });
  });
  it("OTEL_SDK_DISABLED=true wins over the endpoint", () => {
    expect(resolveTelemetryConfig(loadEnv({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318", OTEL_SDK_DISABLED: "true" })).enabled).toBe(false);
  });
  it("treats an empty endpoint as unset", () => {
    expect(resolveTelemetryConfig(loadEnv({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: "" })).enabled).toBe(false);
  });
  it("rejects invalid values", () => {
    expect(() => loadEnv({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" })).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
    expect(() => loadEnv({ ...base, OTEL_TRACES_SAMPLER_ARG: "2" })).toThrow(/OTEL_TRACES_SAMPLER_ARG/);
  });
});
