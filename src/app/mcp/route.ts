import { defaultRateLimiting } from "@/api/rest";
import { createMcpHandler } from "@/agents/mcp/server";
import { getAgentGate } from "@/agents/policies";
import { resolveActor } from "@/core/auth";
import { getEnv } from "@/core/env";
import { getRuntime } from "@/runtime";

export const dynamic = "force-dynamic";

/**
 * Remote MCP server (Streamable HTTP, stateless). All behaviour lives in src/agents/mcp; this file only wires it.
 * Identity: `resolveActor(..., {resource:"mcp"})` → bearer tokens must be minted for <origin>/mcp (RFC 8707). Shares the
 * REST rate-limit buckets so an agent cannot double its budget by switching channel.
 */
const handler = createMcpHandler({
  runtime: getRuntime,
  resolver: () => ({ resolve: (r) => resolveActor(r, { resource: "mcp" }) }),
  appUrl: () => getEnv().APP_URL,
  rateLimit: (c) => defaultRateLimiting().rateLimit?.(c),
  authFailure: (r) => defaultRateLimiting().authFailure?.(r),
  gate: getAgentGate,
});

export const POST = handler;
export const GET = handler; // → 405 (stateless)
export const DELETE = handler; // → 405
