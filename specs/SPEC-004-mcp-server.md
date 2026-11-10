# SPEC-004 — Remote MCP server

Status: implemented (OAuth token verification pending SPEC-003 authn PR)

## Requirements
1. `POST /mcp` serves MCP over Streamable HTTP, stateless; tools are derived from the capability registry (no hand-written tools).
2. Tools: org info, list/get services, slots (availability), list/get bookings, create/update/cancel booking.
3. Each tool: unique name, static description, Zod-derived input/output JSON Schema, annotations, structured output.
4. Writes require `idempotencyKey` and `confirm: true`; authorization and audit via the executor.
5. Errors are RFC 9457 problems returned as `isError` results; timeouts and unexpected errors do not leak internals.
6. Protected calls without credentials → 401 + `WWW-Authenticate` with RFC 9728 `resource_metadata`; no token passthrough.
7. Tool output with website/user text is sanitised, length-limited and flagged untrusted.

## Acceptance criteria
* Given an anonymous client, when it lists tools and calls a public tool, then it succeeds with schema-valid structuredContent.
* Given an anonymous client, when it calls `list_my_bookings`, then HTTP 401 with resource metadata challenge.
* Given a write without `confirm: true`, then nothing executes.
* Given a retried `create_booking` with the same key, then one booking exists; a new key for the same slot → `conflict`.
* Given injected control/markup text in a service name, then the output contains none of it and tool descriptions are unchanged.
* REST and MCP return identical `code/status` for the same failing capability.
Tests: `tests/mcp/*`.
