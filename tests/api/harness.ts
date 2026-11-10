/**
 * Contract-test harness: drives the REAL REST adapter in-process (no network) and validates every response
 * against the OpenAPI document generated from the registry. If a response can't be described by the spec, tests fail.
 */
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect } from "vitest";
import { DevHeaderActorResolver, type Actor } from "@/core/auth";
import { ERROR_CODES } from "@/core/errors";
import { registry } from "@/capabilities";
import { createRestHandler, type RestDeps } from "@/api/rest";
import { buildOpenApi, type Json, type OpenApiDocument } from "@/api/openapi";
import { ORG_ID, testRuntime } from "../fixtures";

export const doc: OpenApiDocument = buildOpenApi(registry, { serverUrl: "http://localhost" });
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

const lookup = (ref: string): Json =>
  ref.replace("#/", "").split("/").reduce<Json>((o, k) => (o[k.replace(/~1/g, "/").replace(/~0/g, "~")] ?? {}) as Json, doc);
export function deref<T>(node: T): T {
  if (Array.isArray(node)) return node.map(deref) as T;
  if (node && typeof node === "object") {
    const o = node as Json;
    if (typeof o.$ref === "string") return deref(lookup(o.$ref)) as T;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deref(v)])) as T;
  }
  return node;
}

const validators = new Map<string, ReturnType<typeof ajv.compile>>();
export function validate(schema: Json, value: unknown, label: string) {
  let v = validators.get(label);
  if (!v) validators.set(label, (v = ajv.compile(deref(schema))));
  const ok = v(value);
  expect(ok, `${label}: ${JSON.stringify(v.errors)}\nbody: ${JSON.stringify(value)}`).toBe(true);
}

/** Find the OpenAPI path template + operation for a concrete request. */
export function findOperation(method: string, pathname: string): { template: string; op: Json } | undefined {
  for (const [template, item] of Object.entries(doc.paths)) {
    const re = new RegExp(`^${template.replace(/\{(\w+)\}/g, "[^/]+")}$`);
    if (re.test(pathname) && item[method.toLowerCase()]) return { template, op: item[method.toLowerCase()] as Json };
  }
  return undefined;
}

export const actorHeader = (a: Actor): Record<string, string> => {
  switch (a.kind) {
    case "user": case "admin": return { "x-dev-actor": `${a.kind}|${a.userId}|${a.organizationId}` };
    case "agent": return { "x-dev-actor": `agent|${a.clientId}|${a.onBehalfOf?.userId ?? "-"}|${a.onBehalfOf?.organizationId ?? "-"}|${a.delegation.scopes.join(",")}` };
    default: return {};
  }
};

/** `body` is parsed JSON of unknown shape; tests assert on it loosely, the spec validator checks it strictly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = any;
export interface Result { status: number; headers: Headers; body: Loose; raw: string; res: Response }

export function createApp(extra: Partial<RestDeps> = {}) {
  const rt = testRuntime();
  const deps: RestDeps = {
    runtime: () => rt,
    resolver: () => new DevHeaderActorResolver({ enabled: true, nodeEnv: "test", now: () => new Date("2026-11-09T10:00:00.000Z") }),
    ...extra,
  };
  const handlers = new Map<string, ReturnType<typeof createRestHandler>>();

  async function call(
    method: string, path: string,
    o: { actor?: Actor; body?: unknown; rawBody?: string; headers?: Record<string, string>; check?: boolean } = {},
  ): Promise<Result> {
    const url = new URL(path, "http://localhost");
    const headers: Record<string, string> = { ...(o.actor ? actorHeader(o.actor) : {}), ...(o.headers ?? {}) };
    let body = o.rawBody;
    if (o.body !== undefined) { body = JSON.stringify(o.body); headers["content-type"] ??= "application/json"; }
    const matched = registry.matchHttp(method, url.pathname);
    let res: Response;
    if (!matched) {
      res = new Response("{}", { status: 404 }); // unrouted in this harness (Next would 404)
    } else {
      let h = handlers.get(matched.capability.name);
      if (!h) handlers.set(matched.capability.name, (h = createRestHandler(matched.capability.name, deps)));
      res = await h(new Request(url, { method, headers, body }), { params: Promise.resolve(matched.params) });
    }
    const raw = await res.text();
    let parsed: unknown = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
    const result: Result = { status: res.status, headers: res.headers, body: parsed, raw, res };
    if (o.check !== false) conforms(method, url.pathname, result);
    return result;
  }
  return { rt, call, deps };
}

/** The core contract assertion: status documented, content-type right, body matches the spec'd schema. */
export function conforms(method: string, pathname: string, r: Result) {
  const found = findOperation(method, pathname);
  expect(found, `no OpenAPI operation for ${method} ${pathname}`).toBeDefined();
  const { template, op } = found!;
  const responses = op.responses as Record<string, Json>;
  const spec = responses[String(r.status)];
  expect(spec, `${method} ${template} returned undocumented status ${r.status}: ${r.raw}`).toBeDefined();
  const resolved = deref(spec!) as { content?: Record<string, { schema: Json }>; headers?: Record<string, unknown> };
  expect(r.headers.get("x-request-id"), "x-request-id header").toBeTruthy();
  if (r.status === 304) { expect(r.raw).toBe(""); return; }
  const ct = (r.headers.get("content-type") ?? "").split(";")[0] as string;
  const schema = resolved.content?.[ct]?.schema;
  expect(schema, `${method} ${template} ${r.status}: content-type "${ct}" is not documented (${Object.keys(resolved.content ?? {})})`).toBeDefined();
  validate(schema!, r.body, `${method} ${template} ${r.status}`);
  for (const h of Object.keys(resolved.headers ?? {})) {
    if (["ETag", "Link", "Location", "Cache-Control"].includes(h) && r.status >= 200 && r.status < 300) {
      expect(r.headers.get(h), `documented success header ${h}`).toBeTruthy();
    }
  }
  if (r.status >= 400) assertProblem(r, pathname);
}

/** Error consistency: every failure, whichever capability produced it, has the same RFC 9457 shape. */
export function assertProblem(r: Result, pathname: string) {
  expect(r.headers.get("content-type")).toContain("application/problem+json");
  expect(r.headers.get("cache-control")).toBe("no-store");
  const p = r.body as { type: string; title: string; status: number; code: keyof typeof ERROR_CODES; requestId: string; instance: string; detail?: string };
  expect(Object.keys(ERROR_CODES)).toContain(p.code);
  expect(p.status).toBe(r.status);
  expect(p.status).toBe(ERROR_CODES[p.code].status);
  expect(p.title).toBe(ERROR_CODES[p.code].title);
  expect(p.type).toBe(`https://agenticweb.dev/problems/${p.code}`);
  expect(p.requestId).toBe(r.headers.get("x-request-id"));
  expect(p.instance).toBe(pathname);
  if (p.code === "internal") expect(p.detail).toBeUndefined();
}

export const BASE = "/api/organizations/acme";
export { ORG_ID };
