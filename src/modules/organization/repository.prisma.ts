import type { PrismaClient } from "@/generated/prisma/client";
import type { OrganizationRepository } from "./service";

export function createPrismaOrganizationRepository(db: PrismaClient): OrganizationRepository {
  return {
    async findBySlug(slug) {
      const o = await db.organization.findUnique({ where: { slug } });
      return o && { id: o.id, slug: o.slug, name: o.name, timezone: o.timezone };
    },
  };
}
