import type { AgentActor, AdminActor, UserActor } from "@/core/auth";
import { createRuntime } from "@/runtime";
import { InMemoryOrganizationRepository } from "@/modules/organization/service";
import { InMemoryServiceRepository } from "@/modules/services/service";
import { InMemoryBookingRepository, type MemorySlot } from "@/modules/bookings/repository.memory";
import { InMemoryAuditLog } from "@/core/logging";

export const ORG_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";
export const USER_ID = "33333333-3333-4333-8333-333333333333";
export const NOW = new Date("2026-11-09T10:00:00.000Z");

export const user: UserActor = { kind: "user", userId: USER_ID, organizationId: ORG_ID };
export const admin: AdminActor = { kind: "admin", userId: "44444444-4444-4444-8444-444444444444", organizationId: ORG_ID };
export const agent = (scopes: AgentActor["delegation"]["scopes"], opts: { expiresAt?: string; publicOnly?: boolean } = {}): AgentActor => ({
  kind: "agent",
  clientId: "client-1",
  onBehalfOf: opts.publicOnly ? null : { userId: USER_ID, organizationId: ORG_ID },
  delegation: { grantId: "grant-1", scopes, expiresAt: opts.expiresAt ?? "2026-11-09T11:00:00.000Z" },
});

export const svc = (n: number, active = true) => ({
  id: `55555555-5555-4555-8555-55555555555${n}`,
  slug: `service-${n}`,
  name: `Service ${n}`,
  description: `Description ${n}`,
  durationMinutes: 60,
  priceMinor: 100000,
  currency: "INR",
  active,
});

const H = 3600_000;
const slot = (n: number, over: Partial<MemorySlot> = {}): MemorySlot => ({
  id: `77777777-7777-4777-8777-77777777777${n}`,
  serviceId: svc(1).id,
  organizationId: ORG_ID,
  serviceActive: true,
  startsAt: new Date(NOW.getTime() + (n + 1) * 24 * H),
  endsAt: new Date(NOW.getTime() + (n + 1) * 24 * H + H),
  capacity: 1,
  ...over,
});
/** 1: cap 1 · 2: cap 2 · 3: in the past · 4: other org · 5: inactive service · 6: later slot (cap 1) */
export const SLOTS = {
  one: slot(1),
  two: slot(2, { capacity: 2 }),
  past: slot(3, { startsAt: new Date(NOW.getTime() - H), endsAt: new Date(NOW.getTime()) }),
  otherOrg: slot(4, { organizationId: OTHER_ORG_ID }),
  inactive: slot(5, { serviceId: svc(3).id, serviceActive: false }),
  later: slot(6),
};
export const USER2_ID = "88888888-8888-4888-8888-888888888888";
export const user2: UserActor = { kind: "user", userId: USER2_ID, organizationId: ORG_ID };
export const outsider: UserActor = { kind: "user", userId: "99999999-9999-4999-8999-999999999999", organizationId: OTHER_ORG_ID };

export function testRuntime() {
  const bookings = new InMemoryBookingRepository(Object.values(SLOTS));
  const audit = new InMemoryAuditLog();
  const runtime = createRuntime({
    organizations: new InMemoryOrganizationRepository([{ id: ORG_ID, slug: "acme", name: "Acme", timezone: "UTC" }]),
    services: new InMemoryServiceRepository({ [ORG_ID]: [svc(1), svc(2), svc(3, false)] }),
    bookings,
    audit,
    clock: () => NOW,
  });
  return Object.assign(runtime, { bookingsRepo: bookings, auditLog: audit });
}
