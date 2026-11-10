/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-LD nodes are dynamically shaped in assertions */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  breadcrumbJsonLd, faqPageJsonLd, localBusinessJsonLd, organizationJsonLd, serviceJsonLd, serializeJsonLd, webPageJsonLd, webSiteJsonLd,
} from "@/agents/discovery/jsonld";
import { SITE } from "@/agents/discovery/content";
import { Faq } from "@/app/components/faq";

const base = "https://example.test";
const service = { id: "55555555-5555-4555-8555-555555555551", slug: "strategy-session", name: "Strategy session", description: "A focused session.", durationMinutes: 60, priceMinor: 450000, currency: "INR" };

describe("JSON-LD generators", () => {
  it("Organization/WebSite/WebPage carry context, type and absolute urls", () => {
    const org = organizationJsonLd({ name: "Northwind", baseUrl: base });
    expect(org).toMatchObject({ "@context": "https://schema.org", "@type": "Organization", name: "Northwind", url: base });
    expect(webSiteJsonLd({ name: "Northwind", baseUrl: base })).toMatchObject({ "@type": "WebSite", url: base });
    expect(webPageJsonLd({ name: "Services", description: "d", url: `${base}/services`, baseUrl: base })).toMatchObject({
      "@type": "WebPage", url: `${base}/services`, isPartOf: { "@type": "WebSite", url: base },
    });
  });

  it("Service embeds an Offer with decimal price and ISO currency from minor units", () => {
    const ld = serviceJsonLd({ service, orgName: "Northwind", baseUrl: base }) as Record<string, any>;
    expect(ld["@type"]).toBe("Service");
    expect(ld.url).toBe(`${base}/services/strategy-session`);
    expect(ld.provider).toMatchObject({ "@type": "Organization", name: "Northwind" });
    expect(ld.offers).toMatchObject({ "@type": "Offer", price: "4500.00", priceCurrency: "INR", url: ld.url });
  });

  it("handles zero-decimal-aware rounding of minor units", () => {
    const ld = serviceJsonLd({ service: { ...service, priceMinor: 5 }, orgName: "N", baseUrl: base }) as Record<string, any>;
    expect(ld.offers.price).toBe("0.05");
  });

  it("LocalBusiness requires an address and emits PostalAddress", () => {
    const ld = localBusinessJsonLd({ name: "N", baseUrl: base, address: { streetAddress: "1 Main", addressLocality: "Pune", addressCountry: "IN" } }) as Record<string, any>;
    expect(ld["@type"]).toBe("LocalBusiness");
    expect(ld.address).toMatchObject({ "@type": "PostalAddress", addressLocality: "Pune" });
  });

  it("FAQPage mirrors the supplied Q&A exactly", () => {
    const ld = faqPageJsonLd([{ question: "Q1?", answer: "A1." }]) as Record<string, any>;
    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity[0]).toEqual({ "@type": "Question", name: "Q1?", acceptedAnswer: { "@type": "Answer", text: "A1." } });
  });

  it("FAQPage is only valid for content that is visible: every Q&A appears in the rendered FAQ", () => {
    const html = renderToStaticMarkup(createElement(Faq, { items: SITE.faqs }));
    const ld = faqPageJsonLd(SITE.faqs) as Record<string, any>;
    expect(ld.mainEntity.length).toBeGreaterThan(0);
    for (const q of ld.mainEntity) {
      expect(html).toContain(q.name.replace(/&/g, "&amp;"));
      expect(html).toContain(q.acceptedAnswer.text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;"));
    }
  });

  it("BreadcrumbList is positioned from 1", () => {
    const ld = breadcrumbJsonLd([{ name: "Home", url: base }, { name: "Services", url: `${base}/services` }]) as Record<string, any>;
    expect(ld.itemListElement.map((i: any) => i.position)).toEqual([1, 2]);
  });

  it("serialization escapes script-breaking characters", () => {
    const out = serializeJsonLd({ "@context": "https://schema.org", "@type": "Thing", name: "</script><script>alert(1)</script> " });
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<");
    expect(JSON.parse(out).name).toContain("</script>");
  });
});

describe("validation: required properties per type (Google/Schema.org essentials)", () => {
  const required: Record<string, string[]> = {
    Organization: ["name", "url"], WebSite: ["name", "url"], WebPage: ["name", "url"], Service: ["name", "provider", "offers"],
    Offer: ["price", "priceCurrency"], LocalBusiness: ["name", "address"], FAQPage: ["mainEntity"], BreadcrumbList: ["itemListElement"],
  };
  const all = () => [
    organizationJsonLd({ name: "N", baseUrl: base }),
    webSiteJsonLd({ name: "N", baseUrl: base }),
    webPageJsonLd({ name: "P", description: "d", url: base, baseUrl: base }),
    serviceJsonLd({ service, orgName: "N", baseUrl: base }),
    localBusinessJsonLd({ name: "N", baseUrl: base, address: { addressLocality: "Pune", addressCountry: "IN" } }),
    faqPageJsonLd(SITE.faqs),
    breadcrumbJsonLd([{ name: "Home", url: base }]),
  ] as Record<string, any>[];

  it("every generated node has the required properties, no undefined/empty values, and survives a JSON round-trip", () => {
    for (const node of all()) {
      expect(node["@context"]).toBe("https://schema.org");
      for (const key of required[node["@type"]] ?? []) expect(node[key], `${node["@type"]}.${key}`).toBeTruthy();
      if (node.offers) for (const key of required.Offer ?? []) expect(node.offers[key]).toBeTruthy();
      const walk = (v: unknown) => {
        if (v && typeof v === "object") Object.values(v).forEach(walk);
        else expect(v).not.toBeUndefined();
      };
      walk(node);
      expect(JSON.parse(serializeJsonLd(node as never))).toEqual(JSON.parse(JSON.stringify(node)));
    }
  });
});
