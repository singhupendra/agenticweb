/** Capability catalogue: the ONE list of product behaviours. Add new capabilities here. */
import { createRegistry, type AnyCapability } from "@/core/capabilities";
import type { OrganizationDeps } from "@/modules/organization/capabilities";
import { getOrganization } from "@/modules/organization/capabilities";
import type { ServicesDeps } from "@/modules/services/capabilities";
import { getService, listServices } from "@/modules/services/capabilities";

export type AppDeps = OrganizationDeps & ServicesDeps;

export const capabilities: readonly AnyCapability<AppDeps>[] = [getOrganization, listServices, getService];
export const registry = createRegistry<AppDeps>(capabilities);
