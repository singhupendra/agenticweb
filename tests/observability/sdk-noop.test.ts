import { describe, expect, it } from "vitest";
import { trace } from "@opentelemetry/api";
import { loadEnv } from "@/core/env";
import { traced } from "@/observability";
import { startTelemetry } from "@/observability/sdk";

describe("SDK bootstrap without an endpoint", () => {
  it("is a no-op: no provider registered, helpers still work, shutdown resolves", async () => {
    const handle = startTelemetry(loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" }));
    expect(handle.config.enabled).toBe(false);
    expect(await traced("noop", async (s) => s.isRecording())).toBe(false);
    expect(trace.getTracer("x").startSpan("y").isRecording()).toBe(false);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});
