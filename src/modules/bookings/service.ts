import type { Actor } from "@/core/auth";
import type { Paginated } from "@/core/errors";
import type { z } from "zod";
import type { Booking, CancelBookingInput, CreateBookingInput, ListMyBookingsInput, ListSlotsInput, Slot } from "./schemas";

/** CONTRACT ONLY. Implementations are Phase 2; they must be transactional against overbooking. */
export interface SlotQueries {
  listAvailable(input: z.output<typeof ListSlotsInput>): Promise<Paginated<Slot>>;
}
export interface BookingService {
  create(actor: Actor, input: z.output<typeof CreateBookingInput>): Promise<Booking>;
  cancel(actor: Actor, input: z.output<typeof CancelBookingInput>): Promise<Booking>;
  listMine(actor: Actor, input: z.output<typeof ListMyBookingsInput>): Promise<Paginated<Booking>>;
}
