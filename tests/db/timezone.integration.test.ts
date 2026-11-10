/**
 * Regression: instants must survive a Prisma round trip when the DATABASE time zone is not UTC (Prisma's pg adapter otherwise
 * stores/reads them shifted by the zone offset). Skipped unless DATABASE_URL_TEST is set; this test sets the (disposable) test
 * database's default zone to Asia/Kolkata for its duration so it is meaningful on UTC CI databases too.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PG_POOL_OPTIONS } from "@/core/db";

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("timestamps on a non-UTC database", () => {
  let db: PrismaClient;
  let admin: pg.Client;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const name = (await admin.query("SELECT current_database() AS n")).rows[0].n as string;
    await admin.query(`ALTER DATABASE "${name}" SET timezone = 'Asia/Kolkata'`);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url!, ...PG_POOL_OPTIONS }) });
  });
  afterAll(async () => {
    await db.$disconnect();
    const name = (await admin.query("SELECT current_database() AS n")).rows[0].n as string;
    await admin.query(`ALTER DATABASE "${name}" RESET timezone`);
    await admin.end();
  });

  it("Date parameters (writes and comparisons) and timestamptz reads agree with the real instant", async () => {
    // A private scratch table: other DB suites TRUNCATE the app tables concurrently (separate vitest workers).
    const table = `tz_probe_${Date.now()}`;
    await admin.query(`CREATE TABLE ${table} (id int PRIMARY KEY, at timestamptz NOT NULL)`);
    try {
      const t = new Date("2030-01-01T12:00:00.000Z");
      await db.$executeRawUnsafe(`INSERT INTO ${table} (id, at) VALUES (1, $1)`, t);
      const stored = await admin.query(`SELECT extract(epoch FROM at) * 1000 AS ms FROM ${table}`);
      expect(Number(stored.rows[0].ms)).toBe(t.getTime()); // stored instant is right (was shifted by 5.5 h)
      const raw = await db.$queryRawUnsafe<{ at: Date; later: boolean }[]>(`SELECT at, at > $1 AS later FROM ${table}`, new Date(t.getTime() - 1000));
      expect(raw[0]!.at.toISOString()).toBe(t.toISOString()); // raw read is right
      expect(raw[0]!.later).toBe(true); // Date-parameter comparison is right
    } finally {
      await admin.query(`DROP TABLE ${table}`);
    }
  });
});
