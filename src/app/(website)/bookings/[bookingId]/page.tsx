import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CancelBookingForm } from "@/app/components/cancel-booking-form";
import { AppError } from "@/core/errors";
import { formatSlotStart } from "@/modules/bookings/present";
import { currentActor, getBooking, getOrganization, isNotFound, listServices } from "../../_lib/data";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Booking status", robots: { index: false, follow: false } };

const STATUS_TEXT = { pending: "Pending", confirmed: "Confirmed", cancelled: "Cancelled" } as const;

export default async function BookingPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = await params;
  const actor = await currentActor();
  if (actor.kind === "anonymous") {
    return (
      <>
        <h1 className="text-3xl font-semibold">Booking status</h1>
        <p role="status" data-testid="signin-required" className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          Sign in to view this booking.
        </p>
      </>
    );
  }
  let booking;
  try {
    booking = await getBooking(actor, bookingId);
  } catch (e) {
    if (isNotFound(e) || (e instanceof AppError && e.code === "forbidden")) notFound();
    throw e;
  }
  const [org, services] = await Promise.all([getOrganization(), listServices()]);
  const service = services.find((s) => s.id === booking.serviceId);
  return (
    <>
      <Link href="/services" className="text-sm underline">← Services</Link>
      <h1 className="mt-4 text-3xl font-semibold">Booking status</h1>
      <p role="status" data-testid="booking-status" className="mt-3 inline-block rounded border border-zinc-400 px-3 py-1 text-sm font-medium">
        {STATUS_TEXT[booking.status]}
      </p>
      <dl className="mt-6 space-y-3 text-sm">
        <div><dt className="text-zinc-600">Service</dt><dd className="font-medium">{service?.name ?? "Consulting session"}</dd></div>
        <div><dt className="text-zinc-600">Reference</dt><dd className="break-all font-mono">{booking.id}</dd></div>
        <div><dt className="text-zinc-600">Booked on</dt><dd>{formatSlotStart(booking.createdAt, org.timezone)}</dd></div>
        {booking.notes ? <div><dt className="text-zinc-600">Notes</dt><dd className="whitespace-pre-wrap">{booking.notes}</dd></div> : null}
      </dl>
      {booking.status !== "cancelled" ? (
        <div className="mt-8"><CancelBookingForm bookingId={booking.id} idempotencyKey={randomUUID()} /></div>
      ) : null}
    </>
  );
}
