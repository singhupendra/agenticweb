# Authentication (Phase 3)

One entry point for every channel: **`resolveActor(request, { resource? })`** (`src/core/auth/resolve-actor.ts`). It returns an `Actor` (`anonymous | user | admin | agent`) or throws a 401/403 `AppError`. Nothing else in the codebase reads cookies, headers or tokens (`DevHeaderActorResolver` is now just one input to it, dev only).

## Resolution order

1. `Authorization` header present → must be `Bearer <jwt>`; verified (below). **Any failure is a 401 — it never degrades to anonymous or to a cookie**, even on public endpoints.
2. Session cookie → user/admin actor. Unsafe methods (anything but GET/HEAD/OPTIONS) also need CSRF proof (403 otherwise).
3. `x-dev-actor` only when `DEV_AUTH_ENABLED=true` (refused when `NODE_ENV=production`).
4. Anonymous.

## Bearer tokens (OIDC / OAuth 2.1 resource server)

`src/core/auth/access-token.ts`, via `jose` + JWKS. Configure with `AUTH_ISSUER` (exact `iss`) and optionally `AUTH_JWKS_URI` (default `<issuer>/.well-known/jwks.json`, cached/rotated by `createRemoteJWKSet`).

Checked on every request: signature (asymmetric algs only: ES256/384, RS256, PS256, EdDSA — no `none`, no HS\*), `iss`, **audience** (RFC 8707: REST accepts `<origin>`, MCP accepts `<origin>/mcp`; a token for one is rejected by the other), `exp`/`nbf` with 5 s skew, required `sub`, `iat`, `exp`, `jti`.

Claims we require/understand:

| Claim | User token | Agent (delegated) token |
|---|---|---|
| `token_use` | `user` | `agent` |
| `sub` | user id | the delegating user id (or client id for a public-only agent) |
| `org_id` | required | present ⇒ bound to that user; absent ⇒ **public-only** agent (`onBehalfOf: null`) |
| `roles` | `["admin"]` ⇒ `admin` actor | ignored — **agents are never admin** |
| `client_id`, `grant_id` | must be absent | required |
| `scope` | n/a | space-delimited; unknown scopes grant nothing |

Agent tokens: lifetime capped at 1 h (`exp - iat`), `delegation.expiresAt = exp`. A token carrying agent claims can never be turned into a user actor.

**Grants (revocation + narrowing).** With `AUTH_STORES=postgres` (default; required in production) the `AgentGrant` table (`PrismaGrantStore`, `src/core/db/auth-stores.ts`) is authoritative: unknown/revoked grant, wrong client or wrong user ⇒ 401; effective scopes = token scopes ∩ grant scopes (never widens; scopes the code does not know are dropped). Revocation (`revoke(grantId)`) is one conditional UPDATE, durable and visible to every instance on the next request; `put` can re-scope a grant of the same user+client but never resurrects a revoked one nor changes its owner. `AUTH_STORES=memory` has **no** grant store (token claims trusted as minted; tests/throwaway dev only — refused in production). The mock issuer's token endpoint records a grant when it mints an agent token (it plays the consent screen). **Gap: no end-user consent/revocation UI yet** (writes go through `PrismaGrantStore.put/revoke`).

### Local dev / tests without an IdP
`MOCK_ISSUER_ENABLED=true` (refused in production) runs an in-process ES256 issuer: `GET /api/dev/mock-issuer/jwks`, `POST /api/dev/mock-issuer/token` with `{kind: user|admin|agent, userId, organizationId, scopes, resource: rest|mcp, expiresInSec}` → `{access_token}`. In tests use `MockIssuer` (`src/core/auth/mock-issuer.ts`) + `tests/fixtures/auth.ts` (`authKit`).

## Human sessions & CSRF
`SessionManager` (`session.ts`): HS256 JWT in an `HttpOnly; SameSite=Lax; Path=/` cookie (`__Host-session` + `Secure` when `APP_URL` is https), 8 h TTL, `SESSION_SECRET` ≥ 32 chars (required in production). The cookie is a different token class from bearer tokens (symmetric, own issuer/audience) — it is rejected as a bearer token. CSRF: unsafe cookie-authenticated requests need `x-csrf-token` = HMAC(secret, session id) (returned by `create()`, bound to the session) **and**, if an `Origin` header is sent, it must equal the app origin. Bearer requests are not CSRF-prone. Issuing a session after an OIDC login redirect is the UI's job (call `sessions.create(...)` with the verified identity); the authorization-code login flow itself is **not** implemented here (gap, Frontend).

## Human sign-in (OIDC authorization-code + PKCE)

`src/core/auth/oidc.ts` (protocol) + `oidc-http.ts` (handlers) + routes under `/api/auth/*`. Public client + PKCE S256 (a `client_secret_post` is sent only if `OIDC_CLIENT_SECRET` is set).

