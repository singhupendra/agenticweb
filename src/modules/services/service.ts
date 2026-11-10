import { notFound, type Paginated } from "@/core/errors";
import type { OrganizationService } from "@/modules/organization/service";
import type { Service, ServiceSort } from "./schemas";

export interface ServiceListFilter {
  q?: string;
  maxPriceMinor?: number;
  sort?: ServiceSort;
}

export interface ServiceRepository {
  /** Active services only (public catalogue). */
  listActive(organizationId: string, page: { offset: number; limit: number } & ServiceListFilter): Promise<{ items: Service[]; total: number }>;
  findActiveBySlug(organizationId: string, slug: string): Promise<Service | null>;
}

export interface ServiceCatalog {
  list(orgSlug: string, page: number, pageSize: number, filter?: ServiceListFilter): Promise<Paginated<Service>>;
  get(orgSlug: string, serviceSlug: string): Promise<Service>;
}

export function createServiceCatalog(deps: { organizations: OrganizationService; repo: ServiceRepository }): ServiceCatalog {
  return {
    async list(orgSlug, page, pageSize, filter = {}) {
      const org = await deps.organizations.getBySlug(orgSlug);
      const { items, total } = await deps.repo.listActive(org.id, { offset: (page - 1) * pageSize, limit: pageSize, ...filter });
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
  async listActive(org: string, p: { offset: number; limit: number } & ServiceListFilter) {
    const q = p.q?.toLowerCase();
    const all = this.active(org)
      .filter((s) => (!q || s.name.toLowerCase().includes(q)) && (p.maxPriceMinor === undefined || s.priceMinor <= p.maxPriceMinor))
      .sort(compareServices(p.sort ?? "name"));
    return { items: all.slice(p.offset, p.offset + p.limit), total: all.length };
  }
  async findActiveBySlug(org: string, slug: string) {
    return this.active(org).find((s) => s.slug === slug) ?? null;
  }
}

function compareServices(sort: ServiceSort) {
  const desc = sort.startsWith("-");
  const key = sort.replace("-", "") as "name" | "priceMinor" | "durationMinutes";
  return (a: Service, b: Service) => {
    const x = a[key], y = b[key];
    const c = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : Number(x) - Number(y);
    return (desc ? -c : c) || a.slug.localeCompare(b.slug);
  };
}
