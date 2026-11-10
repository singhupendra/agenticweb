import Link from "next/link";
import { formatDuration, formatPrice } from "@/modules/services/present";
import type { Service } from "@/modules/services/schemas";
import { focusRing } from "./form-parts";

export function ServiceList({ services, headingLevel: H = "h3" }: { services: Service[]; headingLevel?: "h2" | "h3" }) {
  if (services.length === 0) return <p className="text-zinc-600">No services are available yet.</p>;
  return (
    <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200">
      {services.map((s) => (
        <li key={s.id} className="p-4">
          <H className="font-medium">
            <Link className={`underline-offset-2 hover:underline ${focusRing}`} href={`/services/${s.slug}`}>{s.name}</Link>
          </H>
          <p className="text-sm text-zinc-700">{s.description}</p>
          <p className="mt-1 text-sm">{formatDuration(s.durationMinutes)} · {formatPrice(s.priceMinor, s.currency)}</p>
        </li>
      ))}
    </ul>
  );
}
