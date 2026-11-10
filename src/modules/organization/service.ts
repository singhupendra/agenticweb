import { notFound } from "@/core/errors";
import type { Organization } from "./schemas";

export interface OrganizationRepository {
  findBySlug(slug: string): Promise<Organization | null>;
}

/** Contract other modules depend on (never the repository). */
export interface OrganizationService {
  getBySlug(slug: string): Promise<Organization>;
}

export function createOrganizationService(repo: OrganizationRepository): OrganizationService {
  return {
    async getBySlug(slug) {
      const org = await repo.findBySlug(slug);
      if (!org) throw notFound("Organization");
      return org;
    },
  };
}

export class InMemoryOrganizationRepository implements OrganizationRepository {
  constructor(private readonly orgs: Organization[] = []) {}
  async findBySlug(slug: string) {
    return this.orgs.find((o) => o.slug === slug) ?? null;
  }
}
