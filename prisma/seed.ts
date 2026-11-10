import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const url = process.env.DATABASE_URL ?? "postgresql://agenticweb:agenticweb_dev_only@localhost:5432/agenticweb";
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

async function main() {
  const org = await db.organization.upsert({
    where: { slug: "northwind-studio" },
    update: {},
    create: { slug: "northwind-studio", name: "Northwind Studio", timezone: "Asia/Kolkata" },
  });
  await db.user.upsert({
    where: { organizationId_email: { organizationId: org.id, email: "admin@northwind.example" } },
    update: {}, create: { organizationId: org.id, email: "admin@northwind.example", name: "Studio Admin", role: "admin" },
  });
  await db.user.upsert({
    where: { organizationId_email: { organizationId: org.id, email: "customer@example.com" } },
    update: {}, create: { organizationId: org.id, email: "customer@example.com", name: "Demo Customer" },
  });
  const services = [
    { slug: "architecture-review", name: "Architecture Review", description: "Deep-dive review of your system design with written recommendations.", durationMinutes: 90, priceMinor: 1500000 },
    { slug: "strategy-session", name: "Strategy Session", description: "Focused 1:1 session on roadmap and technical strategy.", durationMinutes: 60, priceMinor: 900000 },
    { slug: "quick-consult", name: "Quick Consult", description: "30-minute answer-your-questions call.", durationMinutes: 30, priceMinor: 400000 },
  ];
  for (const s of services) {
    const svc = await db.service.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: s.slug } },
      update: {}, create: { ...s, organizationId: org.id, currency: "INR" },
    });
    // Weekday slots for the next 14 days at 05:00 and 09:30 UTC (10:30 / 15:00 IST).
    for (let d = 1; d <= 14; d++) {
      const day = new Date(); day.setUTCHours(0, 0, 0, 0); day.setUTCDate(day.getUTCDate() + d);
      if ([0, 6].includes(day.getUTCDay())) continue;
      for (const [h, m] of [[5, 0], [9, 30]] as const) {
        const startsAt = new Date(day); startsAt.setUTCHours(h, m);
        const endsAt = new Date(startsAt.getTime() + s.durationMinutes * 60_000);
        await db.slot.upsert({
          where: { serviceId_startsAt: { serviceId: svc.id, startsAt } },
          update: {}, create: { serviceId: svc.id, startsAt, endsAt },
        });
      }
    }
  }
}

main().then(() => db.$disconnect()).catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