| Route | Behaviour |
|---|---|
| `GET /api/auth/login?returnTo=/x` | 302 to the issuer's `authorization_endpoint` (discovered from `<AUTH_ISSUER>/.well-known/openid-configuration`; discovery `issuer` must equal the configured one **exactly** (OIDC Discovery requires it; a trailing-slash difference between `AUTH_ISSUER` and the issuer the IdP advertises is rejected — configure the advertised value), endpoints must be https unless localhost) with `response_type=code`, `code_challenge(S256)`, `state`, `nonce`, exact `redirect_uri = <APP_URL>/api/auth/callback`. Sets the transaction cookie. |
| `GET /api/auth/callback` | Opens the transaction cookie, checks `state` (constant time), redeems the code with the PKCE verifier, verifies the **ID token** (asymmetric signature via the issuer JWKS with one refetch on key rotation, `iss`, `aud` = `OIDC_CLIENT_ID`, `exp`, **`nonce`**, `sub`, `org_id`; `roles` containing `admin` ⇒ admin session), creates a **new** session (no fixation), clears the transaction cookie, 302 to `returnTo`. Any failure — including network errors, timeouts, non-JSON or malformed issuer responses — ⇒ generic 400 `login_failed` (cause only in logs; issuer `error_description` is never echoed) and the transaction cookie is cleared. |
| `GET /api/auth/session` | `{authenticated, userId, role, csrfToken}` (no-store) — the CSRF token for cookie-authenticated unsafe requests. |
| `POST /api/auth/logout` | Session + CSRF + Origin check, clears the cookie. `GET` ⇒ 405 (no logout-by-link). RP-initiated logout at the IdP (`end_session_endpoint`) is not done. |

