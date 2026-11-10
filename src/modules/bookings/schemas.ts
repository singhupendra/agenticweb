/**
 * Slot/booking contracts. Single source of truth for slot/booking shapes in REST, MCP and UI.
 * Rules: organizationId/userId/status are NEVER accepted from input; the actor and server decide them.
 */
import { z } from "zod";
import { idSchema, isoDateTime, pageInputShape, slugSchema } from "@/core/validation";

export const BookingStatusSchema = z.enum(["pending", "confirmed", "cancelled"]);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const SlotSchema = z.object({
  id: idSchema,
  serviceId: idSchema,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  remaining: z.number().int().nonnegative(),
});
export type Slot = z.infer<typeof SlotSchema>;

export const BookingSchema = z.object({
  id: idSchema,
  slotId: idSchema,
  serviceId: idSchema,
  status: BookingStatusSchema,
  notes: z.string().max(1000).nullable(),
  createdAt: isoDateTime,
});
export type Booking = z.infer<typeof BookingSchema>;

export const SlotSortSchema = z.enum(["startsAt", "-startsAt"]);
export type SlotSort = z.infer<typeof SlotSortSchema>;
export const BookingSortSchema = z.enum(["createdAt", "-createdAt"]);
export type BookingSort = z.infer<typeof BookingSortSchema>;

export const ListSlotsInput = z.strictObject({
  orgSlug: slugSchema,
  serviceSlug: slugSchema,
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  sort: SlotSortSchema.default("startsAt"),
  ...pageInputShape,
});
export const CreateBookingInput = z.strictObject({
  orgSlug: slugSchema,
  slotId: idSchema,
  notes: z.string().max(1000).optional(),
});
export const CancelBookingInput = z.strictObject({ orgSlug: slugSchema, bookingId: idSchema });
export const ListMyBookingsInput = z.strictObject({
  orgSlug: slugSchema,
  status: BookingStatusSchema.optional(),
  sort: BookingSortSchema.default("-createdAt"),
  ...pageInputShape,
});
/** PATCH: only `notes` is mutable. `notes` is required so an empty patch is a validation error; null clears it. */
export const UpdateBookingInput = z.strictObject({ orgSlug: slugSchema, bookingId: idSchema, notes: z.string().max(1000).nullable() });
export const GetBookingInput = z.strictObject({ orgSlug: slugSchema, bookingId: idSchema });
