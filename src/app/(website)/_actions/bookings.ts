"use server";
/**
 * Server actions for the booking flow. They only translate form data → capability input and errors → UI state.
 * Validation, ownership, overbooking and idempotency are enforced by the capabilities (bookings.create / bookings.cancel).
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AppError } from "@/core/errors";
import { getRuntime } from "@/runtime";
import { currentActor, orgSlug } from "../_lib/data";

export interface FormState { error?: string; fieldErrors?: Record<string, string>; ok?: boolean }

function toState(e: unknown): FormState {
  if (!(e instanceof AppError)) return { error: "Something went wrong. Please try again." };
  if (e.code === "unauthenticated") return { error: "Please sign in to continue." };
  if (e.code === "validation_failed") {
    const fieldErrors = Object.fromEntries((e.errors ?? []).filter((i) => i.path).map((i) => [i.path, i.message]));
    return { error: e.message, fieldErrors };
  }
  return { error: e.code === "internal" ? "Something went wrong. Please try again." : e.message };
}

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

export async function createBookingAction(_prev: FormState, form: FormData): Promise<FormState> {
  const notes = str(form.get("notes")).trim();
  let bookingId: string;
  try {
    const { data } = await getRuntime().executor.invoke(
      "bookings.create",
      await currentActor(),
      { orgSlug: orgSlug(), slotId: str(form.get("slotId")), ...(notes ? { notes } : {}) },
      { idempotencyKey: str(form.get("idempotencyKey")) || undefined },
    );
    bookingId = (data as { id: string }).id;
  } catch (e) {
    return toState(e);
  }
  redirect(`/bookings/${bookingId}`);
}

export async function cancelBookingAction(_prev: FormState, form: FormData): Promise<FormState> {
  const bookingId = str(form.get("bookingId"));
  try {
    await getRuntime().executor.invoke(
      "bookings.cancel",
      await currentActor(),
      { orgSlug: orgSlug(), bookingId },
      { idempotencyKey: str(form.get("idempotencyKey")) || undefined },
    );
  } catch (e) {
    return toState(e);
  }
  revalidatePath(`/bookings/${bookingId}`);
  return { ok: true };
}
