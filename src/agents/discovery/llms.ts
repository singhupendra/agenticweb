/** llms.txt (https://llmstxt.org): H1, blockquote summary, H2 link sections. Generated; never hand-edited. */
import { SITE, type StaticPage } from "./content";
import { absoluteUrl, priceFromMinor, type ServiceLike } from "./jsonld";

export function renderLlmsTxt(o: {
  baseUrl: string; orgName: string; orgSlug?: string; services: readonly Pick<ServiceLike, "slug" | "name" | "description" | "durationMinutes" | "priceMinor" | "currency">[];
}): string {
  const orgSlug = o.orgSlug ?? "northwind-studio";
  const page = (p: StaticPage) => `- [${p.title}](${absoluteUrl(o.baseUrl, p.path)}): ${p.description}`;
  const api = (path: string) => absoluteUrl(o.baseUrl, `/api/organizations/${orgSlug}${path}`);
  const lines = [
    `# ${o.orgName}`, "", `> ${SITE.summary}`, "",
    "## Pages", ...SITE.pages.map(page), "",
    "## Services",
    ...(o.services.length
      ? o.services.map((s) => `- [${s.name}](${absoluteUrl(o.baseUrl, `/services/${s.slug}`)}): ${s.description} (${s.durationMinutes} min, ${priceFromMinor(s.priceMinor)} ${s.currency})`)
      : ["- No services are currently listed."]),
    "",
    "## For agents",
    ...SITE.agentNotes.map((n) => `- ${n}`),
    `- [Organization](${api("")}): GET, public`,
    `- [List services](${api("/services")}): GET, public`,
    `- [Service slots](${api("/services/{serviceSlug}/slots")}): GET, public, future slots with remaining capacity`,
    `- [Bookings](${api("/bookings")}): POST create, GET list own (authentication required)`,
    "",
    "## FAQ",
    ...SITE.faqs.flatMap((f) => [`### ${f.question}`, f.answer, ""]),
    "## Crawling",
    `- [robots.txt](${absoluteUrl(o.baseUrl, "/robots.txt")}) · [sitemap.xml](${absoluteUrl(o.baseUrl, "/sitemap.xml")})`,
    "",
  ];
  return lines.join("\n");
}
