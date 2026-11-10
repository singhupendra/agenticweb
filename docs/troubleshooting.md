# Troubleshooting

Everything is correlated by **`requestId`**: it is returned in the `x-request-id` header and the problem+json body, present on every log line, and on audit events. Traces: find the HTTP span, then the child `capability <name>` span.

## Quick checks

| Symptom | Check |
|---|---|
| Pod restarting at boot | Logs show `Invalid environment configuration:` listing the bad variables (e.g. missing `DATABASE_URL`, `DEV_AUTH_ENABLED=true` in production). |
| `/api/ready` 503 | Database unreachable: `DATABASE_URL`, network policy, TLS (`sslmode`), connection limits. `/api/health` stays 200 (liveness) so the pod is not killed, just unrouted. |
| Container unhealthy locally | `docker logs <c>`; `curl localhost:3000/api/health`. |
| No telemetry | `OTEL_EXPORTER_OTLP_ENDPOINT` set (non-empty) and `OTEL_SDK_DISABLED` not `true`? Collector reachable on 4318? Sampling ratio not 0? Empty endpoint is intentionally a no-op. |

## high-error-rate
Alerts `AgentToolErrorRateHigh`, `AgentTaskFailureRateHigh`. 1) Dashboard "Invocations by outcome" → which `tool`. 2) Jaeger/trace backend: filter `capability.name=<tool>` with error status; the span carries only `error.type`. 3) Logs for the `requestId`: `unhandled capability error` / `output schema violation`. 4) DB: `/api/ready`, connection saturation, lock waits (booking creation locks the slot row `FOR UPDATE`). 5) If it started with a release: roll back (docs/deployment.md).

## slow-tools
Alert `AgentToolLatencyP95High`. Compare per-tool p95 panel; look at the capability span's children for the slow call; check Postgres (slow query log, `pg_stat_activity`). Booking spikes can serialize on slot-row locks.

## invalid-arguments
Alert `AgentInvalidArgumentRateHigh`. Agents are sending inputs the schema rejects. Look at 400 `validation_failed` `errors[].path` in logs for the tool; improve the Zod `.describe()` text / tool description (static text only, never user content) or examples. Also verify a recent schema change did not break clients (`idempotency_key_required` counts here too: agents forgetting the key).

## authz-rejections
Alert `AgentAuthzRejectionSpike`. Query audit events `outcome=denied` grouped by actor/clientId. `unauthenticated` loops = expired/missing token; `forbidden` = missing scope or expired grant; `not_found` includes IDOR-hiding 404s (resource belongs to someone else). Sustained `forbidden`/`not_found` from one client may be probing: revoke its grant and rate-limit.

## Redaction check
If you suspect a secret reached logs: search for token-shaped values; every sink goes through `createLogger` (key + value scrubbing). Add the key pattern to `REDACT` or the value pattern to `SCRUBBERS` in `src/core/logging/logger.ts` with a test in `tests/observability/redaction.test.ts`.

## Docker on a developer machine
If the Docker engine hangs, use Podman (`podman machine start`) with `podman build --target runner .`; stale registry creds cause `unauthorized` on public pulls — use `--authfile <empty json file>`.
