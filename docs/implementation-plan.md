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
| 3 | REST v1 + OpenAPI 3.1 (generated from registry), `/openapi.json`, `/docs`, contract suite | Backend (REST) | done | See "REST v1 verification" below; docs/api-guide.md |
| 3 | Filtering/sorting/pagination (`Link`), ETag/304 + Cache-Control on public reads, `bookings.update` (PATCH), DELETE cancel alias, rate-limit hook | Backend (REST) | done | `tests/api/*`, `tests/rest-v1-domain.test.ts`, `tests/db` (real Postgres) |
| 4 | Remote MCP server `/mcp` (Streamable HTTP, stateless), tools derived from registry, `update_booking` exposed, confirm+idempotency on writes, sanitised output, 401 challenge, timeout, hooks | Agent Integration | done (rebased on Security PR #5: audience-bound bearer, 401 challenge, confirmation gate, shared rate limits) | `tests/mcp/*`, `docs/mcp-integration.md`, see "MCP verification" |
| 2 | Booking UI (catalogue, slot picker, accessible booking form, status/cancel, loading/error/not-found) | Frontend | done (sign-in itself still Phase 3) | see Verification (Frontend), `tests/e2e/site.spec.ts` |
| 2 | Human sign-in | Backend | todo | needs Phase 3 session auth |
| 2/5 | JSON-LD generators, robots.txt, sitemap.xml, llms.txt | Frontend | done | `tests/discovery/*`, `docs/agent-discovery.md` |
| 5 | WebMCP (feature-detected, confirm on mutations) | Frontend | done (spec is a CG draft) | `tests/discovery/webmcp.test.ts`, `tests/e2e/webmcp.spec.ts`, `docs/webmcp-integration.md` |
| 5/6 | Playwright config + human-flow E2E with axe | Frontend | done (not in CI yet) | see Verification (Frontend) |
| 3 | OIDC/OAuth 2.1 bearer verification (jose/JWKS), audience/issuer/exp/alg pinning, mock issuer | Security | done | `tests/auth-tokens.test.ts`; live: mock-issuer tokens accepted, bad/expired/wrong-audience → 401 |
| 3 | `resolveActor(request, {resource})` single entry point; dev resolver demoted | Security | done | `tests/auth-resolve.test.ts`; REST adapter uses it |
| 3 | Sessions + CSRF (cookie, HMAC token, Origin) | Security | done | `tests/auth-session.test.ts` |
| 3 | Agent delegation: grant narrowing/revocation, never admin, TTL cap, human confirmation for `bookings:write` (+ approve endpoint) | Security | done (in-memory grant/confirmation stores) | `tests/auth-tokens.test.ts`, `tests/auth-http.test.ts`; live 428 → approve → 201 → replay 403 |
| 3 | RFC 9728 metadata + WWW-Authenticate (401 / insufficient_scope), checked against MCP spec draft 2026-11-10 | Security | done | `tests/auth-resolve.test.ts`; live `/.well-known/oauth-protected-resource[/mcp]` |
| 3 | Rate limit, body-size limit, replay guard (pluggable, in-memory default), safe errors | Security | done (REST wired; MCP wires in P4) | `tests/security-helpers.test.ts`, `tests/auth-http.test.ts`; live 413 |
| 3 | Authorization matrix (13 profiles × 7 capabilities = 91 cells + IDOR/expiry/audience/escalation/replay) | Security | done | `tests/authz-matrix.test.ts`, `tests/auth-http.test.ts` |
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

### REST v1 verification (Node 24.15.0, local Postgres 16 on a throwaway cluster)

```
$ pnpm lint            -> eslint . (exit 0)
$ pnpm tsc --noEmit    -> exit 0
$ DATABASE_URL_TEST=... pnpm test:run
 Test Files  12 passed (12)
      Tests  150 passed (150)      # 13 against real Postgres (after AO review fixes)
$ pnpm test:run (no DB)
 Test Files  11 passed | 1 skipped (12)
      Tests  137 passed | 13 skipped (150)
$ pnpm build           -> exit 0; routes incl. ƒ /docs, ƒ /openapi.json, ƒ /api/organizations/[orgSlug]/bookings/[bookingId]
```

Contract suite (`tests/api`, 46 tests): every response is validated with Ajv (JSON Schema 2020-12) against the generated OpenAPI (status documented, content-type documented, body schema, RFC 9457 consistency on every error). Mutation check: breaking `Location`/`Link` headers failed 10+ tests. Live walkthrough on `next dev` + seeded Postgres: list+sort+Link, ETag → 304, create 201 + Location, replay same key → same booking, PATCH 200, anonymous GET 401 problem+json, DELETE → cancelled, text/plain → 415, `/openapi.json` 3.1.0 with 9 paths, `/docs` 200 HTML.

Gaps: no OpenAPI meta-schema validation (structural checks only: refs resolve, unique operationIds, path params declared); `bookings.update` not exposed to MCP; rate limiting is a hook only; `resolveActor` does not exist yet in `core/auth`, the adapter still uses the `ActorResolver` interface through `defaultResolver()` (Security replaces it).

AO review follow-up: request body is now read as a capped stream (413 aborts the read), after actor resolution + rate-limit hook; `x-request-id` is accepted only if `^[A-Za-z0-9._-]{1,128}$`, else a UUID is generated. Both covered by new tests that fail on the previous implementation.
### Verification (Frontend: site, discovery, WebMCP) — Node 24.15.0, local Postgres 16, 2026-11-10

```
$ pnpm lint            → eslint . (exit 0, no output)
$ pnpm tsc --noEmit    → exit 0
$ pnpm test:run        → Test Files  11 passed | 1 skipped (12); Tests  168 passed | 13 skipped (181) after rebase onto Phase 3 REST/OpenAPI (a3a47d5)
                         (31 new: tests/discovery/{jsonld,crawl,webmcp}.test.ts; skipped = Postgres integration tests, DATABASE_URL_TEST unset)
$ pnpm build           → Compiled successfully; routes incl. /, /services, /services/[serviceSlug], /bookings/[bookingId], /llms.txt, /robots.txt, /sitemap.xml
$ E2E_DATABASE_URL=…/agenticweb_fe pnpm test:e2e
                       → 33 passed, 1 skipped (after review fix: +/webmcp.json test; keyboard test skipped on mobile), desktop + Pixel 5, axe wcag2a/2aa/21a/21aa clean on home, services, detail (anon + signed-in form), booking status
```

Covered end-to-end: anonymous browse, sign-in-required states, signed-in book → status → cancel (double-submit safe via per-render Idempotency-Key), validation error announced, unknown/foreign booking → not-found, JSON-LD FAQ == visible FAQ, discovery files, WebMCP absent (site works) and polyfilled (read-only tools for anon, REST parity, confirm/decline on mutation).
**Not verified:** Google Rich Results validator (needs public URL), real browser with native WebMCP, screen-reader manual pass, E2E in CI.


## Verification (Phase 3 — authn/security)

Node v24.15.0, pnpm 10.33.0, 2026-11-10, after merging main (REST v1 / OpenAPI #3, site/WebMCP #4). Raw output (final run without `DATABASE_URL_TEST`: 13 Postgres tests skipped locally; they passed earlier in this phase and run in CI against a Postgres service):

```
$ pnpm lint
> eslint .
$ pnpm tsc --noEmit
(exit 0)
$ pnpm test:run
 Test Files  20 passed | 1 skipped (21)
      Tests  342 passed | 13 skipped (355)
$ pnpm build
✓ Compiled successfully
  Finished TypeScript
```

Mutation checks (each removal made ≥1 test fail): audience check, issuer check, grant scope narrowing, grant revocation, agent TTL cap, CSRF check, Origin check, confirmation single-use, confirmation input binding, anyone-can-approve, `resource_metadata` decoration, streamed body cap, failed-auth throttling. After AO review, added: separate failed-auth bucket, fail-closed rate-limit store, bounded confirmation store (tests + mutants caught). Two equivalent mutants survived (explicit `algorithms` pin — jose already rejects by key type; agent-kind approver check — agents have no `userId`), kept as defence in depth.

Live (next dev, mock issuer, local Postgres): anonymous → 401 + `resource_metadata`; PRM docs served; user/agent tokens work; agent booking → 428 → human approve → 201 → confirmation replay 403; agent self-approve 403; other user GET booking 404 / owner 200; MCP-audience token on REST 401; expired token 401 (`error_description` "expired"); 70 KB body 413.
### MCP verification (Agent Integration) — Node 24.15.0, local Postgres 16 (throwaway cluster :55437), 2026-11-10

```
$ pnpm lint            → eslint . (exit 0, no output)
$ pnpm tsc --noEmit    → exit 0
$ pnpm test:run        → Test Files  16 passed | 1 skipped (17); Tests  202 passed | 13 skipped (215)
$ DATABASE_URL_TEST=…/agenticweb_test pnpm test:run → Test Files  17 passed (17); Tests  215 passed (215)
$ pnpm build           → exit 0; routes incl. ƒ /mcp
```
New: `tests/mcp/mcp-server.test.ts` (30 tests, SDK `Client` + `StreamableHTTPClientTransport` over a real `node:http` server), `tests/mcp/sanitize.test.ts` (4). Updated `tests/mcp-tools.test.ts` for the deliberately exposed `update_booking`.

Live (`next dev` + seeded Postgres, SDK client, agent actor with services:read,bookings:read,bookings:write): 9 tools listed; list_services → 3 seeded; create_booking → confirmed; replay same key → same id; new key same slot → `conflict`; get_booking → confirmed; cancel_booking → cancelled; invalid arg → `validation_failed`; anonymous `list_my_bookings` → HTTP 401 `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`. MCP Inspector CLI (`npx @modelcontextprotocol/inspector --cli … --method tools/list` and `tools/call get_organization`) returned the expected tool list / structuredContent.

Shared-file edits (additive): `McpBinding.destructive`, `ERROR_CODES.timeout` (504), `bookings.update` `mcp.exposed: true`, `listTools(..., {requireConfirm})`.
Rebased on Security PR #5 (95f0fc2): route uses `resolveActor(request,{resource:"mcp"})`, `decorateAuthError`, `getAgentGate()` (agent writes → `confirmation_required` + `confirmationId`/`approveUrl`, retry with `confirmationId`), shared REST rate-limit buckets (`defaultRateLimiting` now exported). Re-verified after rebase: lint clean, `tsc --noEmit` clean, `pnpm test:run` → 22 files passed | 1 skipped; 379 passed | 13 skipped (392).
Live with mock issuer (`next dev`, seeded Postgres, SDK client + bearer): MCP-audience agent token lists 9 tools; REST-audience token on `/mcp` → 401 `invalid_token` + `resource_metadata`; create_booking → 428 `confirmation_required` + approveUrl; user bearer approves (200); retry with `confirmationId` → `confirmed`; cancel_booking → `confirmation_required`.
**Gaps:** `confirm=true` is model-asserted (the gate is the hard control, and applies to agents only); OTel is a hook only (`McpDeps.metrics`; DevOps helpers not merged); `claude mcp add` commands not executed against a local Claude config; no stdio/SSE transport, no session resumability (stateless by design); in-memory confirmation/rate-limit stores are per-instance (Security's note).
