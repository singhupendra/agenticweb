import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registry } from "@/capabilities";
import { buildOpenApi } from "@/api/openapi";
import { renderDocsHtml } from "@/api/docs";
import { docsResponse, openApiResponse } from "@/api/spec";
import { doc } from "./harness";

type Op = { operationId: string; parameters: { name: string; in: string; required: boolean; $ref?: string }[]; responses: Record<string, unknown>; security: Record<string, string[]>[] };
const ops = Object.entries(doc.paths).flatMap(([p, item]) => Object.entries(item).map(([m, op]) => ({ p, m, op: op as unknown as Op })));

describe("OpenAPI document (generated from the registry)", () => {
  it("is OpenAPI 3.1 with a JSON Schema 2020-12 dialect", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.jsonSchemaDialect).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("has exactly one operation per registry HTTP binding (plus health/ready) — nothing hand-written", () => {
    const expected = registry.all().flatMap((c) => [c.http, ...(c.httpAliases ?? [])].map((h) => `${h.method} ${h.path}`));
    const actual = ops.map((o) => `${o.m.toUpperCase()} ${o.p}`).filter((s) => !s.includes("/api/health") && !s.includes("/api/ready"));
    expect(actual.sort()).toEqual(expected.sort());
  });

  it("snapshot of the public surface", () => {
    expect(ops.map((o) => `${o.m.toUpperCase()} ${o.p} ${o.op.operationId}`).sort()).toMatchInlineSnapshot(`
      [
        "DELETE /api/organizations/{orgSlug}/bookings/{bookingId} bookings.cancel.delete",
        "GET /api/health health",
        "GET /api/organizations/{orgSlug} organization.get",
        "GET /api/organizations/{orgSlug}/bookings bookings.list",
        "GET /api/organizations/{orgSlug}/bookings/{bookingId} bookings.get",
        "GET /api/organizations/{orgSlug}/services services.list",
        "GET /api/organizations/{orgSlug}/services/{serviceSlug} services.get",
        "GET /api/organizations/{orgSlug}/services/{serviceSlug}/slots slots.list",
        "GET /api/ready ready",
        "PATCH /api/organizations/{orgSlug}/bookings/{bookingId} bookings.update",
        "POST /api/organizations/{orgSlug}/bookings bookings.create",
        "POST /api/organizations/{orgSlug}/bookings/{bookingId}/cancel bookings.cancel",
      ]
    `);
  });

  it("has unique operationIds and every $ref resolves", () => {
    const ids = ops.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of JSON.stringify(doc).matchAll(/"\$ref":"(#\/[^"]+)"/g)) {
      const target = (m[1] as string).replace("#/", "").split("/").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], doc);
      expect(target, `dangling ${m[1]}`).toBeDefined();
    }
  });

  it("declares every path template variable as a required path parameter", () => {
    for (const { p, op } of ops) {
      const declared = op.parameters.filter((x) => x.in === "path");
      const vars = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(declared.map((d) => d.name).sort()).toEqual([...vars].sort());
      expect(declared.every((d) => d.required)).toBe(true);
    }
  });

  it("every mutating operation requires Idempotency-Key and documents 400/401/403/409/422/429/500", () => {
    for (const { m, op, p } of ops) {
      const mutating = m !== "get";
      expect(op.parameters.some((x) => x.$ref?.endsWith("/IdempotencyKey")), `${m} ${p}`).toBe(mutating);
      if (mutating) for (const code of ["400", "401", "403", "409", "422", "429", "500"]) expect(op.responses[code], `${m} ${p} ${code}`).toBeDefined();
    }
  });

  it("public reads allow anonymous access; protected ones require bearer with the capability scope", () => {
    const byId = (id: string) => ops.find((o) => o.op.operationId === id)!.op;
    expect(byId("services.list").security).toContainEqual({});
    expect(byId("bookings.create").security).toEqual([{ bearerAuth: ["bookings:write"] }]);
  });

  it("never leaks owner/tenant fields in booking output and rejects them in input", () => {
    const op = doc.paths["/api/organizations/{orgSlug}/bookings"]!.post as unknown as {
      requestBody: { content: Record<string, { schema: { properties: object; additionalProperties: boolean } }> };
      responses: Record<string, { content: Record<string, { schema: { properties: { data: { properties: object } } } }> }>;
    };
    const out = Object.keys(op.responses["201"]!.content["application/json"]!.schema.properties.data.properties);
    expect(out.sort()).toEqual(["createdAt", "id", "notes", "serviceId", "slotId", "slotStartsAt", "status"]);
    const body = op.requestBody.content["application/json"]!.schema;
    expect(Object.keys(body.properties).sort()).toEqual(["notes", "slotId"]);
    expect(body.additionalProperties).toBe(false);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildOpenApi(registry, { serverUrl: "http://localhost" }))).toBe(JSON.stringify(doc));
  });
});

describe("route files cover the registry", () => {
  it("each HTTP binding has a route.ts exporting its method via restHandler", () => {
    for (const c of registry.all()) {
      for (const h of [c.http, ...(c.httpAliases ?? [])]) {
        const file = join(process.cwd(), "src/app", h.path.replace(/\{(\w+)\}/g, "[$1]"), "route.ts");
        expect(existsSync(file), `missing ${file}`).toBe(true);
        expect(readFileSync(file, "utf8")).toMatch(new RegExp(`export const ${h.method} = restHandler\\("${c.name}"\\)`));
      }
    }
  });
});

describe("/openapi.json and /docs", () => {
  const req = (path: string, headers: Record<string, string> = {}) => new Request(`https://example.test${path}`, { headers });
  it("serves the document with the request origin as server and an ETag", async () => {
    const res = openApiResponse(req("/openapi.json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toContain("public");
    const body = JSON.parse(await res.text());
    expect(body.servers).toEqual([{ url: "https://example.test" }]);
    expect(Object.keys(body.paths)).toEqual(Object.keys(doc.paths));
    expect(openApiResponse(req("/openapi.json", { "if-none-match": res.headers.get("etag")! })).status).toBe(304);
  });
  it("renders human docs listing every operation, escaping content", async () => {
    const res = docsResponse(req("/docs"));
    const html = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    for (const { op } of ops) expect(html).toContain(`id="${op.operationId}"`);
    const evil = structuredClone(doc);
    (evil.paths["/api/health"]!.get as { summary: string }).summary = "<script>alert(1)</script>";
    const out = renderDocsHtml(evil);
    expect(out).not.toContain("<script>alert(1)");
    expect(out).toContain("&lt;script&gt;");
  });
});
