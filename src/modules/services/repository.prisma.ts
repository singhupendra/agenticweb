import type { PrismaClient } from "@/generated/prisma/client";
import type { Service } from "./schemas";
import type { ServiceRepository } from "./service";

type Row = { id: string; slug: string; name: string; description: string; durationMinutes: number; priceMinor: number; currency: string };
const map = (r: Row): Service => ({
  id: r.id, slug: r.slug, name: r.name, description: r.description,
  durationMinutes: r.durationMinutes, priceMinor: r.priceMinor, currency: r.currency,
});

export function createPrismaServiceRepository(db: PrismaClient): ServiceRepository {
  return {
    async listActive(organizationId, { offset, limit, q, maxPriceMinor, sort = "name" }) {
      const where = {
        organizationId, active: true,
        ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
        ...(maxPriceMinor !== undefined ? { priceMinor: { lte: maxPriceMinor } } : {}),
      };
      const dir = sort.startsWith("-") ? ("desc" as const) : ("asc" as const);
      const key = sort.replace("-", "") as "name" | "priceMinor" | "durationMinutes";
      const [rows, total] = await Promise.all([
        db.service.findMany({ where, orderBy: [{ [key]: dir }, { slug: "asc" }], skip: offset, take: limit }),
        db.service.count({ where }),
      ]);
      return { items: rows.map(map), total };
    },
    async findActiveBySlug(organizationId, slug) {
      const r = await db.service.findFirst({ where: { organizationId, slug, active: true } });
      return r && map(r);
    },
  };
}
