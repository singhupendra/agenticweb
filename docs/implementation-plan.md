# Implementation plan

Owners: Architect (P1), Backend (P2, P3 data/authn), Frontend (P2 UI), Agent Integration (P4–5), Security (P3/P6), QA (P6), DevOps (P7).
Rule: a phase is done only when its exit criteria are met **and evidence is recorded in the tracker**.

## Phase 1 — Foundation (Architect)
Docs, scaffold, shared contracts, reference vertical slice (organization + services read).
**Exit:** docs 1–4 present; `pnpm lint`, `pnpm tsc --noEmit`, `pnpm test:run`, `pnpm build` pass; contracts have tests; `/api/health` + `/api/ready`; `docs/CONTRACTS.md` published.

## Phase 2 — Domain & persistence (Backend + Frontend)
Real Prisma repositories behind service interfaces; slots + bookings capabilities (create/cancel/list-mine), availability computation, transactional overbooking protection, Postgres-backed idempotency store and audit log; UI for catalogue, slot picker, booking form.
**Exit:** integration tests against Postgres (docker-compose/CI service) incl. concurrent booking of the last slot; idempotent replay returns the original result; seed produces a usable demo.

## Phase 3 — Identity & authorization (Backend + Security)
Human sessions; agent delegation grants (consent, scopes, expiry, revocation); token verification producing `Actor`; policy implementation with ownership checks (IDOR).
**Exit:** authorization matrix test (actor × capability × resource owner) green; no capability reachable without an explicit policy; delegated agent cannot exceed delegator.

## Phase 4 — REST/OpenAPI & remote MCP (Agent Integration)
OpenAPI 3.1 generated from the registry; `/mcp` Streamable HTTP server exposing tools generated from the registry; `/.well-known` discovery (`llms.txt`, API catalog, OAuth protected-resource metadata); rate limits.
**Exit:** MCP conformance via SDK client test; REST and MCP return identical results/errors for the same capability (parity test); schema snapshot test for OpenAPI.

## Phase 5 — WebMCP & agent UX (Agent Integration + Frontend)
Optional `navigator.modelContext` tool registration, feature-detected, calling the same REST endpoints; human-in-the-loop confirmation for mutating tools.
**Exit:** site works with WebMCP absent; Playwright test of tool registration with a polyfill.

## Phase 6 — Quality, security, observability (QA + Security)
Playwright E2E; OpenTelemetry traces/metrics; threat-model mitigations verified; dependency and secret scanning; prompt-injection test corpus; ESLint boundary rules.
**Exit:** every threat-model row marked mitigated/accepted with test link; E2E green in CI.

## Phase 7 — Delivery (DevOps)
Dockerfile, deploy target, migrations in pipeline, backups, runbooks, SLOs, load test.
**Exit:** staged deploy from CI; rollback rehearsed; readiness gates traffic.

## Tracker

Status: `todo` · `in-progress` · `done` · `blocked`.

| Phase | Item | Owner | Status | Evidence |
|---|---|---|---|---|
| 1 | docs/architecture.md | Architect | done | file present |
| 1 | docs/implementation-plan.md | Architect | done | file present |
| 1 | docs/technology-decisions.md | Architect | done | versions from `npm view` 2026-11-09 |
| 1 | docs/threat-model.md | Architect | done | file present |
| 1 | Scaffold (Next 16/TS 6/Tailwind 4/pnpm, module layout) | Architect | done | `pnpm build` OK, see Verification |
| 1 | Prisma schema, init migration, seed, docker-compose | Architect | partial | `prisma validate` OK; migration SQL generated via `prisma migrate diff`; **seed/migration NOT run against a live Postgres** (Docker daemon unresponsive, no local Postgres) |
| 1 | Env validation (Zod), `.env.example` | Architect | done | `tests/env.test.ts`; production guard observed live (`DEV_AUTH_ENABLED=true` rejected under `next start`) |
| 1 | `/api/health`, `/api/ready` | Architect | done (ready: partial) | live: health 200; ready returns 503 problem+json without DB. Ready=200 path **unverified** (no DB) |
| 1 | Shared contracts + tests (errors, actor/authz, capabilities, idempotency, audit) | Architect | done | 7 test files / 56 tests pass |
| 1 | Reference slice (organization+services read: service → REST → page) | Architect | partial | domain + REST adapter tested in-memory; live: invalid slug → 400 problem+json; DB-backed 200 path and page data **unverified** (no DB) |
| 1 | MCP tool derivation from registry | Architect | done | `tests/mcp-tools.test.ts` |
| 1 | docs/CONTRACTS.md | Architect | done | file present |
| 1 | CI workflow (lint, tsc, test, build) | Architect | done (not yet run on GitHub) | `.github/workflows/ci.yml`; same 4 commands pass locally |
| 2–7 | see phases above | various | todo | — |

## Verification (Phase 1)

Node v24.15.0, pnpm 10.33.0, 2026-11-09. Raw output:

```
$ pnpm lint
> agenticweb@0.1.0 lint /Users/upendrasingh/.ao/data/worktrees/agenticweb/agenticweb-2
> eslint .


$ pnpm tsc --noEmit
(exit 0)

$ pnpm test:run
 RUN  v5.1.0 /Users/upendrasingh/.ao/data/worktrees/agenticweb/agenticweb-2


 Test Files  7 passed (7)
      Tests  56 passed (56)
   Start at  21:06:06
   Duration  228ms (import 59%, transform 22%, tests 14%, setup 3%, worker 2%)


$ pnpm build
✓ Compiled successfully in 318ms
  Finished TypeScript in 655ms ...
Route (app)
┌ ƒ /
├ ○ /_not-found
├ ƒ /api/health
├ ƒ /api/organizations/[orgSlug]
├ ƒ /api/organizations/[orgSlug]/services
├ ƒ /api/organizations/[orgSlug]/services/[serviceSlug]
├ ƒ /api/ready
└ ƒ /services/[serviceSlug]
○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

Live smoke (`next start`, no database): `/api/health` → 200 `{"status":"ok"}`; `/api/ready` → 503 `application/problem+json` code `not_ready`; `/api/organizations/BAD_SLUG/services` → 400 problem+json with field error `orgSlug`; `/api/organizations/northwind-studio/services` → 500 generic problem (expected: no DB); `/` → 200 (renders error alert).

**Not verified:** anything touching real Postgres (migration apply, seed, Prisma repositories, `/api/ready` 200, seeded services in REST/UI).
