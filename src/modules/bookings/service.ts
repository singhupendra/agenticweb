import { conflict, notFound, type Paginated } from "@/core/errors";
import type { OrganizationService } from "@/modules/organization/service";
import type { ServiceCatalog } from "@/modules/services/service";
import type { Booking, Slot } from "./schemas";

/** Booking as stored: includes owner + tenant, which public output schemas strip. */
export interface BookingRecord extends Booking {
  userId: string;
  organizationId: string;
}

export type ReserveResult =
  | { ok: true; booking: BookingRecord }
  | { ok: false; reason: "not_found" | "past" | "full" | "duplicate" };
export type CancelResult =
  | { ok: true; booking: BookingRecord }
  | { ok: false; reason: "not_found" | "started" };

export interface BookingRepository {
  listAvailableSlots(q: {
    organizationId: string; serviceId: string; now: Date; from?: Date; to?: Date; offset: number; limit: number;
  }): Promise<{ items: Slot[]; total: number }>;
  /** MUST be atomic: capacity is never exceeded under concurrency. */
  reserve(q: { organizationId: string; userId: string; slotId: string; notes?: string; now: Date }): Promise<ReserveResult>;
  findById(organizationId: string, bookingId: string): Promise<BookingRecord | null>;
  listByUser(organizationId: string, userId: string, page: { offset: number; limit: number }): Promise<{ items: BookingRecord[]; total: number }>;
  cancel(q: { organizationId: string; bookingId: string; now: Date }): Promise<CancelResult>;
}

/** Contract used by capabilities. Identity (userId) always comes from the Actor, never from input. */
export interface BookingsService {
  listSlots(q: { orgSlug: string; serviceSlug: string; from?: string; to?: string; page: number; pageSize: number; now: Date }): Promise<Paginated<Slot>>;
  create(q: { orgSlug: string; userId: string; slotId: string; notes?: string; now: Date }): Promise<BookingRecord>;
  get(orgSlug: string, bookingId: string): Promise<BookingRecord>;
  listMine(q: { orgSlug: string; userId: string; page: number; pageSize: number }): Promise<Paginated<BookingRecord>>;
  cancel(q: { orgSlug: string; bookingId: string; now: Date }): Promise<BookingRecord>;
}

export function createBookingsService(deps: {
  organizations: OrganizationService;
  catalog: ServiceCatalog;
  repo: BookingRepository;
}): BookingsService {
  return {
    async listSlots(q) {
      const org = await deps.organizations.getBySlug(q.orgSlug);
      const svc = await deps.catalog.get(q.orgSlug, q.serviceSlug);
      const { items, total } = await deps.repo.listAvailableSlots({
        organizationId: org.id, serviceId: svc.id, now: q.now,
        from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined,
        offset: (q.page - 1) * q.pageSize, limit: q.pageSize,
      });
      return { items, page: q.page, pageSize: q.pageSize, total };
    },
    async create(q) {
      const org = await deps.organizations.getBySlug(q.orgSlug);
      const r = await deps.repo.reserve({ organizationId: org.id, userId: q.userId, slotId: q.slotId, notes: q.notes, now: q.now });
      if (r.ok) return r.booking;
      switch (r.reason) {
        case "not_found": throw notFound("Slot");
        case "past": throw conflict("This slot has already started.");
        case "full": throw conflict("This slot is fully booked.");
        case "duplicate": throw conflict("You already have an active booking for this slot.");
      }
    },
    async get(orgSlug, bookingId) {
      const org = await deps.organizations.getBySlug(orgSlug);
      const b = await deps.repo.findById(org.id, bookingId);
      if (!b) throw notFound("Booking");
      return b;
    },
    async listMine(q) {
      const org = await deps.organizations.getBySlug(q.orgSlug);
      const { items, total } = await deps.repo.listByUser(org.id, q.userId, { offset: (q.page - 1) * q.pageSize, limit: q.pageSize });
      return { items, page: q.page, pageSize: q.pageSize, total };
    },
    async cancel(q) {
      const org = await deps.organizations.getBySlug(q.orgSlug);
      const r = await deps.repo.cancel({ organizationId: org.id, bookingId: q.bookingId, now: q.now });
      if (r.ok) return r.booking;
      if (r.reason === "started") throw conflict("This slot has already started and can no longer be cancelled.");
      throw notFound("Booking");
    },
  };
}
