# REST API v1 guide

Base path `/api`. Machine-readable contract: **`GET /openapi.json`** (OpenAPI 3.1). Human reference: **`GET /docs`**.
Both are *generated* from the capability registry and Zod schemas (`src/api/openapi.ts`); nothing is hand-written, so they cannot drift from behaviour. Organization slug in examples: `northwind-studio`.

## Endpoints

| Method + path | Capability | Auth | Notes |
|---|---|---|---|
| `GET /organizations/{orgSlug}` | `organization.get` | public | |
| `GET /organizations/{orgSlug}/services` | `services.list` | public | filter `q`, `maxPriceMinor`; sort `sort` |
| `GET /organizations/{orgSlug}/services/{serviceSlug}` | `services.get` | public | |
| `GET /organizations/{orgSlug}/services/{serviceSlug}/slots` | `slots.list` | public | `from`, `to`, `sort=startsAt\|-startsAt`; only future, available slots |
| `POST /organizations/{orgSlug}/bookings` | `bookings.create` | `bookings:write` | **Idempotency-Key**; 201 + `Location` |
| `GET /organizations/{orgSlug}/bookings` | `bookings.list` | `bookings:read` | caller's own; `status`, `sort=createdAt\|-createdAt` |
| `GET /organizations/{orgSlug}/bookings/{id}` | `bookings.get` | owner or admin | non-owner → 404 |
| `PATCH /organizations/{orgSlug}/bookings/{id}` | `bookings.update` | owner or admin | body `{notes: string\|null}`; **Idempotency-Key**; cancelled → 409 |
| `DELETE /organizations/{orgSlug}/bookings/{id}` | `bookings.cancel` | owner or admin | **Idempotency-Key**; returns the cancelled booking (200). `POST …/{id}/cancel` is an equivalent alias |
| `GET /health`, `GET /ready` | — | none | liveness / readiness |

`bookings.update` is REST-only for now (`mcp.exposed: false`); the Agent Integration phase decides whether to expose it as a tool.

## Envelopes

Success: `{ "data": …, "meta": { "requestId", "page"?, "pageSize"?, "total"? } }` (lists put the array in `data` and pagination in `meta`).
Failure: RFC 9457 `application/problem+json`: `{ type, title, status, detail?, instance, code, requestId, errors?[{path,message,code?}] }`. `code` is stable and machine-readable (`validation_failed`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `idempotency_key_required`, `idempotency_key_reuse`, `payload_too_large`, `unsupported_media_type`, `method_not_allowed`, `rate_limited`, `not_ready`, `internal`). `500` bodies never carry internals. Every response carries `X-Request-Id` (a supplied one is echoed).

## Request rules

* Bodies must be `application/json` objects, ≤ 64 KiB (`415`/`413`/`400` otherwise). Unknown body or query fields are rejected (`400`); a repeated query parameter is rejected.
* Path parameters always win over query/body values.
* `userId`, `organizationId`, `status` are never accepted from input; the actor decides them.
* Money is integer minor units + ISO currency; timestamps are UTC ISO-8601.

## Pagination, filtering, sorting

`page` (≥1, default 1) and `pageSize` (1–50, default 20). The response `meta` has `page`, `pageSize`, `total`, and a `Link` header (RFC 8288) carries `first`/`prev`/`next`/`last`. A page past the end returns `data: []` with the real `total`. Sort keys are enumerated per endpoint; a `-` prefix means descending. Invalid values are `400` with a field error.

## Caching (public reads)

`organization.get`, `services.*`, `slots.list` send a strong `ETag` (hash of the payload only, not `requestId`) and `Cache-Control: public, max-age=60` (`max-age=10` for slots, whose availability changes). Send `If-None-Match` (strong, weak, list or `*`) to get `304` with no body. Authenticated reads are `private, no-store`; every error is `no-store`.

## Idempotency

Every mutation requires `Idempotency-Key` (8–128 chars `[A-Za-z0-9_-]`). Same key + same body → the original response is replayed (no second effect). Same key + different body → `422 idempotency_key_reuse`. Same key still in flight → `409` with `Retry-After`. Keys are scoped per capability and actor.

## Authentication

The adapter resolves an `Actor` through `ActorResolver` (`src/core/auth`); until the Security phase lands real session/token verification, requests are anonymous unless `DEV_AUTH_ENABLED=true` (never in production) enables the `x-dev-actor` header. Anonymous callers get `401` on protected operations; scope/role failures are `403`; resources the actor may not see are `404`.

## Rate limiting hook

`createRestHandler(name, { …, rateLimit })` accepts a `RateLimitHook({request, actor, capability, requestId})` that runs after the actor is known and before the capability. Throw `new AppError("rate_limited", msg, { headers: { "retry-after": "30" } })` to answer `429`. Default: none (Security owns the implementation). `429` is already documented on every operation.

## Adding or changing an endpoint

1. Change/add the capability (schemas in `modules/<m>/schemas.ts`); declare `http` (and `httpAliases`, `cacheSeconds` if needed).
2. Add the one-line route file `src/app/api/…/route.ts` (`export const METHOD = restHandler("<name>")`).
3. Nothing else: OpenAPI, `/docs` and the contract suite pick it up. `tests/api/openapi-document.test.ts` fails if a route file is missing or the public surface snapshot changes unreviewed.

## Contract tests

`tests/api/` drives the real adapter in-process and validates **every response** (status documented, content-type documented, body valid against the generated JSON Schema, RFC 9457 consistency for all errors) using Ajv (2020-12). Run with `pnpm test:run`; Postgres-backed repository tests in `tests/db` need `DATABASE_URL_TEST`.
