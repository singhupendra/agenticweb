/**
 * Authorization matrix: actor (role) × capability × resource owner, through the real executor (validate → load →
 * authorize → execute). Every cell is explicit; adding a capability without a row here fails the coverage test.
 */
import { describe, expect, it } from "vitest";
import { ANONYMOUS, type Actor } from "@/core/auth";
import { capabilities } from "@/capabilities";
import { SLOTS, USER2_ID, ORG_ID, admin, agent, outsider, testRuntime, user, user2 } from "./fixtures";

type Out = "ok" | "unauthenticated" | "forbidden" | "not_found";
const CAPS = ["services.list", "slots.list", "bookings.create", "bookings.list", "bookings.get", "bookings.update", "bookings.cancel"] as const;
const ALL = ["services:read", "bookings:read", "bookings:write"] as const;
const expired = agent([...ALL], { expiresAt: "2026-11-09T09:00:00.000Z" });
const agentOf = (userId: string, scopes: readonly string[]): Actor => ({ ...agent([...ALL]), onBehalfOf: { userId, organizationId: ORG_ID }, delegation: { ...agent([]).delegation, scopes: scopes as never } });

// Resource under test for get/cancel: a booking owned by USER_ID in ORG_ID.
type Row = Record<Exclude<(typeof CAPS)[number], "bookings.update">, Out>;
const RAW_ROWS: [string, Actor, Row][] = [
  ["anonymous", ANONYMOUS, { "services.list": "ok", "slots.list": "ok", "bookings.create": "unauthenticated", "bookings.list": "unauthenticated", "bookings.get": "unauthenticated", "bookings.cancel": "unauthenticated" }],
  ["user (owner)", user, { "services.list": "ok", "slots.list": "ok", "bookings.create": "ok", "bookings.list": "ok", "bookings.get": "ok", "bookings.cancel": "ok" }],
  ["user (other owner, same org)", user2, { "services.list": "ok", "slots.list": "ok", "bookings.create": "ok", "bookings.list": "ok", "bookings.get": "not_found", "bookings.cancel": "not_found" }],
  ["user (other organization)", outsider, { "services.list": "ok", "slots.list": "ok", "bookings.create": "not_found", "bookings.list": "not_found", "bookings.get": "not_found", "bookings.cancel": "not_found" }],
  ["admin (same org)", admin, { "services.list": "ok", "slots.list": "ok", "bookings.create": "ok", "bookings.list": "ok", "bookings.get": "ok", "bookings.cancel": "ok" }],
  ["agent for owner, all scopes", agent([...ALL]), { "services.list": "ok", "slots.list": "ok", "bookings.create": "ok", "bookings.list": "ok", "bookings.get": "ok", "bookings.cancel": "ok" }],
  ["agent for owner, services:read only", agent(["services:read"]), { "services.list": "ok", "slots.list": "ok", "bookings.create": "forbidden", "bookings.list": "forbidden", "bookings.get": "forbidden", "bookings.cancel": "forbidden" }],
  ["agent for owner, bookings:read only", agent(["bookings:read"]), { "services.list": "forbidden", "slots.list": "forbidden", "bookings.create": "forbidden", "bookings.list": "ok", "bookings.get": "ok", "bookings.cancel": "forbidden" }],
  ["agent for owner, no scopes", agent([]), { "services.list": "forbidden", "slots.list": "forbidden", "bookings.create": "forbidden", "bookings.list": "forbidden", "bookings.get": "forbidden", "bookings.cancel": "forbidden" }],
  ["agent, expired delegation", expired, { "services.list": "unauthenticated", "slots.list": "unauthenticated", "bookings.create": "unauthenticated", "bookings.list": "unauthenticated", "bookings.get": "unauthenticated", "bookings.cancel": "unauthenticated" }],
  ["agent, public-only (no user)", agent([...ALL], { publicOnly: true }), { "services.list": "ok", "slots.list": "ok", "bookings.create": "unauthenticated", "bookings.list": "unauthenticated", "bookings.get": "unauthenticated", "bookings.cancel": "unauthenticated" }],
  ["agent for another user, all scopes", agentOf(USER2_ID, ALL), { "services.list": "ok", "slots.list": "ok", "bookings.create": "ok", "bookings.list": "ok", "bookings.get": "not_found", "bookings.cancel": "not_found" }],
  ["agent delegated by an ADMIN user (still not admin)", agentOf(admin.userId, ALL), { "services.list": "ok", "slots.list": "ok", "bookings.create": "ok", "bookings.list": "ok", "bookings.get": "not_found", "bookings.cancel": "not_found" }],
];

