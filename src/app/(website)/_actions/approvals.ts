"use server";
/** Human decision on an agent's pending write. Only translates the form → gate.approve/decline; the gate enforces who may decide. */
import { redirect } from "next/navigation";
import { AppError } from "@/core/errors";
import { getAgentGate } from "@/agents/policies";
import { currentActor } from "../_lib/data";

export async function decideApprovalAction(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  const decision = form.get("decision") === "approve" ? "approve" : "decline";
  try {
    const actor = await currentActor();
    const gate = getAgentGate();
    if (decision === "approve") await gate.approve(id, actor);
    else await gate.decline(id, actor);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    redirect(`/approvals/${encodeURIComponent(id)}?error=1`);
  }
  redirect(`/approvals/${encodeURIComponent(id)}?done=${decision}`);
}
