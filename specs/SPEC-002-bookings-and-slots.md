# SPEC-002 Bookings and slots (Phase 2 backend)
Status: implemented (criteria 1-8 covered by tests/bookings.test.ts and tests/db; replay is not audited)

## Capabilities
| name | REST | access / scope | mutating |
|---|---|---|---|
| `slots.list` | GET `/api/organizations/{orgSlug}/services/{serviceSlug}/slots` | public / `services:read` | no |
| `bookings.create` | POST `/api/organizations/{orgSlug}/bookings` (201) | authenticated / `bookings:write` | yes |
| `bookings.list` | GET `/api/organizations/{orgSlug}/bookings` | authenticated / `bookings:read` (own only) | no |
| `bookings.get` | GET `/api/organizations/{orgSlug}/bookings/{bookingId}` | owner-or-admin / `bookings:read` | no |
| `bookings.cancel` | POST `/api/organizations/{orgSlug}/bookings/{bookingId}/cancel` | owner-or-admin / `bookings:write` | yes |

## Acceptance criteria
1. `slots.list` returns only future slots of an active service with `remaining > 0`, ordered by `startsAt`, paginated; optional `from`/`to` filters; unknown org/service → 404.
2. `bookings.create`: requires an Idempotency-Key; booking is `confirmed`; user and organization come from the actor, never input; unknown/other-org slot → 404; slot in the past → 409 `conflict`; slot full → 409 `conflict`; the same user already holding an active booking on the slot → 409.
3. Overbooking is impossible: N concurrent creates for a capacity-1 slot yield exactly 1 success and N-1 conflicts (verified against Postgres).
4. Replay of the same key + payload returns the first result without a second booking; same key, different payload → 422 (durable Postgres-backed store).
5. `bookings.list` returns only the actor's own bookings. `bookings.get`/`cancel` by a non-owner → 404; admin may access any booking in the org; other-organization → 404.
6. `bookings.cancel`: owner-or-admin; cancelling frees capacity; already-cancelled returns the cancelled booking (idempotent); slot already started → 409.
7. Mutations and denials produce rows in the Postgres `AuditEvent` table (hash of input, no raw input).
8. REST and MCP-derived tool descriptors exist for all five (parity via registry).
