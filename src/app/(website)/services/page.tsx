import type { Metadata } from "next";
import { SITE } from "@/agents/discovery/content";
import { breadcrumbJsonLd, webPageJsonLd } from "@/agents/discovery/jsonld";
import { JsonLd } from "@/app/components/json-ld";
import { ServiceList } from "@/app/components/service-card";
import { getEnv } from "@/core/env";
import { listServices } from "../_lib/data";

export const dynamic = "force-dynamic";
const page = SITE.pages.find((p) => p.path === "/services")!;
export function generateMetadata(): Metadata {
  return { title: page.title, description: page.description, alternates: { canonical: `${getEnv().APP_URL.replace(/\/$/, "")}/services` } };
}

export default async function ServicesPage() {
  const services = await listServices();
  const baseUrl = getEnv().APP_URL;
  const url = `${baseUrl.replace(/\/$/, "")}/services`;
  return (
    <>
      <JsonLd data={[webPageJsonLd({ name: page.title, description: page.description, url, baseUrl }), breadcrumbJsonLd([{ name: "Home", url: baseUrl }, { name: "Services", url }])]} />
      <h1 className="text-3xl font-semibold">Services</h1>
      <p className="mb-6 mt-2 text-zinc-700">{page.description}</p>
      <ServiceList services={services} headingLevel="h2" />
    </>
  );
}
