import type { AgentActor, AdminActor, UserActor } from "@/core/auth";
import { createRuntime } from "@/runtime";
import { InMemoryOrganizationRepository } from "@/modules/organization/service";
import { InMemoryServiceRepository } from "@/modules/services/service";

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

export function testRuntime() {
  return createRuntime({
    organizations: new InMemoryOrganizationRepository([{ id: ORG_ID, slug: "acme", name: "Acme", timezone: "UTC" }]),
    services: new InMemoryServiceRepository({ [ORG_ID]: [svc(1), svc(2), svc(3, false)] }),
    clock: () => NOW,
  });
}
