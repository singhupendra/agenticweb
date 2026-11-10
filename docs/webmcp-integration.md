# WebMCP integration (progressive enhancement)

## Spec status (verified 2026-11-10)
WebMCP is a W3C Web Machine Learning Community Group **Draft Community Group Report** (9 Nov 2026), not a W3C Standard. Verified against <https://webmachinelearning.github.io/webmcp/>:
* Entry point is **`document.modelContext`** (`[SecureContext]`). Earlier drafts and older guides use `navigator.modelContext`; secondary sources say Chrome deprecated that name (v150). We detect both, preferring `document`.
* API: `registerTool(tool, { signal })` (unregister by aborting the signal), `getTools()`, `executeTool()`. Tool: `name` (1–128 chars of `A-Za-z0-9_.-`), `description`, optional `inputSchema`/`outputSchema` (JSON Schema), `execute(input, { signal })` returning a promise, optional `annotations` (`readOnlyHint`, `untrustedContentHint`, `consequentialHint`).
* Not found in the spec text we could read (first ~100k chars of ~160k): `provideContext`, `unregisterTool`, `requestUserInteraction`, declarative form attributes. **We do not use them.** Older tutorials that show them are out of date or describe polyfills.
* Browser support: Chrome only (flag/origin trial) per secondary sources; others need a polyfill (e.g. MCP-B). **Nothing here depends on native support.** Re-verify before relying on it.

## What we ship
* `buildWebMcpManifest` (server, `src/agents/discovery/webmcp.ts`) derives tools from the capability registry via `listTools` (same Zod → JSON Schema as MCP). No hand-written tools. `orgSlug` is defaulted; the idempotency key is optional (auto-generated).
* `registerWebMcp` (client) feature-detects and registers; **strict no-op** if unsupported. Each registration is isolated in try/catch; cleanup aborts the signal.
* Execution calls the **same REST endpoints** (`/api/organizations/...`) with `credentials: "same-origin"`, so authentication and authorization are exactly those of the signed-in visitor. No token handling in WebMCP code.
* Auth-aware tool set: anonymous visitors get read-only tools only; user/admin sessions also get booking tools.
* Human in the loop: mutating tools (`consequentialHint: true`) ask the user to confirm via `window.confirm` with the exact arguments before any request. Declining returns `{error:{code:"user_declined"}}` and sends nothing.
* Tool descriptions are static registry text (never user content), per the tool-poisoning rule in CONTRACTS.md. Tool *results* are API data and must be treated as untrusted by the calling agent.

## Tests
`tests/discovery/webmcp.test.ts` (derivation, request building, no-op, confirmation, errors) and `tests/e2e/webmcp.spec.ts` (page works with WebMCP absent; polyfill registration, REST parity, confirmation flow).

## Limits / follow-ups
Confirmation uses a native dialog (simple, accessible, blocking); a custom in-page dialog is a possible UX upgrade. The polyfill in the E2E test implements only `registerTool` + signal, matching the draft.
