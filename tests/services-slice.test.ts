import { describe, expect, it } from "vitest";
import { ANONYMOUS } from "@/core/auth";
import { createRestHandler } from "@/api/rest";
import { ANONYMOUS as ANON } from "@/core/auth";
import { formatDuration, formatPrice } from "@/modules/services/present";
import { ListServicesInput } from "@/modules/services/schemas";
import { agent, testRuntime } from "./fixtures";

const call = (name: string, params: Record<string, string>, url: string, headers: Record<string, string> = {}) =>
  createRestHandler(name, { runtime: testRuntime_, resolver: () => ({ resolve: async () => ANON }) })(
    new Request(url, { headers }), { params: Promise.resolve(params) });
const rt = testRuntime();
const testRuntime_ = () => rt;

describe("services capabilities (domain)", () => {
  it("lists only active services, paginated", async () => {
    const r = await rt.executor.invoke("services.list", ANONYMOUS, { orgSlug: "acme", pageSize: 1 });
    expect(r.data).toHaveLength(1);
    expect(r.meta).toMatchObject({ page: 1, pageSize: 1, total: 2 });
  });
  it("gets a service; inactive and unknown are 404", async () => {
    expect((await rt.executor.invoke("services.get", ANONYMOUS, { orgSlug: "acme", serviceSlug: "service-1" })).data).toMatchObject({ name: "Service 1" });
    await expect(rt.executor.invoke("services.get", ANONYMOUS, { orgSlug: "acme", serviceSlug: "service-3" })).rejects.toMatchObject({ code: "not_found" });
    await expect(rt.executor.invoke("services.list", ANONYMOUS, { orgSlug: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });
  it("does not return internal fields (active flag)", async () => {
    const r = await rt.executor.invoke("services.get", ANONYMOUS, { orgSlug: "acme", serviceSlug: "service-1" });
    expect(r.data).not.toHaveProperty("active");
  });
  it("enforces page size cap", () => expect(ListServicesInput.safeParse({ orgSlug: "acme", pageSize: 500 }).success).toBe(false));
  it("agent needs services:read", async () => {
    await expect(rt.executor.invoke("services.list", agent([]), { orgSlug: "acme" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(rt.executor.invoke("services.list", agent(["services:read"]), { orgSlug: "acme" })).resolves.toBeDefined();
  });
  it("organization.get works", async () => {
    expect((await rt.executor.invoke("organization.get", ANONYMOUS, { orgSlug: "acme" })).data).toMatchObject({ name: "Acme" });
  });
});

describe("REST adapter", () => {
  it("returns the envelope with request id", async () => {
    const res = await call("services.list", { orgSlug: "acme" }, "http://x/api/organizations/acme/services?pageSize=1", { "x-request-id": "abc" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("abc");
    const body = await res.json();
    expect(body.meta).toMatchObject({ requestId: "abc", total: 2 });
    expect(body.data).toHaveLength(1);
  });
  it("returns problem+json for unknown org", async () => {
    const res = await call("services.list", { orgSlug: "nope" }, "http://x/api/organizations/nope/services");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ code: "not_found", instance: "/api/organizations/nope/services" });
  });
  it("returns 400 problem with field errors for bad query", async () => {
    const res = await call("services.list", { orgSlug: "acme" }, "http://x/a?pageSize=999");
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0]).toMatchObject({ path: "pageSize" });
  });
  it("path params cannot be overridden by query", async () => {
    const res = await call("services.list", { orgSlug: "acme" }, "http://x/a?orgSlug=nope");
    expect(res.status).toBe(200);
  });
});

describe("presentation", () => {
  it("formats price and duration", () => {
    expect(formatPrice(1500000, "INR")).toContain("15,000");
    expect(formatDuration(90)).toBe("1 h 30 min");
    expect(formatDuration(30)).toBe("30 min");
  });
});