**Transaction cookie** (`login_tx`, `__Host-login_tx` on https): `state`, `nonce`, PKCE verifier and `returnTo` sealed with AES-256-GCM (key derived from `SESSION_SECRET`), `HttpOnly; SameSite=Lax` (Lax is required so the cookie accompanies the IdP's redirect back), 10 min, cleared after use. It binds the login to the browser that started it (login CSRF / code injection into a victim's browser find no transaction) and needs no server-side state. `returnTo` is same-site relative paths only (`//`, `\`, absolute URLs, control characters ⇒ `/`).

**Identity mapping.** The ID token must carry the same claims as our access tokens: `sub` = user id, `org_id` = tenant, optional `roles`. An IdP that cannot emit `org_id` needs a claim-mapping step (not implemented; login is refused rather than guessing a tenant).

**Config:** `AUTH_ISSUER`, `OIDC_CLIENT_ID` (required for real issuers; defaults to `agenticweb-web` for the mock), optional `OIDC_CLIENT_SECRET`, `OIDC_SCOPES` (default `openid profile email`), `SESSION_SECRET`. Sign-in is a 404 when not configured.

**Local demo (no IdP, no network):** `MOCK_ISSUER_ENABLED=true`, `SESSION_SECRET=<32+ chars>`, `pnpm db:deploy && pnpm db:seed && pnpm dev`, open `/bookings` → *Sign in* → the mock IdP page (`/api/dev/mock-issuer/authorize`) → pick *Demo customer* / *Demo admin* → back on `/bookings` with a session cookie. The mock (`core/auth/mock-oidc.ts`) enforces PKCE S256, exact redirect_uri, single-use 60 s codes, and is refused in production. Tests: `tests/oidc-login.test.ts` (45), `tests/e2e/auth-and-approvals.spec.ts`.

## Agent delegation & human confirmation
Delegation = user-consented grant (`grantId`, scopes ⊆ `SCOPES`, expiry). Effective permission = scopes ∩ the delegating user's rights ∩ capability requirement (see `authorization.md`).

`AgentConfirmationGate` (`src/agents/policies/confirmation.ts`) holds a write until a **human** approves that exact action out-of-band:

1. Caller invokes a mutating capability → `428 confirmation_required` + `x-confirmation-id` (REST) / `confirmationId`, `approveUrl`, `approvalUrl` (MCP). Nothing executes. The gate stores `(subject, userId, capability, inputHash, bounded preview, expiresAt, status)`.
2. The human opens `<APP_URL>/approvals/{id}` (signed in; sees the capability and exact arguments; **Approve / Decline**) — or `GET /api/confirmations/{id}` (details, owner only; everyone else gets the same 404 as for an unknown id), `POST /api/confirmations/{id}/approve|decline` (session cookie + CSRF, or a REST-audience user bearer token). Agents, other users and admins-for-others cannot decide. **An MCP-audience token is rejected on these endpoints**, so the model that holds it cannot approve its own action.
3. The caller retries the **identical** request with the id. Bound to (actor subject, capability, SHA-256 of the arguments), expires after 5 min, **single use** (spent/declined/foreign ⇒ 403). `Idempotency-Key` still applies on the retry.

Scope: REST gates agents holding `bookings:write` (`TRANSACTIONAL_SCOPES`); **MCP gates every write for every actor kind** (`check(..., {all:true})`) because the caller is a model even when it presents a user token. The former model-asserted `confirm=true` argument is gone — it was not a control. Abuse bounds: 10 pending per subject (429), expired rows evicted, global cap 10 000 (soft under heavy concurrency: one INSERT … WHERE count < cap, not a lock). Store: `PrismaConfirmationStore` (`AgentConfirmation`; the consume step is a compare-and-set UPDATE, so of N racing spenders exactly one wins — tested with 12) or in-memory (`AUTH_STORES=memory`).

## Protected Resource Metadata & challenges (RFC 9728 / MCP)
Checked against the **current MCP authorization spec (draft, fetched 2026-11-10; builds on OAuth 2.1 draft-13, RFC 9728, RFC 8707, RFC 6750)**:

* `GET /.well-known/oauth-protected-resource` (REST resource = origin) and `GET /.well-known/oauth-protected-resource/mcp` (MCP resource = `<origin>/mcp`, path-suffixed form per RFC 9728 §3.1). Fields: `resource`, `authorization_servers`, `scopes_supported`, `bearer_methods_supported: ["header"]`, `resource_name`. Public, CORS `*`, cacheable 5 min; unknown suffixes 404.
* `401`: `WWW-Authenticate: Bearer resource_metadata="<…>"` (plus `error="invalid_token"` + generic description for bad/expired tokens).
* `403` for a missing scope: `Bearer error="insufficient_scope", scope="<required scope>", resource_metadata="<…>"` (emitted by `enforce()` in the policy; the adapter adds `resource_metadata`).
* Tokens only via `Authorization: Bearer`, never in the query string. No token passthrough: audience must be this resource.
* `scope` is included in `insufficient_scope` challenges; the plain-401 challenge carries `resource_metadata` only (scope discovery via `scopes_supported`).
* Out of scope here (authorization server concerns): client registration (CIMD/DCR), PKCE, `iss` validation (RFC 9207). The authorization server/IdP must support them for MCP clients.

## Rate limiting, size limits, replay
`src/core/security/`:
* `createRateLimiter({store, limit, windowMs})` + `PrismaRateLimitStore` (default; one atomic `INSERT … ON CONFLICT DO UPDATE` per hit, shared by all instances, expired windows swept; a database error propagates ⇒ **fails closed**) or `InMemoryRateLimitStore` (bounded, fails closed when full; `AUTH_STORES=memory`). REST: per subject (`RATE_LIMIT_AUTH_PER_MIN`, default 240) and per client for anonymous (`RATE_LIMIT_ANON_PER_MIN`, 60); failed authentications consume a separate `authfail:<client>` bucket at the anonymous limit, so a bad-token flood cannot exhaust legitimate anonymous budgets. The in-memory store is bounded and **fails closed**: when full of live windows, new keys are rejected (429) instead of evicting live counters, so key churn cannot reset a limit. Anonymous clients are keyed by `x-forwarded-for` **only if `TRUST_PROXY=true`**, else all anonymous callers share one bucket (`ip:unknown`) — one noisy anonymous client can then throttle the others, so **set `TRUST_PROXY=true` behind a trusted proxy that overwrites the header**. 429 + `Retry-After` + `RateLimit-*` headers. Memory mode ⇒ per-instance limits.
* `readBodyWithLimit(request, maxBytes, {requireJson})`: counts streamed bytes (content-length can lie), 413 / 415. REST uses `MAX_BODY_BYTES` (default 64 KiB).
* `ReplayGuard.consume(jti, expiresAt)`: single-use ids (`PrismaReplayGuard`: conditional upsert, first of N concurrent callers wins; an expired id is reusable). Access tokens are reusable bearer credentials by design (bounded by short `exp`, audience, grant revocation); single-use semantics apply to confirmations (and are available for nonces/one-time tokens).
* Errors are generic problem+json: no verification internals, no stack traces; 401 detail is "The access token is invalid/has expired."

## Guide for adapters (REST / MCP) — as built
`/mcp` (`src/agents/mcp/server.ts`) and REST (`src/api/rest.ts`) are the reference: resolve the actor once per request with `resolveActor(request, {resource})`, decorate auth errors with `decorateAuthError`, run the shared rate limiter, then `getAgentGate().check(actor, cap, rawInput, confirmationId, {all})` before `executor.invoke(...)`. `createMcpHandler` **requires** a gate (it throws at construction without one: writes must never be reachable without human approval). Never read credentials outside `resolveActor`; never accept a REST-audience token on MCP; scopes live only in `SCOPES`.

## Configuration summary
`AUTH_ISSUER`, `AUTH_JWKS_URI`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES`, `AUTH_STORES` (`postgres` default; `memory` refused in production), `MOCK_ISSUER_ENABLED`, `SESSION_SECRET`, `TRUST_PROXY`, `RATE_LIMIT_*`, `MAX_BODY_BYTES` (all in `core/env.ts` and `.env.example`). Production requires `AUTH_ISSUER` + `SESSION_SECRET`, forbids `DEV_AUTH_ENABLED` and `MOCK_ISSUER_ENABLED`.
