import { defineConfig } from "prisma/config";

// Prisma 7: datasource URL lives here, not in schema.prisma.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://agenticweb:agenticweb_dev_only@localhost:5432/agenticweb" },
});
