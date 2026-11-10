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
Mutating tools take two extra required arguments:
* `idempotencyKey` (8–128 chars `[A-Za-z0-9_-]`): same key + same arguments replays the original result; same key + different arguments → `idempotency_key_reuse`; a *new* key for a slot the user already holds → `conflict` (DB unique index). Retry a timed-out write with the **same** key.
* `confirm: true` — must be literally `true`, otherwise nothing runs (`validation_failed`, path `confirm`). The server `instructions` and the argument description tell the model to set it only after the human approved that exact action. This is a best-effort gate (a model can lie); the hard controls are the delegated scope, the owner check and idempotency. Security's out-of-band confirmation (`src/agents/policies/confirmation.ts`, PR #5) is the stronger gate to wire in when it lands.

## Authentication & authorization (MCP authorization spec)
* `initialize`, `tools/list` and public tools work anonymously.
* A `tools/call` for a non-public tool without credentials → **HTTP 401** + `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"` (RFC 9728) so clients start OAuth discovery.
* A bad/expired token (resolver throws `unauthenticated`) → 401 with the same pointer; it is never silently downgraded to anonymous.
* Tokens must be audience-bound to this server (`<origin>/mcp`, RFC 8707). Verification lives in the `ActorResolver` (Security PR #5: `resolveActor(request, {resource:"mcp"})`). The Authorization header is read only by the resolver and **never forwarded** (no token passthrough; a test asserts the secret never reaches the executor).
* Authorization is the executor's: agents get only scopes ∩ the delegating user's rights, others' bookings are `not_found`, no admin capability is exposed. `tools/list` hides tools outside the agent's scopes.
* Browser `Origin` other than the app origin → 403 (DNS-rebinding protection). Native clients send no `Origin`.
* Body ≤ 64 KiB (413), malformed JSON → 400 JSON-RPC parse error. A rate-limit hook (`McpDeps.rateLimit`, same contract as REST) runs per `tools/call` after the actor is known; a thrown `rate_limited` becomes HTTP 429 + `Retry-After`.

## Errors
Capability failures are returned as **tool results with `isError: true`**; the text content is the RFC 9457 problem JSON (`type`, `title`, `status`, `code`, `detail`, `errors[]`, `requestId`) — identical `code/status/title/type` to REST (parity test). Unknown tool = JSON-RPC `InvalidParams`. Unexpected errors are a generic `internal` problem (no message leak). Tool timeout (`timeoutMs`, default 10 s) → problem `timeout` (504); the underlying write may still have committed, so retry with the same `idempotencyKey`.

## Untrusted content
Service names/descriptions, organisation names and booking notes are website/user text. Defences: (1) tool descriptions are static; (2) results are sanitised (`sanitizeUntrusted`): control, zero-width, bidi and tag characters removed, `<` `>` `` ` `` neutralised, each string capped at 500 chars; (3) every result carries `_meta["agenticweb/untrusted"] = true` and the server `instructions` say to treat results as data; (4) no free-text field is promoted into tool metadata or argument defaults. This reduces, but cannot eliminate, prompt injection — keep the confirmation requirement on writes.

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
await client.callTool({ name: "create_booking", arguments: { orgSlug: "northwind-studio", slotId, idempotencyKey: crypto.randomUUID(), confirm: true } });
```

## Tests
`tests/mcp/*` run the real SDK client over a real HTTP server around `createMcpHandler`: discovery and schema validity (Ajv), execution + structured output, REST parity, invalid args, authn (401 challenge, bad token, no passthrough), authz (scope, public-only agent, IDOR), confirmation, idempotent replay and duplicate-booking prevention, update/cancel lifecycle + audit, prompt-injection sanitisation, timeout, Origin/method/body-size hardening, rate-limit and metrics hooks.

## After Security PR #5 merges
Replace `defaultResolver()` in `src/app/mcp/route.ts` with `resolveActor(request, {resource:"mcp"})`, `authChallenge` with `decorateAuthError`, and consider requiring the out-of-band confirmation for writes.
