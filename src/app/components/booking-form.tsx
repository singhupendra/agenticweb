"use client";
import { useActionState } from "react";
import { createBookingAction, type FormState } from "@/app/(website)/_actions/bookings";
import { Button, FormError, focusRing } from "./form-parts";

export interface SlotOption { id: string; label: string; remaining: number }

/** Accessible booking form. `idempotencyKey` is generated per render so a double submit books once. */
export function BookingForm({ slots, idempotencyKey, serviceName }: { slots: SlotOption[]; idempotencyKey: string; serviceName: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createBookingAction, {});
  const slotError = state.fieldErrors?.slotId;
  const notesError = state.fieldErrors?.notes;
  return (
    <form action={action} aria-label={`Book ${serviceName}`} data-testid="booking-form" noValidate>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <fieldset aria-describedby={slotError ? "slot-error" : undefined} aria-invalid={slotError ? true : undefined}>
        <legend className="text-sm font-medium">Choose a time (required)</legend>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {slots.map((s) => (
            <li key={s.id}>
              <label className={`flex cursor-pointer items-center gap-2 rounded border border-zinc-300 px-3 py-2 text-sm has-[:checked]:border-blue-800 has-[:checked]:bg-blue-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-blue-700`}>
                <input type="radio" name="slotId" value={s.id} required />
                <span>{s.label}{s.remaining <= 3 ? <span className="text-zinc-600"> · {s.remaining} left</span> : null}</span>
              </label>
            </li>
          ))}
        </ul>
        {slotError ? <p id="slot-error" className="mt-1 text-sm text-red-800">{slotError}</p> : null}
      </fieldset>
      <div className="mt-4">
        <label htmlFor="notes" className="block text-sm font-medium">Notes (optional)</label>
        <textarea
          id="notes" name="notes" rows={3} maxLength={1000}
          aria-describedby={notesError ? "notes-error" : "notes-hint"}
          aria-invalid={notesError ? true : undefined}
          className={`mt-1 w-full rounded border border-zinc-400 px-3 py-2 text-sm ${focusRing}`}
        />
        <p id="notes-hint" className="text-xs text-zinc-600">Up to 1000 characters.</p>
        {notesError ? <p id="notes-error" className="text-sm text-red-800">{notesError}</p> : null}
      </div>
      <FormError state={state} />
      <div className="mt-4">
        <Button type="submit" pending={pending}>{pending ? "Booking…" : "Confirm booking"}</Button>
      </div>
    </form>
  );
}
