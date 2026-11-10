import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { breadcrumbJsonLd, serviceJsonLd } from "@/agents/discovery/jsonld";
import { BookingForm } from "@/app/components/booking-form";
import { JsonLd } from "@/app/components/json-ld";
import { getEnv } from "@/core/env";
import { formatSlotStart } from "@/modules/bookings/present";
import { formatDuration, formatPrice } from "@/modules/services/present";
import { currentActor, getOrganization, getService, isNotFound, listSlots } from "../../_lib/data";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ serviceSlug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  try {
    const s = await getService((await params).serviceSlug);
    return { title: s.name, description: s.description, alternates: { canonical: `${getEnv().APP_URL.replace(/\/$/, "")}/services/${s.slug}` } };
  } catch {
    return { title: "Service not found" };
  }
}

export default async function ServicePage({ params }: Props) {
  const { serviceSlug } = await params;
  const [service, org, slots, actor] = await Promise.all([
    getService(serviceSlug), getOrganization(), listSlots(serviceSlug), currentActor(),
  ]).catch((e) => {
    if (isNotFound(e)) notFound();
    throw e;
  });
  const baseUrl = getEnv().APP_URL;
  const canBook = actor.kind === "user" || actor.kind === "admin";
  const options = slots.map((s) => ({ id: s.id, label: formatSlotStart(s.startsAt, org.timezone), remaining: s.remaining }));
  return (
    <>
      <JsonLd
        data={[
          serviceJsonLd({ service, orgName: org.name, baseUrl }),
          breadcrumbJsonLd([
            { name: "Home", url: baseUrl },
            { name: "Services", url: `${baseUrl.replace(/\/$/, "")}/services` },
            { name: service.name, url: `${baseUrl.replace(/\/$/, "")}/services/${service.slug}` },
          ]),
        ]}
      />
      <nav aria-label="Breadcrumb" className="text-sm text-zinc-600">
        <ol className="flex gap-2">
          <li><Link className="underline" href="/services">Services</Link></li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">{service.name}</li>
        </ol>
      </nav>
      <h1 className="mt-4 text-3xl font-semibold">{service.name}</h1>
      <p className="mt-2 text-zinc-700">{service.description}</p>
      <dl className="mt-4 flex gap-8 text-sm">
        <div><dt className="text-zinc-600">Duration</dt><dd className="font-medium">{formatDuration(service.durationMinutes)}</dd></div>
        <div><dt className="text-zinc-600">Price</dt><dd className="font-medium">{formatPrice(service.priceMinor, service.currency)}</dd></div>
      </dl>

      <section aria-labelledby="availability-heading" className="mt-8">
        <h2 id="availability-heading" className="text-xl font-semibold">Availability</h2>
        <p className="mt-1 text-sm text-zinc-600">Times shown in {org.timezone}.</p>
        {options.length === 0 ? (
          <p className="mt-3 text-zinc-700">No upcoming slots are available right now. Please check back soon.</p>
        ) : canBook ? (
          <div className="mt-4"><BookingForm slots={options} idempotencyKey={randomUUID()} serviceName={service.name} /></div>
        ) : (
          <>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Upcoming slots">
              {options.map((o) => <li key={o.id} className="rounded border border-zinc-200 px-3 py-2 text-sm">{o.label}</li>)}
            </ul>
            <p role="status" data-testid="signin-required" className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
              Sign in to book. Online sign-in for people is not available yet; AI agents can already book through the API (see <a className="underline" href="/llms.txt">llms.txt</a>).
            </p>
          </>
        )}
      </section>
    </>
  );
}
