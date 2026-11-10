import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { traced } from "@/observability";
import { installTelemetry } from "./harness";

const t = installTelemetry();
afterAll(() => t.shutdown());
beforeAll(() => t.spans.reset());

describe("traced()", () => {
  it("wraps an async function in a span, returns its value, sets attributes", async () => {
    const r = await traced("unit.ok", async () => 42, { attributes: { "app.kind": "test" } });
    expect(r).toBe(42);
    const span = t.spans.getFinishedSpans().find((s) => s.name === "unit.ok");
    expect(span?.attributes["app.kind"]).toBe("test");
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("nests child spans under the active span", async () => {
    await traced("unit.parent", () => traced("unit.child", async () => 1));
    const spans = t.spans.getFinishedSpans();
    const parent = spans.find((s) => s.name === "unit.parent")!;
    const child = spans.find((s) => s.name === "unit.child")!;
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it("marks the span as error, rethrows the original error, and does not leak the error message", async () => {
    const boom = new Error("secret-token-abc123 in message");
    await expect(traced("unit.fail", async () => { throw boom; })).rejects.toBe(boom);
    const span = t.spans.getFinishedSpans().find((s) => s.name === "unit.fail")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify([span.status, span.events, span.attributes])).not.toContain("secret-token-abc123");
    expect(span.attributes["error.type"]).toBe("Error");
  });

  it("lets callers classify expected failures as non-errors", async () => {
    await expect(traced("unit.expected", async () => { throw new RangeError("x"); }, { isError: () => false })).rejects.toThrow(RangeError);
    const span = t.spans.getFinishedSpans().find((s) => s.name === "unit.expected")!;
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span.attributes["error.type"]).toBe("RangeError");
  });
});
