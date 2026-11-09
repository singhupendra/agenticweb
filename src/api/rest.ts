/**
 * REST adapter: Request → capability invocation → Response. Contains NO business logic.
 * Route files are one-liners: `export const GET = restHandler("services.list")`.
 */
import { randomUUID } from "node:crypto";
import { ANONYMOUS, DevHeaderActorResolver, type ActorResolver } from "@/core/auth";
import { AppError, notFound, problemResponse, validationError } from "@/core/errors";
import { getEnv } from "@/core/env";
import { registry } from "@/capabilities";
import { getRuntime, type Runtime } from "@/runtime";

let resolver: ActorResolver | undefined;
function defaultResolver(): ActorResolver {
  const env = getEnv();
  return (resolver ??= env.DEV_AUTH_ENABLED
    ? new DevHeaderActorResolver({ enabled: true, nodeEnv: env.NODE_ENV })
    : { resolve: async () => ANONYMOUS }); // TODO(Phase 3): session/token resolver
}

export interface RestDeps {
  runtime: () => Runtime;
  resolver: () => ActorResolver;
}

export function createRestHandler(capabilityName: string, deps: RestDeps = { runtime: getRuntime, resolver: defaultResolver }) {
  return async (request: Request, ctx?: { params?: Promise<Record<string, string>> }): Promise<Response> => {
    const requestId = request.headers.get("x-request-id") ?? randomUUID();
    const url = new URL(request.url);
    try {
      const cap = registry.get(capabilityName);
      if (!cap) throw notFound("Capability");
      const params = (await ctx?.params) ?? {};
      const query = Object.fromEntries(url.searchParams);
      let body: unknown = {};
      if (cap.http.method !== "GET") {
        const text = await request.text();
        body = text ? JSON.parse(text) : {};
      }
      // Path params win over query/body so callers cannot override identifiers.
      const raw = { ...query, ...(body as object), ...params };
      const actor = await deps.resolver().resolve(request);
      const envelope = await deps.runtime().executor.invoke(capabilityName, actor, raw, {
        requestId,
        idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
      });
      return new Response(JSON.stringify(envelope), {
        status: cap.http.successStatus ?? 200,
        headers: { "content-type": "application/json", "x-request-id": requestId, "cache-control": "no-store" },
      });
    } catch (e) {
      if (e instanceof SyntaxError) {
        return problemResponse(validationError([{ path: "", message: "Body must be valid JSON" }]), { requestId, instance: url.pathname });
      }
      if (!(e instanceof AppError)) {
        getRuntimeLoggerSafe()?.error("rest handler error", { error: e, requestId });
      }
      return problemResponse(e, { requestId, instance: url.pathname });
    }
  };
}

function getRuntimeLoggerSafe() {
  try {
    return getRuntime().logger;
  } catch (e) {
    // Runtime failed to initialise (config/DB driver): still surface it, never swallow.
    console.error("runtime initialisation failed", e);
    return undefined;
  }
}

export const restHandler = (name: string) => createRestHandler(name);
