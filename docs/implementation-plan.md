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
| 1 | Prisma schema, init migration, seed, docker-compose | Architect | done | Verified live on local Postgres 16 (Homebrew; Docker Desktop engine unresponsive): `db:deploy` applied both migrations, `db:seed` created 3 services/60 slots/2 users |
| 1 | Env validation (Zod), `.env.example` | Architect | done | `tests/env.test.ts`; production guard observed live (`DEV_AUTH_ENABLED=true` rejected under `next start`) |
| 1 | `/api/health`, `/api/ready` | Architect | done | live: health 200; ready 200 `{database: ok}` with DB, 503 problem+json without |
| 1 | Shared contracts + tests (errors, actor/authz, capabilities, idempotency, audit) | Architect | done | 7 test files / 56 tests pass |
| 1 | Reference slice (organization+services read: service → REST → page) | Architect | done | live: org/services/service-detail return seeded data, unknown → 404 problem+json, home page lists 3 services |
| 1 | MCP tool derivation from registry | Architect | done | `tests/mcp-tools.test.ts` |
| 1 | docs/CONTRACTS.md | Architect | done | file present |
| 1 | CI workflow (lint, tsc, test, build) | Architect | done (not yet run on GitHub) | `.github/workflows/ci.yml`; same 4 commands pass locally |
| 2 | SPEC-002 slots + bookings capabilities (5), repos, REST routes, MCP derivation | Architect (early start) | done | 85 tests incl. 8 against real Postgres; live HTTP walkthrough |
| 2 | Overbooking protection | Architect | done | `tests/db`: 10 racers/cap 1 → 1 winner; cap 3 → 3. Mutation check: removing `FOR UPDATE` makes both fail (10 successes) |
| 2 | Durable idempotency + audit (Postgres) | Architect | done | replay across runtime instances; AuditEvent rows for success/denied, hash only |
| 2 | Slot list on service page | Architect | done | live page shows slots in org timezone |
| 2 | Booking UI / human sign-in | Frontend/Backend | todo | needs Phase 3 session auth |
| 3 | OIDC/OAuth 2.1 bearer verification (jose/JWKS), audience/issuer/exp/alg pinning, mock issuer | Security | done | `tests/auth-tokens.test.ts`; live: mock-issuer tokens accepted, bad/expired/wrong-audience → 401 |
| 3 | `resolveActor(request, {resource})` single entry point; dev resolver demoted | Security | done | `tests/auth-resolve.test.ts`; REST adapter uses it |
| 3 | Sessions + CSRF (cookie, HMAC token, Origin) | Security | done | `tests/auth-session.test.ts` |
| 3 | Agent delegation: grant narrowing/revocation, never admin, TTL cap, human confirmation for `bookings:write` (+ approve endpoint) | Security | done (in-memory grant/confirmation stores) | `tests/auth-tokens.test.ts`, `tests/auth-http.test.ts`; live 428 → approve → 201 → replay 403 |
| 3 | RFC 9728 metadata + WWW-Authenticate (401 / insufficient_scope), checked against MCP spec draft 2026-11-10 | Security | done | `tests/auth-resolve.test.ts`; live `/.well-known/oauth-protected-resource[/mcp]` |
| 3 | Rate limit, body-size limit, replay guard (pluggable, in-memory default), safe errors | Security | done (REST wired; MCP wires in P4) | `tests/security-helpers.test.ts`, `tests/auth-http.test.ts`; live 413 |
| 3 | Authorization matrix (13 profiles × 6 capabilities = 78 cells + IDOR/expiry/audience/escalation/replay) | Security | done | `tests/authz-matrix.test.ts`, `tests/auth-http.test.ts` |
| 3 | docs/authentication.md (+ MCP worker guide), docs/authorization.md, threat-model rows | Security | done | files |
| 3 | Persistent GrantStore, OIDC code-flow login, durable confirmations, shared rate-limit store | Backend/Frontend | todo (documented gaps) | — |
| 4–7 | see phases above | various | todo | — |

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

