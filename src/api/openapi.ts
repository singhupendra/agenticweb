/**
 * OpenAPI 3.1 generated from the capability registry and the Zod schemas. There is NO hand-written path or
 * schema here: change a capability (or its Zod schema) and the document, `/docs` and the contract tests follow.
 */
import { z } from "zod";
import type { CapabilityRegistry, AnyCapability, HttpBinding } from "@/core/capabilities";
import { ERROR_CODES, ProblemDetailsSchema } from "@/core/errors";
import { MAX_PAGE_SIZE } from "@/core/validation";

export type Json = Record<string, unknown>;
export interface OpenApiDocument extends Json {
  openapi: "3.1.0";
  info: Json;
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json>; responses: Record<string, Json>; securitySchemes: Record<string, Json>; parameters: Record<string, Json>; headers: Record<string, Json> };
}

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const IDEMPOTENCY_KEY_PATTERN = "^[A-Za-z0-9_-]{8,128}$";

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Json {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io }) as Json;
  void _drop;
  return rest;
}

const HealthSchema = z.object({ status: z.literal("ok") });
const ReadySchema = z.object({ status: z.literal("ready"), checks: z.object({ database: z.literal("ok") }) });

const problemRef = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
  headers: { "X-Request-Id": { $ref: "#/components/headers/XRequestId" } },
});

/** Error responses shared by operations. `code` values mirror ERROR_CODES (stable). */
const ERROR_RESPONSES: Record<string, { description: string }> = {
  BadRequest: { description: `${ERROR_CODES.validation_failed.title} (codes: validation_failed, idempotency_key_required). Field errors are listed in \`errors\`.` },
  Unauthenticated: { description: "Authentication required (code: unauthenticated)." },
  Forbidden: { description: "The actor lacks the required scope or role (code: forbidden)." },
  NotFound: { description: "Resource not found, or not visible to the actor (code: not_found; non-owners get 404, never 403)." },
  Conflict: { description: "State conflict, e.g. slot full, already booked, or an identical Idempotency-Key still in flight (code: conflict; may carry Retry-After)." },
  PayloadTooLarge: { description: "Body exceeds the size limit (code: payload_too_large)." },
  UnsupportedMediaType: { description: "Body must be application/json (code: unsupported_media_type)." },
  Unprocessable: { description: "Idempotency-Key reused with a different request (code: idempotency_key_reuse)." },
  RateLimited: { description: "Too many requests (code: rate_limited). Honour Retry-After." },
  Internal: { description: "Unexpected error. Generic body; quote requestId when reporting (code: internal)." },
};

type Shape = { properties?: Record<string, Json>; required?: string[] };

