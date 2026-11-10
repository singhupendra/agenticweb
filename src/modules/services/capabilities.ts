import { defineCapability } from "@/core/capabilities";
import { paginatedSchema } from "@/core/errors";
import type { ServiceCatalog } from "./service";
import { GetServiceInput, ListServicesInput, ServiceSchema } from "./schemas";

export interface ServicesDeps {
  catalog: ServiceCatalog;
}

export const listServices = defineCapability({
  name: "services.list",
  summary: "List bookable consulting services (paginated; filter by `q`/`maxPriceMinor`, sort with `sort`).",
  input: ListServicesInput,
  output: paginatedSchema(ServiceSchema),
  requirement: { access: "public", scope: "services:read" },
  mutating: false,
  http: { method: "GET", path: "/api/organizations/{orgSlug}/services" },
  mcp: { toolName: "list_services", exposed: true, description: "List the studio's bookable services with duration and price." },
  execute: (ctx: { deps: ServicesDeps }, i) => ctx.deps.catalog.list(i.orgSlug, i.page, i.pageSize, { q: i.q, maxPriceMinor: i.maxPriceMinor, sort: i.sort }),
});

export const getService = defineCapability({
  name: "services.get",
  summary: "Get one consulting service by slug.",
  input: GetServiceInput,
  output: ServiceSchema,
  requirement: { access: "public", scope: "services:read" },
  mutating: false,
  http: { method: "GET", path: "/api/organizations/{orgSlug}/services/{serviceSlug}" },
  mcp: { toolName: "get_service", exposed: true, description: "Get a service's details by slug." },
  execute: (ctx: { deps: ServicesDeps }, i) => ctx.deps.catalog.get(i.orgSlug, i.serviceSlug),
});
