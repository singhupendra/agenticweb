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

**Grants (revocation + narrowing).** If a `GrantStore` is wired (`setGrantStore()` before first request; `InMemoryGrantStore` provided), it is authoritative: unknown/revoked grant, wrong client or wrong user ⇒ 401; effective scopes = token scopes ∩ grant scopes (never widens). Without a store, token claims are trusted as issued by the IdP and revocation is only via `exp` (**gap: no persistent grant table yet; needs a Prisma model — owned by whoever adds the consent UI**).

### Local dev / tests without an IdP
`MOCK_ISSUER_ENABLED=true` (refused in production) runs an in-process ES256 issuer: `GET /api/dev/mock-issuer/jwks`, `POST /api/dev/mock-issuer/token` with `{kind: user|admin|agent, userId, organizationId, scopes, resource: rest|mcp, expiresInSec}` → `{access_token}`. In tests use `MockIssuer` (`src/core/auth/mock-issuer.ts`) + `tests/fixtures/auth.ts` (`authKit`).

## Human sessions & CSRF
`SessionManager` (`session.ts`): HS256 JWT in an `HttpOnly; SameSite=Lax; Path=/` cookie (`__Host-session` + `Secure` when `APP_URL` is https), 8 h TTL, `SESSION_SECRET` ≥ 32 chars (required in production). The cookie is a different token class from bearer tokens (symmetric, own issuer/audience) — it is rejected as a bearer token. CSRF: unsafe cookie-authenticated requests need `x-csrf-token` = HMAC(secret, session id) (returned by `create()`, bound to the session) **and**, if an `Origin` header is sent, it must equal the app origin. Bearer requests are not CSRF-prone. Issuing a session after an OIDC login redirect is the UI's job (call `sessions.create(...)` with the verified identity); the authorization-code login flow itself is **not** implemented here (gap, Frontend).

## Agent delegation & confirmation
Delegation = user-consented grant (`grantId`, scopes ⊆ `SCOPES`, expiry). Effective permission = scopes ∩ the delegating user's rights ∩ capability requirement (see `authorization.md`).
Transactional scopes (`TRANSACTIONAL_SCOPES = ["bookings:write"]`, `src/agents/policies/confirmation.ts`) additionally require a **per-action human confirmation**:

1. Agent calls the mutating capability → `428 confirmation_required` + header `x-confirmation-id`. Nothing executes.
2. The delegating **human** approves: `POST /api/confirmations/{id}/approve` (session cookie + CSRF, or a user bearer token). Agents, other users and admins-for-others cannot approve.
3. Agent retries the **identical** request with `x-confirmation-id`. A confirmation is bound to (agent subject, capability, input hash), expires after 5 min and is **single use** (replay ⇒ 403). The normal `Idempotency-Key` still applies.

Abuse bounds: max 10 pending confirmations per agent subject (429 beyond), expired entries are evicted, global cap 10 000. Store is in-memory (`ConfirmationStore` is pluggable; **gap: not durable across restarts/instances**).

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
* `createRateLimiter({store, limit, windowMs})` + `InMemoryRateLimitStore` (bounded, pluggable `RateLimitStore` for Redis/Postgres). REST: per subject (`RATE_LIMIT_AUTH_PER_MIN`, default 240) and per client for anonymous (`RATE_LIMIT_ANON_PER_MIN`, 60); failed authentications consume a separate `authfail:<client>` bucket at the anonymous limit, so a bad-token flood cannot exhaust legitimate anonymous budgets. The in-memory store is bounded and **fails closed**: when full of live windows, new keys are rejected (429) instead of evicting live counters, so key churn cannot reset a limit. Anonymous clients are keyed by `x-forwarded-for` **only if `TRUST_PROXY=true`**, else all anonymous callers share one bucket (`ip:unknown`) — one noisy anonymous client can then throttle the others, so **set `TRUST_PROXY=true` behind a trusted proxy that overwrites the header**. 429 + `Retry-After` + `RateLimit-*` headers. In-memory ⇒ per-instance limits.
* `readBodyWithLimit(request, maxBytes, {requireJson})`: counts streamed bytes (content-length can lie), 413 / 415. REST uses `MAX_BODY_BYTES` (default 64 KiB).
* `ReplayGuard.consume(jti, expiresAt)`: single-use ids. Access tokens are reusable bearer credentials by design (bounded by short `exp`, audience, grant revocation); single-use semantics apply to confirmations (and are available for nonces/one-time tokens).
* Errors are generic problem+json: no verification internals, no stack traces; 401 detail is "The access token is invalid/has expired."

## Guide for the MCP worker (Phase 4)

```ts
import { resolveActor, decorateAuthError, resourceUri } from "@/core/auth";
import { getAgentGate } from "@/agents/policies";
import { problemResponse } from "@/core/errors";

// in the /mcp HTTP handler, for EVERY request (auth is per request, not per session):
try {
  const actor = await resolveActor(request, { resource: "mcp" });      // audience = <origin>/mcp
  // tools/call: derive capability + raw input, then
  await getAgentGate().check(actor, cap, rawInput, confirmationIdFromToolArg);   // transactional scopes
  const envelope = await executor.invoke(cap.name, actor, rawInput, { requestId, idempotencyKey });
} catch (e) {
  return problemResponse(decorateAuthError(e, resourceUri(appUrl, "mcp")), { requestId }); // adds resource_metadata
}
```

Rules:
1. Never read `Authorization`/cookies yourself; never accept a REST-audience token (use `resource: "mcp"`). Cookie auth works only on same-origin browser requests; MCP clients use bearer tokens.
2. Unauthenticated `initialize`/`tools/list` may be served anonymously (public tools only: filter the list by `actor` scopes); a protected `tools/call` without credentials must return **HTTP 401** with the challenge above so clients can run discovery.
3. Map a `confirmation_required` (428) problem to a tool result with `isError: true` including the confirmation id and the instruction that **the human** must approve at `POST /api/confirmations/{id}/approve`; the agent then retries the same call with `x-confirmation-id` (expose it as an optional tool argument `confirmationId`; derive it from the schema, don't hand-write).
4. Insufficient scope ⇒ HTTP 403 + `insufficient_scope` challenge (already produced by `enforce`).
5. Apply the shared limiter (`createRateLimiter`) per `actorSubject(actor)` and `readBodyWithLimit` on the transport body; Origin-validate Streamable HTTP (DNS rebinding) — not done by `resolveActor`.
6. `scopes_supported` in metadata comes from `SCOPES`; add new scopes there (and to the matrix test) only.

## Configuration summary
`AUTH_ISSUER`, `AUTH_JWKS_URI`, `MOCK_ISSUER_ENABLED`, `SESSION_SECRET`, `TRUST_PROXY`, `RATE_LIMIT_*`, `MAX_BODY_BYTES` (all in `core/env.ts` and `.env.example`). Production requires `AUTH_ISSUER` + `SESSION_SECRET`, forbids `DEV_AUTH_ENABLED` and `MOCK_ISSUER_ENABLED`.
