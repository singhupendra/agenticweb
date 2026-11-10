# src/observability

OpenTelemetry for agenticweb. Full guide: `docs/observability.md`.

| File | Purpose |
|---|---|
| `config.ts` | env → `TelemetryConfig`; telemetry is a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set |
| `sdk.ts` | NodeSDK bootstrap (OTLP/HTTP traces + metrics). Loaded lazily by `src/instrumentation.ts`; not re-exported |
| `tracing.ts` | `traced(name, fn, opts)` helper (records error type only, rethrows original) |
| `metrics.ts` | agent metrics + `record*` helpers (bounded attributes only) |
| `telemetry.ts` | `createOtelInstrument()`: executor hook → span + invocation/latency/invalid-arg/authz/task metrics |

Import from `@/observability` (never from `sdk.ts`). Never put ids, emails, tokens or free text in span/metric attributes.
