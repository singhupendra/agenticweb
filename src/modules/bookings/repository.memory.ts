import { randomUUID } from "node:crypto";
import type { Slot } from "./schemas";
import type { BookingRecord, BookingRepository, CancelResult, ReserveResult, UpdateResult } from "./service";

export interface MemorySlot {
  id: string; serviceId: string; organizationId: string; serviceActive: boolean;
  startsAt: Date; endsAt: Date; capacity: number;
}

/** Test double with the same semantics as the Prisma repository (single-threaded ⇒ trivially atomic). */
export class InMemoryBookingRepository implements BookingRepository {
  readonly bookings: BookingRecord[] = [];
  constructor(private readonly slots: MemorySlot[] = []) {}

  private active(slotId: string) {
    return this.bookings.filter((b) => b.slotId === slotId && b.status !== "cancelled");
  }
  private toSlot(s: MemorySlot): Slot {
    return { id: s.id, serviceId: s.serviceId, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), remaining: s.capacity - this.active(s.id).length };
  }

  async listAvailableSlots(q: Parameters<BookingRepository["listAvailableSlots"]>[0]) {
    const all = this.slots
      .filter((s) => s.organizationId === q.organizationId && s.serviceId === q.serviceId && s.serviceActive)
      .filter((s) => s.startsAt > q.now && (!q.from || s.startsAt >= q.from) && (!q.to || s.startsAt <= q.to))
      .filter((s) => s.capacity - this.active(s.id).length > 0)
      .sort((a, b) => (a.startsAt.getTime() - b.startsAt.getTime()) * (q.sort === "-startsAt" ? -1 : 1));
    return { items: all.slice(q.offset, q.offset + q.limit).map((s) => this.toSlot(s)), total: all.length };
  }

  async reserve(q: Parameters<BookingRepository["reserve"]>[0]): Promise<ReserveResult> {
    const s = this.slots.find((x) => x.id === q.slotId);
    if (!s || s.organizationId !== q.organizationId || !s.serviceActive) return { ok: false, reason: "not_found" };
    if (s.startsAt <= q.now) return { ok: false, reason: "past" };
    const active = this.active(s.id);
    if (active.some((b) => b.userId === q.userId)) return { ok: false, reason: "duplicate" };
    if (active.length >= s.capacity) return { ok: false, reason: "full" };
    const booking: BookingRecord = {
      id: randomUUID(), slotId: s.id, serviceId: s.serviceId, status: "confirmed", notes: q.notes ?? null,
      createdAt: q.now.toISOString(), userId: q.userId, organizationId: q.organizationId,
    };
    this.bookings.push(booking);
    return { ok: true, booking };
  }

  async findById(organizationId: string, id: string) {
    return this.bookings.find((b) => b.id === id && b.organizationId === organizationId) ?? null;
  }
  async listByUser(organizationId: string, userId: string, p: Parameters<BookingRepository["listByUser"]>[2]) {
    const dir = p.sort === "createdAt" ? 1 : -1;
    const all = this.bookings
      .filter((b) => b.organizationId === organizationId && b.userId === userId && (!p.status || b.status === p.status))
      .sort((a, b) => (a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) * dir);
    return { items: all.slice(p.offset, p.offset + p.limit), total: all.length };
  }
  async updateNotes(q: { organizationId: string; bookingId: string; notes: string | null }): Promise<UpdateResult> {
    const b = this.bookings.find((x) => x.id === q.bookingId && x.organizationId === q.organizationId);
    if (!b) return { ok: false, reason: "not_found" };
    if (b.status === "cancelled") return { ok: false, reason: "cancelled" };
    b.notes = q.notes;
    return { ok: true, booking: b };
  }
  async cancel(q: { organizationId: string; bookingId: string; now: Date }): Promise<CancelResult> {
    const b = this.bookings.find((x) => x.id === q.bookingId && x.organizationId === q.organizationId);
    if (!b) return { ok: false, reason: "not_found" };
    if (b.status === "cancelled") return { ok: true, booking: b };
    const s = this.slots.find((x) => x.id === b.slotId);
    if (s && s.startsAt <= q.now) return { ok: false, reason: "started" };
    b.status = "cancelled";
    return { ok: true, booking: b };
  }
}
