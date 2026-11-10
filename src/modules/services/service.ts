import { notFound, type Paginated } from "@/core/errors";
import type { OrganizationService } from "@/modules/organization/service";
import type { Service } from "./schemas";

export interface ServiceRepository {
  /** Active services only (public catalogue). */
  listActive(organizationId: string, page: { offset: number; limit: number }): Promise<{ items: Service[]; total: number }>;
  findActiveBySlug(organizationId: string, slug: string): Promise<Service | null>;
}

export interface ServiceCatalog {
  list(orgSlug: string, page: number, pageSize: number): Promise<Paginated<Service>>;
  get(orgSlug: string, serviceSlug: string): Promise<Service>;
}

export function createServiceCatalog(deps: { organizations: OrganizationService; repo: ServiceRepository }): ServiceCatalog {
  return {
    async list(orgSlug, page, pageSize) {
      const org = await deps.organizations.getBySlug(orgSlug);
      const { items, total } = await deps.repo.listActive(org.id, { offset: (page - 1) * pageSize, limit: pageSize });
      return { items, page, pageSize, total };
    },
    async get(orgSlug, serviceSlug) {
      const org = await deps.organizations.getBySlug(orgSlug);
      const s = await deps.repo.findActiveBySlug(org.id, serviceSlug);
      if (!s) throw notFound("Service");
      return s;
    },
  };
}

export class InMemoryServiceRepository implements ServiceRepository {
  constructor(private readonly byOrg: Record<string, (Service & { active?: boolean })[]> = {}) {}
  private active(org: string) {
    return (this.byOrg[org] ?? []).filter((s) => s.active !== false);
  }
  async listActive(org: string, p: { offset: number; limit: number }) {
    const all = this.active(org);
    return { items: all.slice(p.offset, p.offset + p.limit), total: all.length };
  }
  async findActiveBySlug(org: string, slug: string) {
    return this.active(org).find((s) => s.slug === slug) ?? null;
  }
}
