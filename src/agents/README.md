# src/agents

Agent-facing transport adapters. **No business logic.**

- `tools/` — derive MCP tool descriptors from the capability registry (implemented, tested).
- `mcp/` — remote Streamable-HTTP MCP server, stateless (see `docs/mcp-integration.md`): `tools/list` = `listTools(actor)`, `tools/call` = `executor.invoke`.
- `discovery/` — `llms.txt`, `/.well-known/*`, OpenAPI generation (Phase 4); WebMCP registration (Phase 5).
- `policies/` — agent-specific policy (rate limits, quotas, consent prompts) layered on `core/authorization` (Phase 3/4).
