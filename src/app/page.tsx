import Link from "next/link";
import { getEnv } from "@/core/env";
import { ANONYMOUS } from "@/core/auth";
import { AppError } from "@/core/errors";
import { getRuntime } from "@/runtime";
import { formatDuration, formatPrice } from "@/modules/services/present";
import type { Organization } from "@/modules/organization/schemas";
import type { Service } from "@/modules/services/schemas";

export const dynamic = "force-dynamic";

async function load(): Promise<{ org: Organization; services: Service[] } | { error: string }> {
  const orgSlug = getEnv().DEFAULT_ORG_SLUG;
  const { executor } = getRuntime();
  try {
    const org = (await executor.invoke("organization.get", ANONYMOUS, { orgSlug })).data as Organization;
    const services = (await executor.invoke("services.list", ANONYMOUS, { orgSlug })).data as Service[];
    return { org, services };
  } catch (e) {
    return { error: e instanceof AppError ? e.message : "Something went wrong." };
  }
}

export default async function Home() {
  const result = await load();
  if ("error" in result) return <p role="alert" className="text-red-700">{result.error}</p>;
  const { org, services } = result;
  return (
    <>
      <h1 className="text-3xl font-semibold">{org.name}</h1>
      <p className="mt-2 text-zinc-600">Consulting sessions, booked by people or by your AI agent.</p>
      <ul className="mt-8 divide-y divide-zinc-200 rounded-lg border border-zinc-200">
        {services.map((s) => (
          <li key={s.id} className="p-4">
            <Link className="font-medium underline-offset-2 hover:underline" href={`/services/${s.slug}`}>{s.name}</Link>
            <p className="text-sm text-zinc-600">{s.description}</p>
            <p className="mt-1 text-sm">{formatDuration(s.durationMinutes)} · {formatPrice(s.priceMinor, s.currency)}</p>
          </li>
        ))}
      </ul>
      {services.length === 0 && <p className="mt-6 text-zinc-500">No services are available yet.</p>}
    </>
  );
}
