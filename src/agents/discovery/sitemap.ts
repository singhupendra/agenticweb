import { SITE } from "./content";
const abs = (baseUrl: string, path: string) => `${baseUrl.replace(/\/$/, "")}${path}`;

export interface SitemapEntry { url: string; changeFrequency?: "weekly" | "monthly" }

export function buildSitemapEntries(o: { baseUrl: string; services: readonly { slug: string }[] }): SitemapEntry[] {
  return [
    ...SITE.pages.map((p) => ({ url: abs(o.baseUrl, p.path), changeFrequency: p.changeFrequency })),
    ...o.services.map((s) => ({ url: abs(o.baseUrl, `/services/${s.slug}`), changeFrequency: "weekly" as const })),
  ];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function renderSitemapXml(entries: readonly SitemapEntry[]): string {
  const body = entries
    .map((e) => `  <url><loc>${esc(e.url)}</loc>${e.changeFrequency ? `<changefreq>${e.changeFrequency}</changefreq>` : ""}</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
