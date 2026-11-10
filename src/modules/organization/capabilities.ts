import { defineCapability } from "@/core/capabilities";
import type { OrganizationService } from "./service";
import { GetOrganizationInput, OrganizationSchema } from "./schemas";

export interface OrganizationDeps {
  organizations: OrganizationService;
}

export const getOrganization = defineCapability({
  name: "organization.get",
  summary: "Get a consulting studio's public profile by slug.",
  input: GetOrganizationInput,
  output: OrganizationSchema,
  requirement: { access: "public", scope: "services:read" },
  mutating: false,
  http: { method: "GET", path: "/api/organizations/{orgSlug}" },
  mcp: { toolName: "get_organization", exposed: true, description: "Get the studio's public profile (name, timezone)." },
  execute: (ctx: { deps: OrganizationDeps }, input) => ctx.deps.organizations.getBySlug(input.orgSlug),
});
