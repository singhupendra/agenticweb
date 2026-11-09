import { describe, expect, it } from "vitest";
import { ANONYMOUS } from "@/core/auth";
import { registry } from "@/capabilities";
import { IDEMPOTENCY_ARG, listTools } from "@/agents/tools/derive";
import { agent } from "./fixtures";

describe("MCP tool derivation", () => {
  it("derives a tool for every exposed capability from the registry", () => {
    const tools = listTools(registry, ANONYMOUS);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancel_booking", "create_booking", "get_booking", "get_organization", "get_service", "list_my_bookings", "list_services", "list_slots",
    ]);
    const list = tools.find((t) => t.name === "list_services")!;
    expect(list.inputSchema).toMatchObject({ type: "object", properties: { orgSlug: { type: "string" }, pageSize: expect.any(Object) } });
    expect(list.annotations.readOnlyHint).toBe(true);
    expect(list.inputSchema.properties).not.toHaveProperty(IDEMPOTENCY_ARG);
  });
  it("filters tools by the agent's delegated scopes", () => {
    expect(listTools(registry, agent([]))).toEqual([]);
    expect(listTools(registry, agent(["services:read"])).map((t) => t.name).sort()).toEqual(["get_organization", "get_service", "list_services", "list_slots"]);
    expect(listTools(registry, agent(["bookings:read"])).map((t) => t.name).sort()).toEqual(["get_booking", "list_my_bookings"]);
  });
  it("mutating tools require an idempotencyKey argument; read tools do not", () => {
    const tools = listTools(registry, agent(["bookings:write"]));
    expect(tools.map((t) => t.name).sort()).toEqual(["cancel_booking", "create_booking"]);
    for (const t of tools) expect(t.inputSchema.required).toContain(IDEMPOTENCY_ARG);
    expect(tools.every((t) => t.annotations.readOnlyHint === false)).toBe(true);
  });
  it("every registered capability declares authorization and read/write semantics", () => {
    for (const c of registry.all()) {
      expect(c.requirement.access).toBeDefined();
      expect(c.mutating).toBe(c.http.method !== "GET");
    }
  });
});
