/**
 * Derive MCP tool descriptors from the capability registry (no hand-written tools).
 * The MCP server (Phase 4) maps `tools/list` → listTools(actor) and `tools/call` → executor.invoke(tool.capability, ...).
 */
import { z } from "zod";
import type { Actor } from "@/core/auth";
import type { CapabilityRegistry } from "@/core/capabilities";

export interface McpToolDescriptor {
  name: string;
  capability: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
}

export const IDEMPOTENCY_ARG = "idempotencyKey";

export function listTools<Deps>(registry: CapabilityRegistry<Deps>, actor: Actor): McpToolDescriptor[] {
  return registry
    .all()
    .filter((c) => c.mcp.exposed)
    .filter((c) => actor.kind !== "agent" || !c.requirement.scope || actor.delegation.scopes.includes(c.requirement.scope))
    .map((c) => {
      const input = z.toJSONSchema(c.input, { io: "input" }) as Record<string, unknown>;
      if (c.mutating) {
        const props = (input.properties ??= {}) as Record<string, unknown>;
        props[IDEMPOTENCY_ARG] = { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" };
        input.required = [...((input.required as string[] | undefined) ?? []), IDEMPOTENCY_ARG];
      }
      return {
        name: c.mcp.toolName,
        capability: c.name,
        description: c.mcp.description ?? c.summary,
        inputSchema: input,
        outputSchema: z.toJSONSchema(c.output, { io: "output" }) as Record<string, unknown>,
        annotations: { readOnlyHint: !c.mutating, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      };
    });
}
