# MCP server (`/mcp`)

Remote Model Context Protocol server, **Streamable HTTP, stateless** (SDK `@modelcontextprotocol/sdk` 1.32.2, verified current on npm 2026-11-10). One fresh protocol server per POST, JSON responses, no session id, so it scales horizontally and has no session to hijack. `GET`/`DELETE` → 405 (no server-initiated stream).

Code: `src/agents/mcp/server.ts` (transport only), `src/agents/mcp/sanitize.ts`, `src/agents/mcp/challenge.ts`, `src/agents/tools/derive.ts` (registry → tools), route `src/app/mcp/route.ts`. **No business logic here:** `tools/list` = `listTools(registry, actor)`; `tools/call` = `executor.invoke(...)` (validation → authz → idempotency → execute → output parse → audit).

## Tools (all derived from the capability registry)

| Tool | Capability | Access / scope | Kind |
|---|---|---|---|
| `get_organization` | `organization.get` | public · `services:read` | read |
| `list_services` (search: `q`, `maxPriceMinor`, `sort`) | `services.list` | public · `services:read` | read |
| `get_service` | `services.get` | public · `services:read` | read |
| `list_slots` (availability) | `slots.list` | public · `services:read` | read |
| `list_my_bookings` | `bookings.list` | authenticated · `bookings:read` | read |
| `get_booking` (status) | `bookings.get` | owner · `bookings:read` | read |
| `create_booking` | `bookings.create` | authenticated · `bookings:write` | write |
| `update_booking` (notes) | `bookings.update` | owner · `bookings:write` | write |
| `cancel_booking` | `bookings.cancel` | owner · `bookings:write` | write, `destructiveHint` |

Names follow the registry (`verb_noun`); they are not renamed to `search_services` / `check_availability` / `get_booking_status` so REST, WebMCP and MCP stay one vocabulary. `update_booking` was previously REST-only; it is now deliberately exposed (`mcp.exposed: true`) and goes through the same confirmation + idempotency rules as the other writes.

Every tool has a unique name, a **static** description (never built from stored content), a JSON-Schema `inputSchema` (from the Zod input, `z.toJSONSchema`) and `outputSchema` (from the Zod output), `structuredContent` matching it (plus the same JSON as a text block for clients without structured output), and annotations: `readOnlyHint` (= not mutating), `destructiveHint` (cancel only), `idempotentHint: true` (writes are idempotent per key), `openWorldHint: false`. Paginated results are `{items, page, pageSize, total}`.

### Writes
Mutating tools take a required `idempotencyKey` and an optional `confirmationId`:
* `idempotencyKey` (8–128 chars `[A-Za-z0-9_-]`): same key + same arguments replays the original result; same key + different arguments → `idempotency_key_reuse`; a *new* key for a slot the user already holds → `conflict` (DB unique index). Retry a timed-out write with the **same** key.
* **Human approval, always.** There is no model-settable "confirm" flag. Every write (any actor: agent *or* a user token) first returns an `isError` result `code: confirmation_required` (428) with `confirmationId`, `approvalUrl` (`<origin>/approvals/<id>`, the page the human opens) and `approveUrl` (REST `POST`). Nothing ran. The model shows the link to the human, waits for them to say they approved, then **retries with identical arguments plus `confirmationId`**. The approval is made in the human's own browser session, bound to (actor, tool, SHA-256 of the arguments, 5-minute expiry), shown to the human with the exact arguments, and **single use** (reuse, tampered arguments, another user, a declined or expired id ⇒ `forbidden`). The model's token is MCP-audience and is rejected by the approval endpoints, so it cannot approve itself. Details: `docs/authentication.md` § Agent delegation & human confirmation. Tests: `tests/mcp/mcp-server.test.ts`, `tests/confirmations-http.test.ts`, `tests/db/auth-stores.integration.test.ts`, `tests/e2e/auth-and-approvals.spec.ts`.

## Authentication & authorization (MCP authorization spec)
* `initialize`, `tools/list` and public tools work anonymously.
* A `tools/call` for a non-public tool without credentials → **HTTP 401** + `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"` (RFC 9728) so clients start OAuth discovery.
* A bad/expired token (resolver throws `unauthenticated`) → 401 with the same pointer; it is never silently downgraded to anonymous.
* Tokens must be audience-bound to this server (`<origin>/mcp`, RFC 8707): the route resolves with `resolveActor(request, {resource:"mcp"})`, so a REST-audience token is a 401 `invalid_token` (verified live). Protected-resource metadata is served by `/.well-known/oauth-protected-resource/mcp` (Security). The Authorization header is read only by the resolver and **never forwarded** (no token passthrough; a test asserts the secret never reaches the executor).
* Authorization is the executor's: agents get only scopes ∩ the delegating user's rights, others' bookings are `not_found`, no admin capability is exposed. `tools/list` hides tools outside the agent's scopes.
* Browser `Origin` other than the app origin → 403 (DNS-rebinding protection). Native clients send no `Origin`.
* Body ≤ 64 KiB (413), malformed JSON → 400 JSON-RPC parse error. The route shares REST's rate-limit buckets (`defaultRateLimiting`; failed auth uses its own bucket via `McpDeps.authFailure`); `McpDeps.rateLimit` runs per `tools/call` after the actor is known; a thrown `rate_limited` becomes HTTP 429 + `Retry-After`.

## Errors
Capability failures are returned as **tool results with `isError: true`**; the text content is the RFC 9457 problem JSON (`type`, `title`, `status`, `code`, `detail`, `errors[]`, `requestId`) — identical `code/status/title/type` to REST (parity test). Unknown tool = JSON-RPC `InvalidParams`. Unexpected errors are a generic `internal` problem (no message leak). Tool timeout (`timeoutMs`, default 10 s) → problem `timeout` (504); the underlying write may still have committed, so retry with the same `idempotencyKey`.

