/** Pure Schema.org JSON-LD generators. Emit only for content that is visible on the same page. */
import type { Faq } from "./content";

export type JsonLd = Record<string, unknown> & { "@context": "https://schema.org"; "@type": string };
const CTX = "https://schema.org" as const;

export interface ServiceLike {
  slug: string; name: string; description: string; durationMinutes: number; priceMinor: number; currency: string;
}
export interface Address { streetAddress?: string; addressLocality?: string; addressRegion?: string; postalCode?: string; addressCountry: string }

const clean = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;

export const absoluteUrl = (baseUrl: string, path: string) => `${baseUrl.replace(/\/$/, "")}${path === "/" ? "" : path}`;

/** minor units → decimal string (assumes 2 minor digits, as the rest of the app does). */
export const priceFromMinor = (minor: number) => (minor / 100).toFixed(2);

export function organizationJsonLd(o: { name: string; baseUrl: string; description?: string }): JsonLd {
  return { "@context": CTX, "@type": "Organization", ...clean({ name: o.name, url: o.baseUrl, description: o.description }) };
}
export function webSiteJsonLd(o: { name: string; baseUrl: string; description?: string }): JsonLd {
  return { "@context": CTX, "@type": "WebSite", ...clean({ name: o.name, url: o.baseUrl, description: o.description }) };
}
export function webPageJsonLd(o: { name: string; description: string; url: string; baseUrl: string }): JsonLd {
  return {
    "@context": CTX, "@type": "WebPage", name: o.name, description: o.description, url: o.url,
    isPartOf: { "@type": "WebSite", url: o.baseUrl },
  };
}
export function serviceJsonLd(o: { service: ServiceLike; orgName: string; baseUrl: string }): JsonLd {
  const url = absoluteUrl(o.baseUrl, `/services/${o.service.slug}`);
  return {
    "@context": CTX, "@type": "Service", name: o.service.name, description: o.service.description, url,
    provider: { "@type": "Organization", name: o.orgName, url: o.baseUrl },
    offers: { "@type": "Offer", price: priceFromMinor(o.service.priceMinor), priceCurrency: o.service.currency, url },
  };
}
/** Only render when a real address is configured and visible; the demo organization has none. */
export function localBusinessJsonLd(o: { name: string; baseUrl: string; address: Address; telephone?: string }): JsonLd {
  return {
    "@context": CTX, "@type": "LocalBusiness", ...clean({ name: o.name, url: o.baseUrl, telephone: o.telephone }),
    address: { "@type": "PostalAddress", ...clean({ ...o.address }) },
  };
}
export function faqPageJsonLd(items: readonly Faq[]): JsonLd {
  return {
    "@context": CTX, "@type": "FAQPage",
    mainEntity: items.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })),
  };
}
export function breadcrumbJsonLd(items: { name: string; url: string }[]): JsonLd {
  return {
    "@context": CTX, "@type": "BreadcrumbList",
    itemListElement: items.map((i, idx) => ({ "@type": "ListItem", position: idx + 1, name: i.name, item: i.url })),
  };
}

/** Safe to embed inside <script type="application/ld+json">: `<` and line separators are escaped. */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
export function serializeJsonLd(node: JsonLd): string {
  return JSON.stringify(node).replaceAll("<", "\\u003c").replaceAll(LS, "\\u2028").replaceAll(PS, "\\u2029");
}
