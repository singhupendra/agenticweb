import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { Slot } from "./schemas";
import type { BookingRecord, BookingRepository, ReserveResult } from "./service";

type BookingRow = {
  id: string; slotId: string; userId: string; organizationId: string; status: "pending" | "confirmed" | "cancelled";
  notes: string | null; createdAt: Date; slot: { serviceId: string };
};
const toRecord = (r: BookingRow): BookingRecord => ({
  id: r.id, slotId: r.slotId, serviceId: r.slot.serviceId, status: r.status, notes: r.notes,
  createdAt: r.createdAt.toISOString(), userId: r.userId, organizationId: r.organizationId,
});
const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

export function createPrismaBookingRepository(db: PrismaClient): BookingRepository {
  return {
    async listAvailableSlots(q) {
      const range = Prisma.sql`${q.from ? Prisma.sql`AND s."startsAt" >= ${q.from}` : Prisma.empty} ${q.to ? Prisma.sql`AND s."startsAt" <= ${q.to}` : Prisma.empty}`;
      const base = Prisma.sql`
        SELECT s.id, s."serviceId", s."startsAt", s."endsAt",
               (s.capacity - COUNT(b.id) FILTER (WHERE b.status <> 'cancelled'))::int AS remaining
        FROM "Slot" s
        JOIN "Service" sv ON sv.id = s."serviceId"
        LEFT JOIN "Booking" b ON b."slotId" = s.id
        WHERE s."serviceId" = ${q.serviceId}::uuid AND sv."organizationId" = ${q.organizationId}::uuid
          AND sv.active AND s."startsAt" > ${q.now} ${range}
        GROUP BY s.id
        HAVING s.capacity - COUNT(b.id) FILTER (WHERE b.status <> 'cancelled') > 0`;
      const [rows, count] = await Promise.all([
        db.$queryRaw<{ id: string; serviceId: string; startsAt: Date; endsAt: Date; remaining: number }[]>(
          Prisma.sql`${base} ORDER BY s."startsAt" ASC, s.id ASC LIMIT ${q.limit} OFFSET ${q.offset}`),
        db.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS n FROM (${base}) t`),
      ]);
      const items: Slot[] = rows.map((r) => ({
        id: r.id, serviceId: r.serviceId, startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(), remaining: r.remaining,
      }));
      return { items, total: count[0]?.n ?? 0 };
    },

    async reserve(q): Promise<ReserveResult> {
      try {
        return await db.$transaction(async (tx) => {
          // Row lock on the slot serialises concurrent reservations of the same slot.
          const rows = await tx.$queryRaw<{ id: string; capacity: number; startsAt: Date; organizationId: string; active: boolean }[]>`
            SELECT s.id, s.capacity, s."startsAt", sv."organizationId", sv.active
            FROM "Slot" s JOIN "Service" sv ON sv.id = s."serviceId"
            WHERE s.id = ${q.slotId}::uuid FOR UPDATE OF s`;
          const slot = rows[0];
          if (!slot || slot.organizationId !== q.organizationId || !slot.active) return { ok: false, reason: "not_found" } as const;
          if (slot.startsAt <= q.now) return { ok: false, reason: "past" } as const;
          const [taken, mine] = await Promise.all([
            tx.booking.count({ where: { slotId: q.slotId, status: { not: "cancelled" } } }),
            tx.booking.count({ where: { slotId: q.slotId, userId: q.userId, status: { not: "cancelled" } } }),
          ]);
          if (mine > 0) return { ok: false, reason: "duplicate" } as const;
          if (taken >= slot.capacity) return { ok: false, reason: "full" } as const;
          const b = await tx.booking.create({
            data: { organizationId: q.organizationId, slotId: q.slotId, userId: q.userId, status: "confirmed", notes: q.notes ?? null },
            include: { slot: { select: { serviceId: true } } },
          });
          return { ok: true, booking: toRecord(b) } as const;
        });
      } catch (e) {
        if (isUniqueViolation(e)) return { ok: false, reason: "duplicate" }; // partial unique index backstop
        throw e;
      }
    },

    async findById(organizationId, bookingId) {
      const b = await db.booking.findFirst({ where: { id: bookingId, organizationId }, include: { slot: { select: { serviceId: true } } } });
      return b && toRecord(b);
    },

    async listByUser(organizationId, userId, { offset, limit }) {
      const where = { organizationId, userId };
      const [rows, total] = await Promise.all([
        db.booking.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: offset, take: limit, include: { slot: { select: { serviceId: true } } } }),
        db.booking.count({ where }),
      ]);
      return { items: rows.map(toRecord), total };
    },

    async cancel({ organizationId, bookingId, now }) {
      // Single conditional UPDATE: the status/start-time checks and the transition are one atomic statement.
      const updated = await db.$queryRaw<{ id: string }[]>`
        UPDATE "Booking" b SET status = 'cancelled', "updatedAt" = now()
        FROM "Slot" s
        WHERE b.id = ${bookingId}::uuid AND b."organizationId" = ${organizationId}::uuid
          AND b."slotId" = s.id AND b.status <> 'cancelled' AND s."startsAt" > ${now}
        RETURNING b.id`;
      // Read back to return the row and classify a no-op (unknown / already cancelled / slot started).
      const b = await db.booking.findFirst({ where: { id: bookingId, organizationId }, include: { slot: { select: { serviceId: true, startsAt: true } } } });
      if (!b) return { ok: false, reason: "not_found" };
      if (updated.length === 1 || b.status === "cancelled") return { ok: true, booking: toRecord(b) };
      return { ok: false, reason: "started" };
    },
  };
}