**Timeouts.** Each call has a deadline (`DEFAULT_TOOL_TIMEOUT_MS`, 10 s). On expiry the server aborts an `AbortController`, passes its `signal` through `executor.invoke(..., {signal})` into the capability context (`ctx.signal`, for anything cancellable) and returns a `timeout` (504) problem. The executor honours the signal **before** the capability starts (an already-aborted call never executes and its idempotency key is released, so a retry works); once a mutation has begun it is allowed to finish and be recorded (the result is stored under the key, so a retry with the SAME key replays it instead of double-booking). Prisma queries are not individually cancellable, so an in-flight database statement completes even when the caller has given up.

## Untrusted content
Service names/descriptions, organisation names and booking notes are website/user text. Defences: (1) tool descriptions are static; (2) **free-text** result fields are sanitised (`sanitizeBySchema`, driven by each capability's own output JSON Schema — no hand-kept field list): control, zero-width, bidi and tag characters removed, `<` `>` `` ` `` neutralised, each string capped at 500 chars. Strings the schema pins (`format`/`pattern`/`enum`/`const`: ids, slugs, timestamps, statuses) are returned byte-for-byte, because rewriting them could only corrupt values the client must echo back; fields the schema does not describe are sanitised (fail safe). In error results only `detail` and `errors[].message` are sanitised; (3) every result carries `_meta["agenticweb/untrusted"] = true` and the server `instructions` say to treat results as data; (4) no free-text field is promoted into tool metadata or argument defaults. This reduces, but cannot eliminate, prompt injection — keep the confirmation requirement on writes.

## Audit & observability
Mutations and denials are audited by the executor (actor subject = `agent:<client>:<user>:<grant>`, hash of input). Each tool call also logs `mcp tool call` (tool, capability, outcome, code, durationMs, actor). `McpDeps.metrics.toolCall` is the hook for OTel counters/histograms (DevOps helpers not yet merged; wire them there).

## Connect

Local dev (dev-only `x-dev-actor`, requires `DEV_AUTH_ENABLED=true`, refused in production):
```bash
pnpm db:deploy && pnpm db:seed
DEV_AUTH_ENABLED=true APP_URL=http://localhost:3000 pnpm dev      # MCP at http://localhost:3000/mcp
```
Seeded ids: org `northwind-studio` (`00000000-0000-4000-8000-0000000000a1`), customer `00000000-0000-4000-8000-0000000000b2`.

**Claude Code**
```bash
# public read-only
claude mcp add --transport http agenticweb http://localhost:3000/mcp
# acting for the seeded customer (dev header; production uses OAuth bearer tokens instead)
claude mcp add --transport http agenticweb-dev http://localhost:3000/mcp \
  --header "x-dev-actor: agent|claude-code|00000000-0000-4000-8000-0000000000b2|00000000-0000-4000-8000-0000000000a1|services:read,bookings:read,bookings:write"
claude mcp list
```
(With real auth: `claude mcp add --transport http agenticweb https://<host>/mcp` then `/mcp` in Claude Code to run the OAuth flow, or pass `--header "Authorization: Bearer <token>"`.) The `claude mcp add` forms follow `claude mcp add --help` for the installed CLI; they were not executed against the local config in this session.

**MCP Inspector CLI** (verified against the running app)
```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http --method tools/list
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http \
  --header "x-dev-actor: agent|inspector|00000000-0000-4000-8000-0000000000b2|00000000-0000-4000-8000-0000000000a1|services:read" \
  --method tools/call --tool-name get_organization --tool-arg orgSlug=northwind-studio
# UI: npx @modelcontextprotocol/inspector   (Transport: Streamable HTTP, URL http://localhost:3000/mcp)
```

**SDK client**
```ts
const client = new Client({ name: "me", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp"), { requestInit: { headers: { "x-dev-actor": "…" } } }));
await client.callTool({ name: "create_booking", arguments: { orgSlug: "northwind-studio", slotId, idempotencyKey: crypto.randomUUID() } });
// → isError result {code:"confirmation_required", confirmationId, approvalUrl}. Show approvalUrl to the human; once they approve:
// await client.callTool({ name: "create_booking", arguments: { …same arguments…, confirmationId } });
```

## Tests
`tests/mcp/*` (incl. the confirmation gate) run the real SDK client over a real HTTP server around `createMcpHandler`: discovery and schema validity (Ajv), execution + structured output, REST parity, invalid args, authn (401 challenge, bad token, no passthrough), authz (scope, public-only agent, IDOR), confirmation, idempotent replay and duplicate-booking prevention, update/cancel lifecycle + audit, prompt-injection sanitisation, timeout, Origin/method/body-size hardening, rate-limit and metrics hooks.

## Local OAuth-style walkthrough (mock issuer, dev only)
```bash
MOCK_ISSUER_ENABLED=true SESSION_SECRET=<32+ chars> APP_URL=http://localhost:3000 pnpm dev
TOKEN=$(curl -s localhost:3000/api/dev/mock-issuer/token -H 'content-type: application/json' \
  -d '{"kind":"agent","userId":"<user>","organizationId":"<org>","scopes":["services:read","bookings:read","bookings:write"],"resource":"mcp"}' | jq -r .access_token)
claude mcp add --transport http agenticweb-dev http://localhost:3000/mcp --header "Authorization: Bearer $TOKEN"
```
(`resource` must be `mcp`; see `docs/authentication.md`.)
