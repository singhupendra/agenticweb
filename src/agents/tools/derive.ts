/**
 * Derive MCP tool descriptors from the capability registry (no hand-written tools).
 * The MCP server (`src/agents/mcp`) maps `tools/list` → listTools(actor) and `tools/call` → executor.invoke(tool.capability, ...).
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
/** Out-of-band human approval id (`AgentConfirmationGate`): returned by a first attempt, approved by the user, then passed on retry. */
export const CONFIRMATION_ID_ARG = "confirmationId";

export interface ListToolsOptions {
  /** Remote MCP: writes need a human-bound out-of-band confirmation (see `AgentConfirmationGate`), so advertise `confirmationId`. */
  humanConfirmation?: boolean;
}

export function listTools<Deps>(registry: CapabilityRegistry<Deps>, actor: Actor, opts: ListToolsOptions = {}): McpToolDescriptor[] {
  return registry
    .all()
    .filter((c) => c.mcp.exposed)
    .filter((c) => actor.kind !== "agent" || !c.requirement.scope || actor.delegation.scopes.includes(c.requirement.scope))
    .map((c) => {
      const input = z.toJSONSchema(c.input, { io: "input" }) as Record<string, unknown>;
      if (c.mutating) {
        const props = (input.properties ??= {}) as Record<string, unknown>;
        props[IDEMPOTENCY_ARG] = {
          type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$",
          description: "Unique key for this action (8-128 chars). Reuse the SAME key when retrying; never reuse it for a different action.",
        };
        const extra = [IDEMPOTENCY_ARG];
        if (opts.humanConfirmation) {
          props[CONFIRMATION_ID_ARG] = {
            type: "string", minLength: 8, maxLength: 64, pattern: "^[A-Za-z0-9-]+$",
            description: "Only after a call returned `confirmation_required`: its confirmationId once the user has approved it. Retry with identical arguments.",
          };
        }
        input.required = [...((input.required as string[] | undefined) ?? []), ...extra];
      }
      return {
        name: c.mcp.toolName,
        capability: c.name,
        description: c.mcp.description ?? c.summary,
        inputSchema: input,
        outputSchema: z.toJSONSchema(c.output, { io: "output" }) as Record<string, unknown>,
        annotations: { readOnlyHint: !c.mutating, destructiveHint: c.mcp.destructive === true, idempotentHint: true, openWorldHint: false },
      };
    });
}
