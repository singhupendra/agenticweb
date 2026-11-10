"use client";
import { useActionState } from "react";
import { cancelBookingAction, type FormState } from "@/app/(website)/_actions/bookings";
import { Button, FormError } from "./form-parts";

export function CancelBookingForm({ bookingId, idempotencyKey }: { bookingId: string; idempotencyKey: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(cancelBookingAction, {});
  return (
    <form action={action} data-testid="cancel-form">
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Button type="submit" pending={pending}>{pending ? "Cancelling…" : "Cancel booking"}</Button>
      <FormError state={state} />
    </form>
  );
}
