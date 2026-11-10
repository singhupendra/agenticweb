import type { Metadata } from "next";
import Link from "next/link";
import { AppError } from "@/core/errors";
import { formatSlotStart } from "@/modules/bookings/present";
import { MY_BOOKINGS_PAGE_SIZE, currentActor, getOrganization, listMyBookings, listServices } from "../_lib/data";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "My bookings", robots: { index: false, follow: false } };

const STATUS_TEXT = { pending: "Pending", confirmed: "Confirmed", cancelled: "Cancelled" } as const;
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700";

export default async function MyBookingsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const actor = await currentActor();
  if (actor.kind === "anonymous") {
    return (
      <>
        <h1 className="text-3xl font-semibold">My bookings</h1>
        <p role="status" data-testid="signin-required" className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <a className={`underline ${focus}`} href={`/api/auth/login?returnTo=${encodeURIComponent("/bookings")}`}>Sign in</a> to see your bookings.
        </p>
      </>
    );
  }
  const page = Math.max(1, Math.min(10_000, Number.parseInt((await searchParams).page ?? "1", 10) || 1));
  let list;
  try {
    list = await listMyBookings(actor, page);
  } catch (e) {
    if (e instanceof AppError && (e.code === "unauthenticated" || e.code === "forbidden")) {
      return <p role="alert" className="mt-4 text-sm">Your session cannot list bookings. Try signing in again.</p>;
    }
    throw e;
  }
  const [org, services] = await Promise.all([getOrganization(), listServices()]);
  const nameOf = (id: string) => services.find((s) => s.id === id)?.name ?? "Consulting session";
  const lastPage = Math.max(1, Math.ceil(list.total / MY_BOOKINGS_PAGE_SIZE));
  return (
    <>
      <h1 className="text-3xl font-semibold">My bookings</h1>
      {list.items.length === 0 ? (
        <p data-testid="no-bookings" className="mt-4 text-sm">
          You have no bookings yet. <Link className={`underline ${focus}`} href="/services">Browse services</Link>.
        </p>
      ) : (
        <ul data-testid="booking-list" className="mt-6 divide-y divide-zinc-200 border-y border-zinc-200">
          {list.items.map((b) => (
            <li key={b.id} data-testid="booking-item" className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="font-medium">{nameOf(b.serviceId)}</p>
                <p className="text-sm text-zinc-700">
                  <time data-testid="booking-starts" dateTime={b.slotStartsAt}>{formatSlotStart(b.slotStartsAt, org.timezone)}</time>
                </p>
              </div>
              <div className="flex items-center gap-4 text-sm">
                <span data-testid="booking-status" className="rounded border border-zinc-400 px-2 py-0.5">{STATUS_TEXT[b.status]}</span>
                <Link className={`underline ${focus}`} href={`/bookings/${b.id}`}>Details<span className="sr-only"> for {nameOf(b.serviceId)} on {formatSlotStart(b.slotStartsAt, org.timezone)}</span></Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      {lastPage > 1 ? (
        <nav aria-label="Pagination" className="mt-6 flex items-center gap-4 text-sm">
          {list.page > 1 ? <Link className={`underline ${focus}`} href={`/bookings?page=${list.page - 1}`} rel="prev">Previous</Link> : null}
          <span>Page {list.page} of {lastPage}</span>
          {list.page < lastPage ? <Link className={`underline ${focus}`} href={`/bookings?page=${list.page + 1}`} rel="next">Next</Link> : null}
        </nav>
      ) : null}
    </>
  );
}
