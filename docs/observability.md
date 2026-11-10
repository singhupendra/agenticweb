# Observability

OpenTelemetry (traces + metrics) with OTLP/HTTP export, **off by default**. Structured JSON logs (`src/core/logging`) remain the log channel; they are redacted and carry `requestId`/`capability` for correlation with traces.

## Enabling

| Variable | Default | Meaning |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset → **telemetry is a no-op** | OTLP/HTTP base URL (e.g. `http://otel-collector:4318`). Empty string = unset. |
| `OTEL_SDK_DISABLED` | `false` | `true` forces off even if an endpoint is set. |
| `OTEL_SERVICE_NAME` | `agenticweb` | `service.name` resource attribute. |
| `OTEL_TRACES_SAMPLER_ARG` | `1` | Head-sampling ratio 0..1 (parent-based). Use e.g. `0.1–0.2` in production. |
| `OTEL_EXPORTER_OTLP_HEADERS` | – | Credentials for hosted backends. **Secret**: inject from the secret store; never logged or copied by the app. |
| `OTEL_RESOURCE_ATTRIBUTES` | – | e.g. `deployment.environment.name=production,service.version=1.2.3`. |

Other standard `OTEL_EXPORTER_OTLP_*` variables (timeout, protocol, per-signal endpoints) are read by the exporters directly. Only `OTEL_RESOURCE_ATTRIBUTES` feeds the resource: the default host/process detectors are deliberately **disabled** because they export `process.command_args`, host id and OS user (secret/PII risk) — covered by `tests/observability/sdk.test.ts`.

Bootstrap: `src/instrumentation.ts` (Next.js hook, Node runtime only) → `src/observability/sdk.ts`. Export is flushed on `SIGTERM`.

## Traces

* **HTTP spans** are emitted by Next.js itself once a provider is registered (`GET /api/organizations/[orgSlug]/services`, with `http.route`, `http.status_code`, route-handler and render child spans). Verified live against a local OTLP sink (see tracker evidence).
* **Capability spans** `capability <name>` wrap the whole executor pipeline for every channel (REST, MCP, UI) and nest under the HTTP span. Attributes: `capability.name`, `actor.kind`, `capability.mutating`. Business outcomes (validation, authz, conflict, rate-limit) are **not** span errors; only unexpected failures are. Only the error *type* is recorded (never the message, which may embed tokens/PII).
* `traced(name, fn, {attributes, isError})` in `src/observability/tracing.ts` is the reusable helper for any other unit of work (repository calls, MCP session handling, outbound calls). It rethrows the original error.

## Metrics (`src/observability/metrics.ts`)

Prometheus names assume the Collector's Prometheus exporter defaults (`.`→`_`, counters `_total`, ms histogram `_milliseconds`).

| OTel instrument | Prometheus | Attributes | Recorded by |
|---|---|---|---|
| `agenticweb.agent.requests` | `agenticweb_agent_requests_total` | `channel`, `actor_kind` | channel adapters: REST (`src/api/rest.ts`) and MCP (`src/agents/mcp/server.ts`) — both wired |
| `agenticweb.agent.tool_discoveries` | `…_tool_discoveries_total` | `channel`, `outcome` | MCP `tools/list` (wired); OpenAPI/llms.txt may call `recordToolDiscovery` |
| `agenticweb.agent.tool_invocations` | `…_tool_invocations_total` | `tool`, `actor_kind`, `outcome` (`success`/`invalid_argument`/`authz_rejected`/`conflict`/`rate_limited`/`error`) | executor hook (automatic) |
| `agenticweb.agent.tool_duration` (ms histogram) | `…_tool_duration_milliseconds_bucket` | same | executor hook |
| `agenticweb.agent.invalid_arguments` | `…_invalid_arguments_total` | `tool` | executor hook |
| `agenticweb.agent.authz_rejections` | `…_authz_rejections_total` | `tool`, `code` | executor hook |
| `agenticweb.agent.task_completions` | `…_task_completions_total` | `task`, `outcome` (`completed`/`failed`/`abandoned`) | executor hook for **mutating** capabilities; Phase 5 may add `abandoned` |
| `agenticweb.agent.human_interventions` | `…_human_interventions_total` | `reason` | MCP server: `confirmation_required` (write without `confirm=true`) and `consent_required` (out-of-band approval gate) |

Rules for callers: attribute values must be bounded enums or registry capability names — never user ids, emails, request ids, tokens, free text. The helpers copy only their declared keys (test: "never accepts free-form/PII attributes"), and unknown capability names are bucketed as `unknown`.

**Wiring for new channels:** build the executor via `createRuntime` (already wired with `createOtelInstrument()`), call `recordAgentRequest({channel:"mcp", actorKind})` per MCP request and `recordToolDiscovery` in `tools/list`. Do not re-implement invocation metrics: they come from the executor for free.

## Logging: tokens and PII never appear

`src/core/logging/logger.ts` applies two layers (tests: `tests/observability/redaction.test.ts`):

1. **Key redaction** (substring, case-insensitive, any depth): authorization, cookie, password, token, secret, api key, session, credential, signature, email, phone, full/first/last name, `x-dev-actor`.
2. **Value scrubbing** of free text (message and every string field, incl. error messages): `Bearer …`, JWTs, `?access_token=`-style query params, e-mail addresses, DB/queue connection strings.

Errors are logged as `{name, message}` only (no stack/cause). Audit events store an input *hash*, never raw input. Do not log request bodies.

## Dashboards and alerts (`deploy/observability/`)

* `grafana/dashboards/agenticweb-agents.json` — 15 panels: throughput, success/server-error ratio, latency p50/p95/p99 (overall and per tool), outcomes, agent requests by channel, invalid-argument rate, authz rejections, task completion, human interventions, discovery, top tools. Variables `tool`, `actor_kind`. Auto-provisioned by the compose profile.
* `alerts.rules.yml` + `alerts.test.yml` — 7 Prometheus alerts (error rate, p95 latency, invalid-argument rate, authz spike, task failure rate, human-intervention ratio, telemetry missing), each linking to a `docs/troubleshooting.md` section. Thresholds are starting points. CI runs `promtool check rules` and `promtool test rules`.
* `otel-collector.yaml` — OTLP in; traces → Jaeger, metrics → Prometheus exporter (`:8889`); scrubs authorization/cookie/db-statement attributes as defence in depth.

### Local stack

```bash
docker compose --profile app --profile observability up --build   # app :3000, Grafana :3001, Prometheus :9090, Jaeger :16686
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 docker compose --profile app --profile observability up
```
(set the variable so the app exports to the collector; otherwise telemetry stays off). Without Docker, run any OTLP receiver and `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm start`.

## SLO starting points

Availability of `/api/ready` ≥ 99.5%; p95 tool latency < 1 s; server-error ratio < 1%; booking task failure ratio < 5%. Tune after real traffic.
