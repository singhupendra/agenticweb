import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

export const TRACER_NAME = "agenticweb";
export const getTracer = () => trace.getTracer(TRACER_NAME);

export interface TracedOptions {
  attributes?: Attributes;
  /** Return false for expected failures (validation, authz, conflicts) so they do not mark the span as an error. */
  isError?: (e: unknown) => boolean;
}

/**
 * Runs `fn` inside an active span. Zero-cost no-op when no SDK is registered.
 * On failure the ORIGINAL error is rethrown; only the error type is recorded on the span (never the message,
 * which may embed tokens or PII — details belong in the redacted logs, correlated by request id).
 */
export function traced<T>(name: string, fn: (span: Span) => Promise<T> | T, opts: TracedOptions = {}): Promise<T> {
  return getTracer().startActiveSpan(name, { attributes: opts.attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.setAttribute("error.type", e instanceof Error ? e.name : "unknown");
      if (opts.isError?.(e) ?? true) span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      span.end();
    }
  });
}
