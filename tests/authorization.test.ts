import { describe, expect, it } from "vitest";
import { ANONYMOUS, DevHeaderActorResolver } from "@/core/auth";
import { DefaultPolicy, enforce, type Requirement } from "@/core/authorization";
import { NOW, ORG_ID, OTHER_ORG_ID, USER_ID, admin, agent, user } from "./fixtures";

const policy = new DefaultPolicy(() => NOW);
const kind = (a: Parameters<typeof policy.decide>[0], r: Requirement, res?: Parameters<typeof policy.decide>[2]) => {
  const d = policy.decide(a, r, res);
  return d.allowed ? "allow" : d.kind;
};

describe("authorization policy", () => {
  it("public: anonymous allowed", () => expect(kind(ANONYMOUS, { access: "public" })).toBe("allow"));
  it("public with scope: agent without scope is forbidden", () => {
    expect(kind(agent([]), { access: "public", scope: "services:read" })).toBe("forbidden");
    expect(kind(agent(["services:read"]), { access: "public", scope: "services:read" })).toBe("allow");
  });
  it("expired delegation is unauthenticated", () =>
    expect(kind(agent(["services:read"], { expiresAt: "2026-11-09T09:00:00.000Z" }), { access: "public", scope: "services:read" })).toBe("unauthenticated"));
  it("authenticated: anonymous and public-only agents are rejected", () => {
    expect(kind(ANONYMOUS, { access: "authenticated" })).toBe("unauthenticated");
    expect(kind(agent(["bookings:read"], { publicOnly: true }), { access: "authenticated", scope: "bookings:read" })).toBe("unauthenticated");
    expect(kind(user, { access: "authenticated" })).toBe("allow");
  });
  it("agents are never admin (confused deputy)", () => {
    expect(kind(agent(["bookings:write"]), { access: "admin", scope: "bookings:write" })).toBe("forbidden");
    expect(kind(user, { access: "admin" })).toBe("forbidden");
    expect(kind(admin, { access: "admin" })).toBe("allow");
  });
  describe("owner-or-admin (IDOR)", () => {
    const req: Requirement = { access: "owner-or-admin", scope: "bookings:read" };
    const owned = { type: "booking", ownerId: USER_ID, organizationId: ORG_ID };
    it("owner allowed", () => expect(kind(user, req, owned)).toBe("allow"));
    it("admin allowed", () => expect(kind(admin, req, owned)).toBe("allow"));
    it("non-owner gets not_found, not forbidden", () =>
      expect(kind({ ...user, userId: "66666666-6666-4666-8666-666666666666" }, req, owned)).toBe("not_found"));
    it("delegated agent acts only as its user", () => {
      expect(kind(agent(["bookings:read"]), req, owned)).toBe("allow");
      expect(kind(agent(["bookings:read"]), req, { ...owned, ownerId: "66666666-6666-4666-8666-666666666666" })).toBe("not_found");
      expect(kind(agent(["services:read"]), req, owned)).toBe("forbidden");
    });
    it("cross-organization resource does not exist", () => expect(kind(user, req, { ...owned, organizationId: OTHER_ORG_ID })).toBe("not_found"));
  });
  it("enforce maps decisions to AppErrors", () => {
    expect(() => enforce({ allowed: false, kind: "not_found", reason: "x" })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => enforce({ allowed: false, kind: "forbidden", reason: "x" })).toThrow(expect.objectContaining({ code: "forbidden" }));
  });
});

describe("dev actor resolver", () => {
  it("refuses construction in production", () => expect(() => new DevHeaderActorResolver({ enabled: true, nodeEnv: "production" })).toThrow());
  it("is anonymous when disabled", async () => {
    const r = new DevHeaderActorResolver({ enabled: false, nodeEnv: "test" });
    expect(await r.resolve(new Request("http://x", { headers: { "x-dev-actor": `admin|${USER_ID}|${ORG_ID}` } }))).toEqual({ kind: "anonymous" });
  });
  it("parses agent actors with scopes", async () => {
    const r = new DevHeaderActorResolver({ enabled: true, nodeEnv: "test", now: () => NOW });
    const a = await r.resolve(new Request("http://x", { headers: { "x-dev-actor": `agent|c1|${USER_ID}|${ORG_ID}|services:read,bookings:read` } }));
    expect(a).toMatchObject({ kind: "agent", clientId: "c1", onBehalfOf: { userId: USER_ID }, delegation: { scopes: ["services:read", "bookings:read"] } });
  });
  it("treats unknown scopes as anonymous instead of widening access or throwing", async () => {
    const r = new DevHeaderActorResolver({ enabled: true, nodeEnv: "test" });
    expect(await r.resolve(new Request("http://x", { headers: { "x-dev-actor": "agent|c1|-|-|root" } }))).toEqual({ kind: "anonymous" });
  });
});
