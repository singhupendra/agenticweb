import Link from "next/link";
import { notFound } from "next/navigation";
import { ANONYMOUS } from "@/core/auth";
import { AppError } from "@/core/errors";
import { getEnv } from "@/core/env";
import { getRuntime } from "@/runtime";
import { formatDuration, formatPrice } from "@/modules/services/present";
import type { Service } from "@/modules/services/schemas";

export const dynamic = "force-dynamic";

export default async function ServicePage({ params }: { params: Promise<{ serviceSlug: string }> }) {
  const { serviceSlug } = await params;
  let s: Service;
  try {
    s = (await getRuntime().executor.invoke("services.get", ANONYMOUS, { orgSlug: getEnv().DEFAULT_ORG_SLUG, serviceSlug })).data as Service;
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
      <p className="mt-6 text-sm text-zinc-500">Booking opens in Phase 2.</p>
    </>
  );
}
