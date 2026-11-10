/** Loads the public catalogue for generated discovery files via the capability executor (anonymous, read-only). */
import { ANONYMOUS } from "@/core/auth";
import { getEnv } from "@/core/env";
import { getRuntime } from "@/runtime";
import type { Organization } from "@/modules/organization/schemas";
import type { Service } from "@/modules/services/schemas";

export interface Catalog { orgName: string; orgSlug: string; services: Service[]; degraded: boolean }

/** Never throws: discovery files must still serve (static pages only) when the catalogue is unavailable. */
export async function loadCatalog(): Promise<Catalog> {
  const orgSlug = getEnv().DEFAULT_ORG_SLUG;
  try {
    const { executor } = getRuntime();
    const org = (await executor.invoke("organization.get", ANONYMOUS, { orgSlug })).data as Organization;
    const services = (await executor.invoke("services.list", ANONYMOUS, { orgSlug })).data as Service[];
    return { orgName: org.name, orgSlug, services, degraded: false };
  } catch {
    return { orgName: "Northwind Studio", orgSlug, services: [], degraded: true };
  }
}

export const discoveryHeaders = (contentType: string, degraded: boolean) => ({
  "content-type": contentType,
  "cache-control": degraded ? "no-store" : "public, max-age=300",
});
