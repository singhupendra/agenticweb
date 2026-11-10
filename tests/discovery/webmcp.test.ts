import { describe, expect, it, vi } from "vitest";
import { ANONYMOUS } from "@/core/auth";
import { registry } from "@/capabilities";
import { buildRequest, buildWebMcpManifest, detectModelContext, registerWebMcp, type WebMcpEnv } from "@/agents/discovery/webmcp";
import { user } from "./../fixtures";

const manifestFor = (actor = user) => buildWebMcpManifest(registry, actor, { orgSlug: "northwind-studio" });

describe("manifest derivation (same registry, same schemas)", () => {
  it("anonymous visitors only get read-only tools", () => {
    const m = buildWebMcpManifest(registry, ANONYMOUS, { orgSlug: "northwind-studio" });
    expect(m.tools.length).toBeGreaterThan(0);
    expect(m.tools.every((t) => !t.mutating && t.method === "GET")).toBe(true);
  });
  it("signed-in users also get the mutating booking tools, bound to the registry's REST paths", () => {
    const m = manifestFor();
    const create = m.tools.find((t) => t.name === registry.get("bookings.create")!.mcp.toolName)!;
    expect(create).toMatchObject({ mutating: true, method: "POST", pathTemplate: "/api/organizations/{orgSlug}/bookings" });
    expect((create.inputSchema.properties as Record<string, unknown>).slotId).toBeDefined();
    expect(create.inputSchema.required).toEqual(["slotId"]); // orgSlug defaulted, idempotency key auto-generated
  });
  it("tool names satisfy the WebMCP name grammar and descriptions are the static registry text", () => {
    for (const t of manifestFor().tools) {
      expect(t.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});

describe("buildRequest", () => {
  const tools = manifestFor().tools;
  const get = (n: string) => tools.find((t) => t.name === registry.get(n)!.mcp.toolName)!;
  it("fills path params, sends the rest as query for GET", () => {
    const r = buildRequest(get("slots.list"), { serviceSlug: "quick-consult", pageSize: 5 }, { orgSlug: "northwind-studio" }, () => "u");
    expect(r.url).toBe("/api/organizations/northwind-studio/services/quick-consult/slots?pageSize=5");
    expect(r.init.method).toBe("GET");
    expect(r.init.credentials).toBe("same-origin");
  });
  it("mutations get a JSON body and a generated Idempotency-Key unless one is given", () => {
    const a = buildRequest(get("bookings.create"), { slotId: "s1", notes: "hi" }, { orgSlug: "o" }, () => "generated-key");
    expect(a.init.headers["idempotency-key"]).toBe("generated-key");
    expect(JSON.parse(a.init.body!)).toEqual({ slotId: "s1", notes: "hi" });
    const b = buildRequest(get("bookings.create"), { slotId: "s1", idempotencyKey: "caller-key-1" }, { orgSlug: "o" }, () => "x");
    expect(b.init.headers["idempotency-key"]).toBe("caller-key-1");
    expect(JSON.parse(b.init.body!)).toEqual({ slotId: "s1" });
  });
  it("encodes path params (no path injection)", () => {
    const r = buildRequest(get("services.get"), { serviceSlug: "../x?y" }, { orgSlug: "o" }, () => "u");
    expect(r.url).toBe("/api/organizations/o/services/..%2Fx%3Fy");
  });
});

function fakeEnv(over: Partial<WebMcpEnv> & { mc?: { registerTool: ReturnType<typeof vi.fn> }; legacy?: boolean } = {}) {
  const mc = over.mc ?? { registerTool: vi.fn() };
  const ctx = mc as unknown as { registerTool(t: unknown, o?: { signal?: AbortSignal }): unknown };
  const env: WebMcpEnv = {
    ...(over.legacy ? { navigator: { modelContext: ctx } } : { document: { modelContext: ctx } }),
    fetch: over.fetch ?? (vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch),
    confirm: over.confirm ?? (() => true),
    randomUUID: () => "uuid-1",
  };
  return { env, mc };
}

describe("registerWebMcp", () => {
  it("is a strict no-op when WebMCP is unsupported", () => {
    const fetchSpy = vi.fn();
    const cleanup = registerWebMcp({ fetch: fetchSpy as unknown as typeof fetch, confirm: () => true, randomUUID: () => "u" }, manifestFor());
    expect(() => cleanup()).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(detectModelContext({})).toBeUndefined();
    expect(detectModelContext({ document: { modelContext: {} as never } })).toBeUndefined();
  });
  it("prefers document.modelContext, falls back to navigator.modelContext", () => {
    const { env, mc } = fakeEnv({ legacy: true });
    registerWebMcp(env, manifestFor());
    expect(mc.registerTool).toHaveBeenCalledTimes(manifestFor().tools.length);
  });
  it("registers every tool with a signal; cleanup aborts it", () => {
    const { env, mc } = fakeEnv();
    const cleanup = registerWebMcp(env, manifestFor());
    const signals = mc.registerTool.mock.calls.map((c) => c[1].signal as AbortSignal);
    expect(signals.every((s) => !s.aborted)).toBe(true);
    cleanup();
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
  it("one failing registration does not stop the others", () => {
    const registerTool = vi.fn().mockImplementationOnce(() => { throw new Error("dup"); });
    const { env } = fakeEnv({ mc: { registerTool } });
    registerWebMcp(env, manifestFor());
    expect(registerTool).toHaveBeenCalledTimes(manifestFor().tools.length);
  });
  it("read tools call the REST endpoint and return a JSON string", async () => {
    const { env, mc } = fakeEnv();
    registerWebMcp(env, manifestFor());
    const tool = mc.registerTool.mock.calls.map((c) => c[0]).find((t) => t.name === "list_services");
    expect(tool.annotations.readOnlyHint).toBe(true);
    const out = await tool.execute({});
    expect(env.fetch).toHaveBeenCalledWith("/api/organizations/northwind-studio/services", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
    expect(JSON.parse(out)).toEqual({ data: [] });
  });
  it("mutating tools require user confirmation; declining never hits the network", async () => {
    const { env, mc } = fakeEnv({ confirm: () => false });
    registerWebMcp(env, manifestFor());
    const tool = mc.registerTool.mock.calls.map((c) => c[0]).find((t) => t.name === registry.get("bookings.create")!.mcp.toolName);
    expect(tool.annotations.consequentialHint).toBe(true);
    const out = JSON.parse(await tool.execute({ slotId: "s" }));
    expect(out.error.code).toBe("user_declined");
    expect(env.fetch).not.toHaveBeenCalled();
  });
  it("confirmed mutations POST with the Idempotency-Key; API errors surface as structured results", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: "unauthenticated" }), { status: 401 }));
    const { env, mc } = fakeEnv({ fetch: fetchMock as unknown as typeof fetch });
    registerWebMcp(env, manifestFor());
    const tool = mc.registerTool.mock.calls.map((c) => c[0]).find((t) => t.name === registry.get("bookings.create")!.mcp.toolName);
    const out = JSON.parse(await tool.execute({ slotId: "s" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/organizations/northwind-studio/bookings", expect.objectContaining({ method: "POST" }));
    expect((fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers["idempotency-key"]).toBe("uuid-1");
    expect(out).toEqual({ error: { code: "unauthenticated" }, status: 401 });
  });
});
