import { defineCapability, type CapabilityContext } from "@/core/capabilities";
import { requireUserId } from "@/core/auth";
import { paginatedSchema } from "@/core/errors";
import type { ResourceRef } from "@/core/authorization";
import type { OrganizationService } from "@/modules/organization/service";
import type { BookingsService } from "./service";
import {
  BookingSchema, CancelBookingInput, CreateBookingInput, GetBookingInput, ListMyBookingsInput, ListSlotsInput, SlotSchema,
} from "./schemas";

export interface BookingsDeps {
  bookings: BookingsService;
  organizations: OrganizationService;
}
type Ctx = CapabilityContext<BookingsDeps>;

/** Facts for org-scoped capabilities: the tenant of the addressed organization (blocks cross-tenant actors). */
const orgResource = async (ctx: Ctx, orgSlug: string): Promise<ResourceRef> => {
  const org = await ctx.deps.organizations.getBySlug(orgSlug);
  return { type: "organization", id: org.id, organizationId: org.id };
};
const bookingResource = async (ctx: Ctx, orgSlug: string, bookingId: string): Promise<ResourceRef | null> => {
  try {
    const b = await ctx.deps.bookings.get(orgSlug, bookingId);
    return { type: "booking", id: b.id, ownerId: b.userId, organizationId: b.organizationId };
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === "not_found") return null;
    throw e;
  }
};
const publicBooking = BookingSchema; // output schema strips userId/organizationId

export const listSlots = defineCapability({
  name: "slots.list",
  summary: "List upcoming available time slots for a service (paginated, soonest first).",
  input: ListSlotsInput,
  output: paginatedSchema(SlotSchema),
  requirement: { access: "public", scope: "services:read" },
  mutating: false,
  http: { method: "GET", path: "/api/organizations/{orgSlug}/services/{serviceSlug}/slots" },
  mcp: { toolName: "list_slots", exposed: true, description: "List upcoming bookable slots for a service, optionally between `from` and `to` (ISO-8601)." },
  execute: (ctx: Ctx, i) => ctx.deps.bookings.listSlots({ ...i, page: i.page, pageSize: i.pageSize, now: ctx.now }),
});

export const createBooking = defineCapability({
  name: "bookings.create",
  summary: "Book a slot for the authenticated user. Requires an Idempotency-Key.",
  input: CreateBookingInput,
  output: publicBooking,
  requirement: { access: "authenticated", scope: "bookings:write" },
  mutating: true,
  http: { method: "POST", path: "/api/organizations/{orgSlug}/bookings", successStatus: 201 },
  mcp: { toolName: "create_booking", exposed: true, description: "Book a slot for the user you act for. Requires an idempotencyKey; retry with the same key is safe." },
  loadResource: (ctx: Ctx, i) => orgResource(ctx, i.orgSlug),
  execute: (ctx: Ctx, i) =>
    ctx.deps.bookings.create({ orgSlug: i.orgSlug, userId: requireUserId(ctx.actor), slotId: i.slotId, notes: i.notes, now: ctx.now }),
});

export const listMyBookings = defineCapability({
  name: "bookings.list",
  summary: "List the authenticated user's own bookings.",
  input: ListMyBookingsInput,
  output: paginatedSchema(publicBooking),
  requirement: { access: "authenticated", scope: "bookings:read" },
  mutating: false,
  http: { method: "GET", path: "/api/organizations/{orgSlug}/bookings" },
  mcp: { toolName: "list_my_bookings", exposed: true, description: "List the bookings of the user you act for." },
  loadResource: (ctx: Ctx, i) => orgResource(ctx, i.orgSlug),
  execute: (ctx: Ctx, i) => ctx.deps.bookings.listMine({ orgSlug: i.orgSlug, userId: requireUserId(ctx.actor), page: i.page, pageSize: i.pageSize }),
});

export const getBooking = defineCapability({
  name: "bookings.get",
  summary: "Get one booking (owner or admin).",
  input: GetBookingInput,
  output: publicBooking,
  requirement: { access: "owner-or-admin", scope: "bookings:read" },
  mutating: false,
  http: { method: "GET", path: "/api/organizations/{orgSlug}/bookings/{bookingId}" },
  mcp: { toolName: "get_booking", exposed: true, description: "Get one of the user's bookings by id." },
  loadResource: (ctx: Ctx, i) => bookingResource(ctx, i.orgSlug, i.bookingId),
  execute: (ctx: Ctx, i) => ctx.deps.bookings.get(i.orgSlug, i.bookingId),
});

export const cancelBooking = defineCapability({
  name: "bookings.cancel",
  summary: "Cancel a booking (owner or admin). Requires an Idempotency-Key.",
  input: CancelBookingInput,
  output: publicBooking,
  requirement: { access: "owner-or-admin", scope: "bookings:write" },
  mutating: true,
  http: { method: "POST", path: "/api/organizations/{orgSlug}/bookings/{bookingId}/cancel" },
  mcp: { toolName: "cancel_booking", exposed: true, description: "Cancel one of the user's bookings. Requires an idempotencyKey." },
  loadResource: (ctx: Ctx, i) => bookingResource(ctx, i.orgSlug, i.bookingId),
  execute: (ctx: Ctx, i) => ctx.deps.bookings.cancel({ orgSlug: i.orgSlug, bookingId: i.bookingId, now: ctx.now }),
});
