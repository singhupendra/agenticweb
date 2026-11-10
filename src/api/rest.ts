/**
 * REST adapter: Request → capability invocation → Response. Contains NO business logic.
 * Route files are one-liners: `export const GET = restHandler("services.list")`.
 * Responsibilities here are strictly transport: parsing, actor resolution, headers, caching, error mapping.
 */
import { createHash, randomUUID } from "node:crypto";
import { ANONYMOUS, DevHeaderActorResolver, type Actor, type ActorResolver } from "@/core/auth";
import { AppError, notFound, problemResponse, validationError, type Envelope } from "@/core/errors";
import { getEnv } from "@/core/env";
import type { AnyCapability, HttpBinding } from "@/core/capabilities";
import { registry } from "@/capabilities";
import { getRuntime, type Runtime } from "@/runtime";

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** Client-supplied correlation ids are echoed in headers/logs: accept only a conservative charset, else generate one. */
export const safeRequestId = (supplied: string | null): string => (supplied && REQUEST_ID.test(supplied) ? supplied : randomUUID());

export const MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_PUBLIC_CACHE_SECONDS = 60;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

let resolver: ActorResolver | undefined;
export function defaultResolver(): ActorResolver {
  const env = getEnv();
  return (resolver ??= env.DEV_AUTH_ENABLED
    ? new DevHeaderActorResolver({ enabled: true, nodeEnv: env.NODE_ENV })
    : { resolve: async () => ANONYMOUS }); // TODO(Security): replaced by the session/token resolver
}

/**
 * Hook for the rate limiter (owned by Security). Runs after the actor is known and before the capability.
 * Throw `new AppError("rate_limited", ..., { headers: { "retry-after": "…" } })` to reject.
 */
export type RateLimitHook = (ctx: { request: Request; actor: Actor; capability: string; requestId: string }) => Promise<void> | void;

export interface RestDeps {
  runtime: () => Runtime;
  resolver: () => ActorResolver;
  rateLimit?: RateLimitHook;
}

/** Strong validator over the response payload only (never `meta.requestId`, which differs per request). */
export function etagFor(envelope: Envelope<unknown>): string {
  const { requestId: _omit, ...stable } = envelope.meta;
  void _omit;
  return `"${createHash("sha256").update(JSON.stringify({ data: envelope.data, meta: stable })).digest("base64url").slice(0, 27)}"`;
}

/** RFC 9110 weak comparison of an If-None-Match header against our ETag. */
export function ifNoneMatchHit(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const strip = (v: string) => v.trim().replace(/^W\//, "");
  return header.split(",").some((v) => strip(v) === etag);
}

export function linkHeader(url: URL, meta: Envelope<unknown>["meta"]): string | undefined {
  const { page, pageSize, total } = meta;
  if (page === undefined || pageSize === undefined || total === undefined) return undefined;
  const last = Math.max(1, Math.ceil(total / pageSize));
  const at = (p: number) => {
    const u = new URL(url);
    u.searchParams.set("page", String(p));
    u.searchParams.set("pageSize", String(pageSize));
    return `<${u.pathname}${u.search}>`;
  };
  const links = [`${at(1)}; rel="first"`, `${at(last)}; rel="last"`];
  if (page > 1) links.push(`${at(Math.min(page - 1, last))}; rel="prev"`);
  if (page < last) links.push(`${at(page + 1)}; rel="next"`);
  return links.join(", ");
}

const fillPath = (template: string, params: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_m, k: string) => encodeURIComponent(params[k] ?? ""));

function bindingFor(cap: AnyCapability<never>, method: string): HttpBinding | undefined {
  return [cap.http, ...(cap.httpAliases ?? [])].find((b) => b.method === method);
}

function queryParams(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    if (all.length > 1) throw validationError([{ path: key, message: "Parameter must not be repeated" }]);
    out[key] = all[0] ?? "";
  }
  return out;
}

const tooLarge = () => new AppError("payload_too_large", `Body must be at most ${MAX_BODY_BYTES} bytes.`);

/** Read the body incrementally and abort as soon as the cap is exceeded (Content-Length may be absent or false). */
async function readCapped(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readCapped(request);
  if (!text.trim()) return {};
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type !== "application/json" && !type.endsWith("+json")) {
    throw new AppError("unsupported_media_type", "Content-Type must be application/json.");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw validationError([{ path: "", message: "Body must be valid JSON" }]);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError([{ path: "", message: "Body must be a JSON object" }]);
  }
  return body as Record<string, unknown>;
}

function successResponse(cap: AnyCapability<never>, binding: HttpBinding, envelope: Envelope<unknown>, request: Request, url: URL, params: Record<string, string>, requestId: string): Response {
  const headers = new Headers({ "content-type": "application/json", "x-request-id": requestId });
  const status = binding.successStatus ?? cap.http.successStatus ?? 200;
  const link = linkHeader(url, envelope.meta);
  if (link) headers.set("link", link);

  if (cap.requirement.access === "public" && cap.http.method === "GET") {
    const etag = etagFor(envelope);
    headers.set("etag", etag);
    headers.set("cache-control", `public, max-age=${cap.http.cacheSeconds ?? DEFAULT_PUBLIC_CACHE_SECONDS}`);
    if (ifNoneMatchHit(request.headers.get("if-none-match"), etag)) {
      headers.delete("content-type");
      return new Response(null, { status: 304, headers });
    }
  } else {
    headers.set("cache-control", "private, no-store");
  }
  const id = (envelope.data as { id?: unknown } | null)?.id;
  if (status === 201 && typeof id === "string") headers.set("location", `${fillPath(cap.http.path, params)}/${encodeURIComponent(id)}`);
  return new Response(JSON.stringify(envelope), { status, headers });
}

export function createRestHandler(capabilityName: string, deps: RestDeps = { runtime: getRuntime, resolver: defaultResolver }) {
  return async (request: Request, ctx?: { params?: Promise<Record<string, string>> }): Promise<Response> => {
    const requestId = safeRequestId(request.headers.get("x-request-id"));
    const url = new URL(request.url);
    try {
      const cap = registry.get(capabilityName);
      if (!cap) throw notFound("Capability");
      const binding = bindingFor(cap, request.method);
      if (!binding) throw new AppError("method_not_allowed", `${request.method} is not supported here.`, { headers: { allow: [cap.http, ...(cap.httpAliases ?? [])].map((b) => b.method).join(", ") } });
      const params = (await ctx?.params) ?? {};
      const query = queryParams(url);
      // Identify the caller and rate-limit BEFORE buffering any body, so unauthenticated floods stay cheap.
      const actor = await deps.resolver().resolve(request);
      await deps.rateLimit?.({ request, actor, capability: capabilityName, requestId });
      const body = BODY_METHODS.has(request.method) ? await readBody(request) : {};
      // Path params win over body/query so callers cannot override identifiers.
      const raw = { ...query, ...body, ...params };
      const envelope = await deps.runtime().executor.invoke(capabilityName, actor, raw, {
        requestId,
        idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
      });
      return successResponse(cap, binding, envelope, request, url, params, requestId);
    } catch (e) {
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
