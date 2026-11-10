# CONTRACTS — authoritative guide for all workers

If this file and the code disagree, the code in `src/core/**` and `src/modules/*/schemas.ts` wins; fix this file.
Run `nvm use` (Node 24) and `pnpm install`. Before every commit: `pnpm lint && pnpm tsc --noEmit && pnpm test:run && pnpm build`.

## 1. Where things go

| Thing | Location | Notes |
|---|---|---|
| Zod schemas (input, output, entities) | `src/modules/<m>/schemas.ts` | **Only** place validation shapes are defined. Reused by REST, MCP, UI. |
| Business rules | `src/modules/<m>/service.ts` | Pure TS against repository interfaces. No `Request`, no Next imports. |
| DB access | `src/modules/<m>/repository.prisma.ts` | Only files named `*repository*` (and `src/core/db`, `prisma/`) may import `@/generated/prisma` (ESLint enforces). |
| Capability definitions | `src/modules/<m>/capabilities.ts` | One `defineCapability` per behaviour; then add to `src/capabilities.ts`. |
| Wiring | `src/runtime.ts` | The only composition root. |
| REST routes | `src/app/api/**/route.ts` | One-liner: `export const GET = restHandler("<capability>")`. |
| REST adapter | `src/api/` | Request → actor → `executor.invoke` → envelope/problem. No logic. |
| MCP tools / server | `src/agents/tools` (derivation, done), `src/agents/mcp` (Phase 4) | Tools are derived via `listTools`, never hand-written. |
| Discovery / OpenAPI / WebMCP | `src/agents/discovery` | Generated from the registry. |
| Agent-specific policy (quota, consent) | `src/agents/policies` | Layers on `core/authorization`. |
| UI | `src/app/**` | Server components call `getRuntime().executor.invoke(...)` with the session actor. Presentation helpers live in `modules/<m>/present.ts`. |
| Tests | `tests/*.test.ts`, fixtures in `tests/fixtures` | Vitest, node env. E2E in `tests/e2e` (Phase 6, Playwright). |

## 2. The contracts (all tested)

* **Actor** (`core/auth/actor.ts`): `anonymous | user | admin | agent`. Agent = `clientId` + `onBehalfOf` + `delegation{grantId, scopes, expiresAt}`. Resolve a request to an Actor in the adapter (`ActorResolver`); nothing deeper reads headers/cookies.
* **Authorization** (`core/authorization/policy.ts`): capabilities declare `requirement: {access, scope}`; `DefaultPolicy.decide` enforces. Agents never get `admin`; agent rights = scopes ∩ the delegating user's rights. Non-owners get **404**, not 403 (IDOR).
* **Errors** (`core/errors`): throw `AppError(code)` (helpers: `notFound`, `forbidden`, `validationError`, `conflict`). Wire format is RFC 9457 `application/problem+json` with stable `code`. Unknown errors become a generic 500. Add new codes in `ERROR_CODES`; never rename.
* **Envelope**: success `{data, meta:{requestId, page?, pageSize?, total?}}`. A capability returning `{items,page,pageSize,total}` (`paginatedSchema`) is lifted automatically.
* **Capability** (`core/capabilities`): `{name, input, output, requirement, mutating, http, mcp, loadResource?, execute}`. The registry rejects duplicates, mutating GETs, admin caps exposed to MCP, MCP caps without scope, and `owner-or-admin` without `loadResource`.
* **Executor pipeline** (`createExecutor`): validate → loadResource → authorize → idempotency → execute → output-parse (strips extra fields) → audit. It is the ONLY way to run a capability.
* **Idempotency** (`core/idempotency`): every `mutating` capability requires a key (`Idempotency-Key` header / `idempotencyKey` tool arg, 8–128 chars `[A-Za-z0-9_-]`). Protocol is **claim → execute → complete** (`release` on failure): `IdempotencyStore.claim` must be atomic per (scope,key) (Postgres unique index). Same key + payload in flight → 409 with `Retry-After`; completed → replay of the stored response (audited with `replayed: true`); different payload → 422. In-progress claims carry a 60 s lease. Residual risk: crash after the mutation commits but before `complete` → a retry re-executes after the lease, so mutations should also be naturally idempotent (unique constraints).
* **Audit** (`core/logging/audit.ts`): mutations and denials are recorded automatically by the executor (hash of input, never raw input). Implement `AuditLog` with Prisma (`AuditEvent`) in Phase 2. Mutations fail closed if the audit write fails; because the result is stored under the key first, the retry's replay writes the audit event, so a mutation is never permanently unaudited.
* **Env** (`core/env.ts`): add new variables to `EnvSchema` AND `.env.example`. Never read `process.env` elsewhere.

## 3. How to add a capability (e.g. `bookings.create`)

1. Spec/acceptance criteria in a test first (`tests/bookings-*.test.ts`).
2. Schemas in `modules/bookings/schemas.ts` (already stubbed). Inputs use `z.strictObject`; never accept `userId`, `organizationId`, `status` from input.
3. Service + repository interface in `service.ts`; Prisma impl in `repository.prisma.ts`; in-memory impl for tests.
4. `defineCapability` in `modules/bookings/capabilities.ts`: set `mutating: true`, `requirement: {access:"authenticated", scope:"bookings:write"}`, `http: POST`, `mcp: {toolName, exposed:true, description}` (static text).
5. For anything addressed by id (`bookings.cancel/get`): `access:"owner-or-admin"` + `loadResource` returning `{type,id,ownerId,organizationId}`.
6. Add it to `src/capabilities.ts`, wire deps in `src/runtime.ts` (extend `AppDeps`).
7. Add route file(s) `src/app/api/.../route.ts` (one-liner). MCP tool appears automatically.
8. Add authorization-matrix and idempotency-replay tests. Update `docs/implementation-plan.md` tracker with evidence.

## 4. Must NOT be duplicated / done

* Do not re-declare validation shapes in routes, components, or MCP code — import from `modules/*/schemas`.
* No business logic, DB calls, or authorization checks in route handlers, pages, or MCP/WebMCP code.
* Do not hand-write MCP tool definitions, OpenAPI paths, or REST client types — derive from the registry/Zod (`z.toJSONSchema`, `z.infer`).
* Do not create new error formats, envelopes, or ad-hoc `Response.json({error})`.
* Do not read cookies/headers/tokens outside an `ActorResolver`.
* Do not include user-provided text in MCP tool descriptions (tool poisoning).
* Do not widen an agent's permission beyond its scopes; do not add an admin path for agents.
* Do not import Prisma outside repository files.
* Money = integer minor units + ISO currency; timestamps = UTC ISO-8601 (`timestamptz`).

## 5. Naming

Capability `module.verb` (`services.list`) · MCP tool `snake_case` verb_noun (`list_services`) · REST `/api/organizations/{orgSlug}/<collection>/{id}` · scopes `<resource>:<read|write>` · error codes `snake_case` · files `kebab-case.ts`, repositories `repository.prisma.ts`.

## 6. Known gaps (owned by later phases)

Real authN (sessions, OAuth/agent token verification — currently anonymous, or the dev header `x-dev-actor` when `DEV_AUTH_ENABLED=true`, refused in production) · durable audit/idempotency stores (in-memory today) · bookings/users capabilities (schemas + interfaces only) · MCP server, OpenAPI, discovery, WebMCP · OpenTelemetry · rate limiting · Playwright E2E · Prisma repositories/migration/seed were **not exercised against a live Postgres in Phase 1** (no database was available to the Architect worker) — Backend must run `pnpm db:up && pnpm db:deploy && pnpm db:seed` and confirm `/api/ready` and the services routes first.
