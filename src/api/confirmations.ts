/** Adapter for the human approval of an agent's pending transactional action. No logic: actor → gate.approve. */
import { randomUUID } from "node:crypto";
import { decorateAuthError, resolveActor, resourceUri } from "@/core/auth";
import { getEnv } from "@/core/env";
import { problemResponse } from "@/core/errors";
import { getAgentGate } from "@/agents/policies";

export async function approveConfirmation(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  try {
    const actor = await resolveActor(request); // cookie sessions need x-csrf-token; bearer user tokens work too
    const { id } = await ctx.params;
    await getAgentGate().approve(id, actor);
    return Response.json({ data: { id, status: "approved" }, meta: { requestId } }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return problemResponse(decorateAuthError(e, resourceUri(getEnv().APP_URL, "rest")), { requestId });
  }
}
