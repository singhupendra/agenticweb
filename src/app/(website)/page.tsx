import Link from "next/link";
import { SITE } from "@/agents/discovery/content";
import { faqPageJsonLd, organizationJsonLd, webPageJsonLd, webSiteJsonLd } from "@/agents/discovery/jsonld";
import { Faq } from "@/app/components/faq";
import { JsonLd } from "@/app/components/json-ld";
import { ServiceList } from "@/app/components/service-card";
import { getEnv } from "@/core/env";
import { getOrganization, listServices } from "./_lib/data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [org, services] = await Promise.all([getOrganization(), listServices()]);
  const baseUrl = getEnv().APP_URL;
  return (
    <>
      <JsonLd
        data={[
          organizationJsonLd({ name: org.name, baseUrl, description: SITE.summary }),
          webSiteJsonLd({ name: org.name, baseUrl }),
          webPageJsonLd({ name: org.name, description: SITE.summary, url: baseUrl, baseUrl }),
          faqPageJsonLd(SITE.faqs),
        ]}
      />
      <h1 className="text-3xl font-semibold">{org.name}</h1>
      <p className="mt-2 text-lg text-zinc-700">{SITE.tagline}</p>
      <p className="mt-4">
        <Link href="/services" className="inline-block rounded bg-blue-800 px-4 py-2 text-sm font-medium text-white hover:bg-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">
          Browse services
        </Link>
      </p>

      <section aria-labelledby="services-heading" className="mt-10">
        <h2 id="services-heading" className="mb-3 text-xl font-semibold">Services</h2>
        <ServiceList services={services} />
      </section>

      <section aria-labelledby="how-heading" className="mt-10">
        <h2 id="how-heading" className="text-xl font-semibold">How it works</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5">
          {SITE.howItWorks.map((s) => (
            <li key={s.title}><strong>{s.title}.</strong> {s.body}</li>
          ))}
        </ol>
      </section>

      <div className="mt-10"><Faq items={SITE.faqs} /></div>
    </>
  );
}
