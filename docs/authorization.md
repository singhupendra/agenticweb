# Authorization (Phase 3)

Authorization is decided in exactly one place: `DefaultPolicy.decide(actor, requirement, resource)` (`src/core/authorization/policy.ts`), called by the capability executor. Routes, MCP and UI never decide.

Rules (in order):
1. **Agent gate:** delegation must be unexpired (else 401), carry the capability's scope (else 403 `insufficient_scope`, with the required scope in the challenge), and can never satisfy `admin`.
2. `public` → allow. Otherwise a user identity is required (anonymous / public-only agent ⇒ 401).
3. **Tenant isolation:** resource in another organization ⇒ 404.
4. `authenticated` → allow; `admin` → admin actors only; `owner-or-admin` → owner (effective user: for an agent, the *delegating* user) or an `admin` actor; non-owner ⇒ **404** (indistinguishable from a missing resource — IDOR).
5. An agent delegated by an admin user is still not admin: it acts only as that user's own resources.
6. Agent-specific layers (`src/agents/policies`): per-action human confirmation for transactional scopes (see `authentication.md`).

## Matrix
`tests/authz-matrix.test.ts` runs 13 actor profiles × 6 capabilities through the real executor with a booking owned by the "owner" user (78 explicit expectations: ok / unauthenticated / forbidden / not_found), plus checks that every registered capability is covered, agent-exposed capabilities declare scopes and none is admin, IDOR responses are byte-identical to missing-resource responses, and denials are audited.
`tests/auth-http.test.ts` repeats the critical cases end-to-end over HTTP with real signed tokens: IDOR, expired token, wrong audience, scope escalation (token claims more than the grant), revoked grant, replayed/other-input confirmation, CSRF, rate limit, oversize body.

Adding a capability: add its row/column to the matrix (the coverage test fails otherwise), give it a `requirement`, and for id-addressed resources a `loadResource`.