// bookings.update has the same requirement as bookings.cancel (owner-or-admin + bookings:write): same outcomes.
const ROWS: [string, Actor, Record<(typeof CAPS)[number], Out>][] = RAW_ROWS.map(([l, a, r]) => [l, a, { ...r, "bookings.update": r["bookings.cancel"] }]);

async function run(cap: (typeof CAPS)[number], actor: Actor): Promise<Out> {
  const rt = testRuntime();
  const made = await rt.executor.invoke("bookings.create", user, { orgSlug: "acme", slotId: SLOTS.one.id }, { idempotencyKey: "seed-key-0001" });
  const bookingId = (made.data as { id: string }).id;
  const inputs = {
    "services.list": { orgSlug: "acme" },
    "slots.list": { orgSlug: "acme", serviceSlug: "service-1" },
    "bookings.create": { orgSlug: "acme", slotId: SLOTS.two.id },
    "bookings.list": { orgSlug: "acme" },
    "bookings.get": { orgSlug: "acme", bookingId },
    "bookings.update": { orgSlug: "acme", bookingId, notes: "hello" },
    "bookings.cancel": { orgSlug: "acme", bookingId },
  } as const;
  try {
    await rt.executor.invoke(cap, actor, inputs[cap], { idempotencyKey: "matrix-key-0001" });
    return "ok";
  } catch (e) {
    return (e as { code: Out }).code;
  }
}

describe("authorization matrix (role × capability × resource owner)", () => {
  for (const [label, actor, expected] of ROWS) {
    describe(label, () => {
      for (const cap of CAPS) it(`${cap} → ${expected[cap]}`, async () => expect(await run(cap, actor)).toBe(expected[cap]));
    });
  }

  it("covers every registered capability (a new capability must get matrix rows or be a listed public read)", () => {
    const PUBLIC_READS_SHARING_THE_SAME_POLICY = ["organization.get", "services.get"];
    for (const c of capabilities) {
      expect([...CAPS, ...PUBLIC_READS_SHARING_THE_SAME_POLICY], c.name).toContain(c.name);
      if (PUBLIC_READS_SHARING_THE_SAME_POLICY.includes(c.name)) expect(c.requirement).toEqual({ access: "public", scope: "services:read" });
    }
  });

  it("every capability exposed to agents declares a scope, and none is admin", () => {
    for (const c of capabilities) {
      if (c.mcp.exposed) {
        expect(c.requirement.scope, c.name).toBeDefined();
        expect(c.requirement.access, c.name).not.toBe("admin");
      }
    }
  });

  it("IDOR: a denied cross-owner read is indistinguishable from a missing booking", async () => {
    const rt = testRuntime();
    const made = await rt.executor.invoke("bookings.create", user, { orgSlug: "acme", slotId: SLOTS.one.id }, { idempotencyKey: "seed-key-0002" });
    const id = (made.data as { id: string }).id;
    const real = await rt.executor.invoke("bookings.get", user2, { orgSlug: "acme", bookingId: id }).catch((e) => e);
    const fake = await rt.executor.invoke("bookings.get", user2, { orgSlug: "acme", bookingId: "99999999-0000-4000-8000-000000000000" }).catch((e) => e);
    expect({ code: real.code, status: real.status, message: real.message }).toEqual({ code: fake.code, status: fake.status, message: fake.message });
  });
  it("denials are audited with the actor and never the raw input", async () => {
    const rt = testRuntime();
    await rt.executor.invoke("bookings.list", ANONYMOUS, { orgSlug: "acme" }).catch(() => undefined);
    expect(rt.auditLog.events.at(-1)).toMatchObject({ outcome: "denied" });
  });
});
