import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "../env";

/**
 * Pin the Postgres SESSION time zone to UTC. Prisma's pg adapter sends JS Dates as zone-less timestamps and reads timestamptz
 * back without its offset, so on a database whose time zone is not UTC every stored instant is silently shifted by the zone
 * offset (e.g. past-slot cancellation was allowed on an Asia/Kolkata database). Found by the agentic QA suite.
 */
export const PG_POOL_OPTIONS = { options: "-c timezone=UTC" } as const;

let client: PrismaClient | undefined;
export function getPrisma(): PrismaClient {
  return (client ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: getEnv().DATABASE_URL, ...PG_POOL_OPTIONS }) }));
}
export * from "./stores";
