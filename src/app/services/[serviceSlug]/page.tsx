import Link from "next/link";
import { notFound } from "next/navigation";
import { ANONYMOUS } from "@/core/auth";
import { AppError } from "@/core/errors";
import { getEnv } from "@/core/env";
import { getRuntime } from "@/runtime";
import { formatDuration, formatPrice } from "@/modules/services/present";
import { formatSlotStart } from "@/modules/bookings/present";
import type { Slot } from "@/modules/bookings/schemas";
import type { Organization } from "@/modules/organization/schemas";
import type { Service } from "@/modules/services/schemas";

export const dynamic = "force-dynamic";

export default async function ServicePage({ params }: { params: Promise<{ serviceSlug: string }> }) {
  const { serviceSlug } = await params;
  const orgSlug = getEnv().DEFAULT_ORG_SLUG;
  const { executor } = getRuntime();
  let s: Service;
  let org: Organization;
  let slots: Slot[];
  try {
    s = (await executor.invoke("services.get", ANONYMOUS, { orgSlug, serviceSlug })).data as Service;
    org = (await executor.invoke("organization.get", ANONYMOUS, { orgSlug })).data as Organization;
    slots = (await executor.invoke("slots.list", ANONYMOUS, { orgSlug, serviceSlug, pageSize: 10 })).data as Slot[];
  } catch (e) {
    if (e instanceof AppError && (e.code === "not_found" || e.code === "validation_failed")) notFound();
    throw e;
  }
  return (
    <>
      <Link href="/" className="text-sm text-zinc-500 hover:underline">← All services</Link>
      <h1 className="mt-4 text-3xl font-semibold">{s.name}</h1>
      <p className="mt-2 text-zinc-700">{s.description}</p>
      <p className="mt-4">{formatDuration(s.durationMinutes)} · {formatPrice(s.priceMinor, s.currency)}</p>
      <h2 className="mt-8 text-lg font-medium">Next available slots</h2>
      {slots.length === 0 ? (
        <p className="mt-2 text-zinc-500">No upcoming slots.</p>
      ) : (
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {slots.map((slot) => (
            <li key={slot.id} className="rounded border border-zinc-200 px-3 py-2 text-sm">
              {formatSlotStart(slot.startsAt, org.timezone)}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 text-sm text-zinc-500">Online booking by people arrives with sign-in (Phase 3). Agents can book today via the API.</p>
    </>
  );
}
