import type { InvocationInstrument } from "@/core/capabilities";
import { isAuthzError } from "@/core/authorization";
import { AppError } from "@/core/errors";
import { recordAuthzRejection, recordInvalidArgument, recordTaskCompletion, recordToolInvocation, type InvocationOutcome } from "./metrics";
import { traced } from "./tracing";

function classify(e: unknown): InvocationOutcome {
  if (isAuthzError(e)) return "authz_rejected";
  if (e instanceof AppError) {
    switch (e.code) {
      case "validation_failed":
      case "idempotency_key_required":
      case "idempotency_key_reuse":
        return "invalid_argument";
      case "conflict":
        return "conflict";
      case "rate_limited":
        return "rate_limited";
    }
  }
  return "error";
}

/** Only registered capability names may become metric labels (bounded cardinality): the executor reports `mutating: undefined` for unknown names. */
const toolLabel = (info: { capability: string; mutating: boolean | undefined }) => (info.mutating === undefined ? "unknown" : info.capability);

/**
 * Executor hook: one span + the agent metrics per capability invocation, for every channel (REST, MCP, UI).
 * It does not know the channel, so channel adapters call `recordAgentRequest` themselves. Pass as `instrument` to `createExecutor`. Business outcomes (4xx-style failures) are not span errors.
 */
export function createOtelInstrument(): InvocationInstrument {
  return (info, run) => {
    const tool = toolLabel(info);
    const started = performance.now();
    return traced(
      `capability ${tool}`,
      async () => {
        try {
          const result = await run();
          recordToolInvocation({ tool, actorKind: info.actorKind, outcome: "success", durationMs: performance.now() - started });
          if (info.mutating) recordTaskCompletion({ task: tool, outcome: "completed" });
          return result;
        } catch (e) {
          const outcome = classify(e);
          recordToolInvocation({ tool, actorKind: info.actorKind, outcome, durationMs: performance.now() - started });
          if (outcome === "invalid_argument") recordInvalidArgument({ tool });
          if (outcome === "authz_rejected") recordAuthzRejection({ tool, code: (e as AppError).code });
          if (info.mutating && outcome === "error") recordTaskCompletion({ task: tool, outcome: "failed" });
          throw e;
        }
      },
      { attributes: { "capability.name": tool, "actor.kind": info.actorKind, "capability.mutating": info.mutating ?? false }, isError: (e) => classify(e) === "error" },
    );
  };
}
