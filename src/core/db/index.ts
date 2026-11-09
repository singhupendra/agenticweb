import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "../env";

let client: PrismaClient | undefined;
export function getPrisma(): PrismaClient {
  return (client ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: getEnv().DATABASE_URL }) }));
}
