import { defaultResolver } from "@/api/rest";
import { createMcpHandler } from "@/agents/mcp/server";
import { getEnv } from "@/core/env";
import { getRuntime } from "@/runtime";

export const dynamic = "force-dynamic";

/** Remote MCP server (Streamable HTTP, stateless). All behaviour lives in src/agents/mcp; this file only wires it. */
const handler = createMcpHandler({ runtime: getRuntime, resolver: defaultResolver, appUrl: () => getEnv().APP_URL });

export const POST = handler;
export const GET = handler; // → 405 (stateless)
export const DELETE = handler; // → 405
