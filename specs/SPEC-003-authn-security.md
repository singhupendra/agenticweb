# SPEC-003 Authentication, delegation and request hardening (Phase 3)
Status: implemented (see docs/authentication.md, docs/authorization.md; evidence in docs/implementation-plan.md)

## Acceptance criteria (each covered by tests named in the tracker)
1. `resolveActor(request, {resource})` is the only identity input for all channels; invalid bearer credentials → 401, never anonymous.
2. Bearer JWTs verified via JWKS: signature (asymmetric only), issuer, audience (REST `<origin>`, MCP `<origin>/mcp`), expiry, jti/iat required; wrong audience / expired / forged / `alg=none` / HS256 → 401 with generic body.
3. Agent tokens: bound to a user and grant, ≤1 h, scopes ∩ grant scopes (never widened), unknown scopes grant nothing, revoked grant → 401, never admin.
4. Sessions: HttpOnly SameSite=Lax cookie; unsafe cookie requests require session-bound CSRF token and same Origin; session cookie is not a valid bearer token.
5. Transactional agent scopes require a single-use, input-bound, expiring human confirmation; only the delegating human can approve.
6. `/.well-known/oauth-protected-resource[/mcp]` (RFC 9728); 401 → `WWW-Authenticate: Bearer resource_metadata=…`; missing scope → 403 `insufficient_scope` with `scope`.
7. Rate limiting (pluggable store), request-size and content-type limits, replay guard; safe problem+json errors.
8. Authorization matrix (role × capability × resource owner) incl. IDOR, expiry, audience, scope escalation, replay.
9. Production env validation requires `AUTH_ISSUER` + `SESSION_SECRET` and forbids dev header auth and the mock issuer.

## Known gaps
Persistent GrantStore/consent UI, OIDC code-flow login redirect, durable confirmation and rate-limit stores, MCP wiring (Phase 4).
