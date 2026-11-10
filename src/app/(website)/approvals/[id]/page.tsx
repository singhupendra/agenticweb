import type { Metadata } from "next";
import { AppError } from "@/core/errors";
import { getAgentGate, type ConfirmationView } from "@/agents/policies";
import { decideApprovalAction } from "../../_actions/approvals";
import { currentActor } from "../../_lib/data";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Approve an action", robots: { index: false, follow: false } };

export default async function ApprovalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, q] = await Promise.all([params, searchParams]);
  const actor = await currentActor();
  if (actor.kind === "anonymous") {
    return (
      <>
        <h1 className="text-3xl font-semibold">Approve an action</h1>
        <p role="status" data-testid="signin-required" className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <a className="underline" href={`/api/auth/login?returnTo=${encodeURIComponent(`/approvals/${id}`)}`}>Sign in</a> as the account owner to review this request.
        </p>
      </>
    );
  }
  let view: ConfirmationView | null = null;
  try {
    view = await getAgentGate().describe(id, actor);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
  }
  return (
    <>
      <h1 className="text-3xl font-semibold">Approve an action</h1>
      {q.done ? (
        <p role="status" data-testid="approval-result" className="mt-4 rounded border border-zinc-400 px-3 py-2 text-sm">
          {q.done === "approve" ? "Approved. Tell your assistant to retry; this approval works once, for exactly this action." : "Declined. The action will not run."}
        </p>
      ) : null}
      {q.error ? <p role="alert" className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-950">This request is invalid, expired or already decided.</p> : null}
      {view === null ? (
        <p data-testid="approval-missing" className="mt-4 text-sm">This request does not exist, has expired, or belongs to another account.</p>
      ) : (
        <>
          <p className="mt-4 text-sm">An AI assistant wants to run <strong data-testid="approval-capability">{view.capability}</strong> on your behalf with these exact details:</p>
          <pre tabIndex={0} aria-label="Exact action details" data-testid="approval-preview" className="mt-3 overflow-x-auto rounded border border-zinc-300 bg-zinc-50 p-3 text-xs">{view.preview}</pre>
          <p className="mt-2 text-xs text-zinc-600">Status: {view.status} · expires {view.expiresAt}</p>
          {view.status === "pending" ? (
            <form action={decideApprovalAction} className="mt-6 flex gap-3">
              <input type="hidden" name="id" value={view.id} />
              <button name="decision" value="approve" className="rounded bg-blue-800 px-4 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">Approve</button>
              <button name="decision" value="decline" className="rounded border border-zinc-500 px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">Decline</button>
            </form>
          ) : null}
        </>
      )}
    </>
  );
}