### Phase 2 verification (Node 24.15.0, local Postgres 16)

```
$ pnpm lint
> agenticweb@0.1.0 lint /Users/upendrasingh/.ao/data/worktrees/agenticweb/agenticweb-2
> eslint .

$ pnpm tsc --noEmit
$ DATABASE_URL_TEST=... pnpm test:run
 Test Files  9 passed (9)
      Tests  85 passed (85)
$ pnpm test:run (no DB)
 Test Files  8 passed | 1 skipped (9)
      Tests  77 passed | 8 skipped (85)
$ pnpm build
✓ Compiled successfully in 706ms
  Finished TypeScript in 10.0min ...
┌ ƒ /
├ ○ /_not-found
├ ƒ /api/health
├ ƒ /api/organizations/[orgSlug]
├ ƒ /api/organizations/[orgSlug]/bookings
├ ƒ /api/organizations/[orgSlug]/bookings/[bookingId]
├ ƒ /api/organizations/[orgSlug]/bookings/[bookingId]/cancel
├ ƒ /api/organizations/[orgSlug]/services
├ ƒ /api/organizations/[orgSlug]/services/[serviceSlug]
├ ƒ /api/organizations/[orgSlug]/services/[serviceSlug]/slots
├ ƒ /api/ready
└ ƒ /services/[serviceSlug]
○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

Live walkthrough (`next dev`, dev actor header): anonymous create → 401; no key → 400; create → 201; replay same key → 201 same booking, 1 row; same key other payload → 422; full slot → 409; list mine → 1; admin get → 200; agent with `bookings:read` get → 200; agent cancel without write scope → 403; owner cancel → 200 `cancelled`; AuditEvent rows recorded; IdempotencyRecord rows persisted.

### AO review follow-up (idempotency claim, audit recovery, atomic cancel)

Fixes: claim-before-execute idempotency (in-memory + Postgres, with lease), replay path audited so a mutation can't stay unaudited after an audit-write failure, dev resolver returns anonymous on malformed scopes, `bookings.cancel` is a single conditional UPDATE.
Evidence (Node 24, local Postgres 16): lint clean, `tsc` clean, `DATABASE_URL_TEST=… pnpm test:run` → 9 files / 91 tests pass (11 against real Postgres, incl. 6 concurrent same-key requests → 1 booking, 5 concurrent cancels → all succeed, lease supersede), without DB: Tests  80 passed | 11 skipped (91), build exit 0.

## Verification (Phase 3 — authn/security)

Node v24.15.0, pnpm 10.33.0, 2026-11-10. Raw output (final run without `DATABASE_URL_TEST`: 12 Postgres tests skipped locally; they passed earlier in this phase and run in CI against a Postgres service):

```
$ pnpm lint
> eslint .
$ pnpm tsc --noEmit
(exit 0)
$ pnpm test:run
 Test Files  14 passed | 1 skipped (15)
      Tests  243 passed | 12 skipped (255)
$ pnpm build
✓ Compiled successfully
  Finished TypeScript
```

Mutation checks (each removal made ≥1 test fail): audience check, issuer check, grant scope narrowing, grant revocation, agent TTL cap, CSRF check, Origin check, confirmation single-use, confirmation input binding, anyone-can-approve, `resource_metadata` decoration, streamed body cap, failed-auth throttling. After AO review, added: separate failed-auth bucket, fail-closed rate-limit store, bounded confirmation store (tests + mutants caught). Two equivalent mutants survived (explicit `algorithms` pin — jose already rejects by key type; agent-kind approver check — agents have no `userId`), kept as defence in depth.

Live (next dev, mock issuer, local Postgres): anonymous → 401 + `resource_metadata`; PRM docs served; user/agent tokens work; agent booking → 428 → human approve → 201 → confirmation replay 403; agent self-approve 403; other user GET booking 404 / owner 200; MCP-audience token on REST 401; expired token 401 (`error_description` "expired"); 70 KB body 413.