function operationFor(cap: AnyCapability<never>, binding: HttpBinding, alias: boolean): Json {
  const input = jsonSchema(cap.input, "input") as Shape & Json;
  const props = input.properties ?? {};
  const required = new Set(input.required ?? []);
  const pathNames = [...binding.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
  const hasBody = binding.method !== "GET" && binding.method !== "DELETE";
  const isPublic = cap.requirement.access === "public";
  const isRead = binding.method === "GET";

  const parameters: Json[] = pathNames.map((n) => ({ name: n, in: "path", required: true, schema: props[n] ?? { type: "string" } }));
  const rest = Object.entries(props).filter(([n]) => !pathNames.includes(n));
  if (!hasBody) {
    for (const [name, schema] of rest) parameters.push({ name, in: "query", required: required.has(name), schema });
  }
  if (cap.mutating) parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });

  const op: Json = {
    operationId: alias ? `${cap.name}.${binding.method.toLowerCase()}` : cap.name,
    summary: cap.summary,
    description:
      `Capability \`${cap.name}\`. Access: \`${cap.requirement.access}\`` +
      (cap.requirement.scope ? `, scope \`${cap.requirement.scope}\`` : "") +
      (cap.mutating ? ". Requires an `Idempotency-Key` header; replays return the original response." : "."),
    tags: [cap.name.split(".")[0]],
    "x-capability": cap.name,
    "x-required-scope": cap.requirement.scope ?? null,
    "x-mcp-tool": cap.mcp.exposed ? cap.mcp.toolName : null,
    parameters,
    security: isPublic ? [{}, { bearerAuth: [] }] : [{ bearerAuth: cap.requirement.scope ? [cap.requirement.scope] : [] }],
  };

  if (hasBody) {
    const bodyProps = Object.fromEntries(rest);
    if (Object.keys(bodyProps).length) {
      const bodyRequired = rest.map(([n]) => n).filter((n) => required.has(n));
      op.requestBody = {
        required: bodyRequired.length > 0,
        content: { "application/json": { schema: { type: "object", properties: bodyProps, ...(bodyRequired.length ? { required: bodyRequired } : {}), additionalProperties: false } } },
      };
    }
  }

  // Success envelope: paginated outputs are lifted to `data: items[]` + page meta (mirrors core/errors/envelope).
  const out = jsonSchema(cap.output, "output") as Shape & Json;
  const paginated = !!out.properties?.items && !!out.properties.page && !!out.properties.total;
  const dataSchema = paginated ? (out.properties?.items as Json) : out;
  const metaSchema: Json = paginated
    ? { type: "object", properties: { requestId: { type: "string" }, page: { type: "integer" }, pageSize: { type: "integer", maximum: MAX_PAGE_SIZE }, total: { type: "integer" } }, required: ["requestId", "page", "pageSize", "total"], additionalProperties: false }
    : { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"], additionalProperties: false };
  const status = String(binding.successStatus ?? cap.http.successStatus ?? 200);
  const headers: Json = { "X-Request-Id": { $ref: "#/components/headers/XRequestId" } };
  if (paginated) headers.Link = { $ref: "#/components/headers/Link" };
  if (isPublic && isRead) {
    headers.ETag = { $ref: "#/components/headers/ETag" };
    headers["Cache-Control"] = { description: `public, max-age=${cap.http.cacheSeconds ?? 60}`, schema: { type: "string" } };
  } else {
    headers["Cache-Control"] = { description: "private, no-store", schema: { type: "string" } };
  }
  if (status === "201") headers.Location = { description: "URL of the created resource.", schema: { type: "string" } };

  const responses: Record<string, Json> = {
    [status]: {
      description: "Success",
      headers,
      content: { "application/json": { schema: { type: "object", properties: { data: dataSchema, meta: metaSchema }, required: ["data", "meta"], additionalProperties: false } } },
    },
  };
  if (isPublic && isRead) responses["304"] = { description: "Not modified (If-None-Match matched).", headers: { ETag: { $ref: "#/components/headers/ETag" } } };
  const ref = (n: string) => ({ $ref: `#/components/responses/${n}` });
  responses["400"] = ref("BadRequest");
  if (!isPublic) { responses["401"] = ref("Unauthenticated"); responses["403"] = ref("Forbidden"); }
  responses["404"] = ref("NotFound"); // every operation is org-scoped: an unknown org/resource is a 404
  if (cap.mutating) { responses["409"] = ref("Conflict"); responses["422"] = ref("Unprocessable"); }
  if (hasBody) { responses["413"] = ref("PayloadTooLarge"); responses["415"] = ref("UnsupportedMediaType"); }
  responses["429"] = ref("RateLimited");
  responses["500"] = ref("Internal");
  op.responses = responses;
  return op;
}

export function buildOpenApi<Deps>(registry: CapabilityRegistry<Deps>, opts: { title?: string; version?: string; serverUrl?: string } = {}): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  const tags = new Set<string>();
  for (const cap of registry.all()) {
    for (const [i, binding] of [cap.http, ...(cap.httpAliases ?? [])].entries()) {
      const item = (paths[binding.path] ??= {});
      item[binding.method.toLowerCase()] = operationFor(cap, binding, i > 0);
    }
    tags.add(cap.name.split(".")[0] as string);
  }
  const probe = (schema: z.ZodType, desc: string): Json => ({
    summary: desc, tags: ["ops"], security: [{}], parameters: [],
    responses: { "200": { description: desc, content: { "application/json": { schema: jsonSchema(schema, "output") } } }, "503": problemRef("Not ready (code: not_ready).") },
  });
  paths["/api/health"] = { get: { operationId: "health", ...probe(HealthSchema, "Liveness probe") } };
  paths["/api/ready"] = { get: { operationId: "ready", ...probe(ReadySchema, "Readiness probe (database reachable)") } };

  const responses: Record<string, Json> = {};
  for (const [name, r] of Object.entries(ERROR_RESPONSES)) responses[name] = problemRef(r.description);

  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    jsonSchemaDialect: DIALECT,
    info: {
      title: opts.title ?? "agenticweb REST API",
      version: opts.version ?? "1.0.0",
      description:
        "Generated from the capability registry. Success: `{data, meta}`. Errors: RFC 9457 `application/problem+json` with a stable `code`. " +
        "Mutations require an `Idempotency-Key`. See `docs/api-guide.md`.",
    },
    servers: opts.serverUrl ? [{ url: opts.serverUrl }] : [],
    tags: [...tags, "ops"].map((name) => ({ name })),
    paths,
    components: {
      schemas: { Problem: jsonSchema(ProblemDetailsSchema, "output") },
      responses,
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "User session or delegated agent token. Public reads need none." } },
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key", in: "header", required: true,
          description: "Client-generated unique key (8–128 chars of A–Z a–z 0–9 _ -). Same key + same body replays the first response.",
          schema: { type: "string", pattern: IDEMPOTENCY_KEY_PATTERN },
        },
      },
      headers: {
        XRequestId: { description: "Correlation id (echoes the request's X-Request-Id when supplied).", schema: { type: "string" } },
        ETag: { description: "Strong validator; send back as If-None-Match.", schema: { type: "string" } },
        Link: { description: "RFC 8288 pagination links (first, prev, next, last).", schema: { type: "string" } },
      },
    },
  };
  return doc;
}
