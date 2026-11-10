/**
 * REST adapter: Request → capability invocation → Response. Contains NO business logic.
 * Route files are one-liners: `export const GET = restHandler("services.list")`.
 */
import { randomUUID } from "node:crypto";
import { actorSubject, decorateAuthError, resolveActor, resourceUri, type Actor, type ActorResolver } from "@/core/auth";
import { AppError, notFound, problemResponse, validationError } from "@/core/errors";
import { getEnv } from "@/core/env";
import { InMemoryRateLimitStore, clientKey, createRateLimiter, readBodyWithLimit, type RateLimiter } from "@/core/security";
import { CONFIRMATION_HEADER, getAgentGate, type AgentConfirmationGate } from "@/agents/policies";
import { registry } from "@/capabilities";
import { getRuntime, type Runtime } from "@/runtime";

/** The one identity entry point (bearer → session+CSRF → dev header → anonymous). */
const defaultResolver: () => ActorResolver = () => ({ resolve: (r) => resolveActor(r) });

/** Per-client rate limiting: authenticated subjects and anonymous clients have separate budgets. */
const g = globalThis as unknown as { __restLimiter?: RateLimiter };
function defaultLimiter(): RateLimiter {
  return (g.__restLimiter ??= createRateLimiter({ store: new InMemoryRateLimitStore(), limit: getEnv().RATE_LIMIT_AUTH_PER_MIN, windowMs: 60_000 }));
}

export interface RestDeps {
  runtime: () => Runtime;
  resolver: () => ActorResolver;
  /** Omit to disable (unit tests). Default wiring enables it. */
  limiter?: () => RateLimiter;
  gate?: () => AgentConfirmationGate;
  maxBodyBytes?: () => number;
  trustProxy?: () => boolean;
  appUrl?: () => string;
}

const DEFAULT_DEPS: RestDeps = {
  runtime: getRuntime,
  resolver: defaultResolver,
  limiter: defaultLimiter,
  gate: getAgentGate,
  maxBodyBytes: () => getEnv().MAX_BODY_BYTES,
  trustProxy: () => getEnv().TRUST_PROXY,
  appUrl: () => getEnv().APP_URL,
};

export function createRestHandler(capabilityName: string, deps: RestDeps = DEFAULT_DEPS) {
  return async (request: Request, ctx?: { params?: Promise<Record<string, string>> }): Promise<Response> => {
    const requestId = request.headers.get("x-request-id") ?? randomUUID();
    const url = new URL(request.url);
    try {
      const cap = registry.get(capabilityName);
      if (!cap) throw notFound("Capability");
      const params = (await ctx?.params) ?? {};
      const query = Object.fromEntries(url.searchParams);
      const limiter = deps.limiter?.();
      const anonKey = clientKey(request, deps.trustProxy?.() ?? false);
      let actor: Actor;
      try {
        actor = await deps.resolver().resolve(request);
      } catch (e) {
        await limiter?.consume(anonKey); // failed-auth floods are throttled per client
        throw e;
      }
      if (limiter) {
        const anonymous = actor.kind === "anonymous";
        const limit = anonymous ? getEnv().RATE_LIMIT_ANON_PER_MIN : undefined;
        await limiter.consume(anonymous ? anonKey : actorSubject(actor), limit);
      }
      let body: unknown = {};
      if (cap.http.method !== "GET") {
        const text = await readBodyWithLimit(request, deps.maxBodyBytes?.() ?? 65536, { requireJson: true });
        body = text ? JSON.parse(text) : {};
      }
      // Path params win over query/body so callers cannot override identifiers.
      const raw = { ...query, ...(body as object), ...params };
      await deps.gate?.().check(actor, cap, raw, request.headers.get(CONFIRMATION_HEADER));
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
      return problemResponse(decorateAuthError(e, resourceUri(deps.appUrl?.() ?? getEnv().APP_URL, "rest")), { requestId, instance: url.pathname });
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
