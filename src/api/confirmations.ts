/**
 * Adapters for the HUMAN side of an agent's pending write: show it, approve it, decline it. No logic: actor → gate.
 * Identity comes from `resolveActor` (REST audience), so an MCP-audience token — the one a model holds — is rejected here,
 * and cookie sessions need CSRF proof on POST. Agents can never decide (the gate refuses non-human actors).
 */
import { randomUUID } from "node:crypto";
import { decorateAuthError, resolveActor, resourceUri, type Actor } from "@/core/auth";
import { getEnv } from "@/core/env";
import { problemResponse } from "@/core/errors";
import { getAgentGate, type AgentConfirmationGate } from "@/agents/policies";

export interface ConfirmationDeps {
  resolver: () => { resolve(request: Request): Promise<Actor> };
  gate: () => AgentConfirmationGate;
  appUrl: () => string;
}
const DEFAULTS: ConfirmationDeps = { resolver: () => ({ resolve: (r) => resolveActor(r) }), gate: getAgentGate, appUrl: () => getEnv().APP_URL };
type Ctx = { params: Promise<{ id: string }> };

function handler(run: (gate: AgentConfirmationGate, id: string, actor: Actor) => Promise<unknown>) {
  return async (request: Request, ctx: Ctx, deps: ConfirmationDeps = DEFAULTS): Promise<Response> => {
    const requestId = randomUUID();
    try {
      const actor = await deps.resolver().resolve(request);
      const { id } = await ctx.params;
      const data = await run(deps.gate(), id, actor);
      return Response.json({ data, meta: { requestId } }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      return problemResponse(decorateAuthError(e, resourceUri(deps.appUrl(), "rest")), { requestId });
    }
  };
}

export const describeConfirmation = handler((gate, id, actor) => gate.describe(id, actor));
export const approveConfirmation = handler(async (gate, id, actor) => { await gate.approve(id, actor); return { id, status: "approved" }; });
export const declineConfirmation = handler(async (gate, id, actor) => { await gate.decline(id, actor); return { id, status: "denied" }; });
