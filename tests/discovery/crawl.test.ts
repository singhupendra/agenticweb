import { describe, expect, it } from "vitest";
import { renderRobotsTxt, SEARCH_CRAWLERS, AI_USER_AGENTS, AI_TRAINING_CRAWLERS } from "@/agents/discovery/robots";
import { buildSitemapEntries, renderSitemapXml } from "@/agents/discovery/sitemap";
import { renderLlmsTxt } from "@/agents/discovery/llms";
import { SITE } from "@/agents/discovery/content";

const base = "https://example.test";
const services = [{ slug: "strategy-session", name: "Strategy session", description: "Focused.", durationMinutes: 60, priceMinor: 450000, currency: "INR" }];

describe("robots.txt", () => {
  const txt = renderRobotsTxt({ baseUrl: base });
  it("states it is advisory, lists sitemap, blocks private paths for everyone", () => {
    expect(txt).toMatch(/not (a )?security/i);
    expect(txt).toContain(`Sitemap: ${base}/sitemap.xml`);
    expect(txt).toMatch(/User-agent: \*\nAllow: \/\nDisallow: \/api\/\nDisallow: \/bookings\//);
  });
  it("distinguishes search, AI user agents and AI training crawlers", () => {
    for (const ua of SEARCH_CRAWLERS) expect(txt).toContain(`User-agent: ${ua}`);
    for (const ua of AI_USER_AGENTS) expect(txt).toContain(`User-agent: ${ua}`);
    const training = txt.split("\n\n").find((b) => b.includes(`User-agent: ${AI_TRAINING_CRAWLERS[0]}`))!;
    for (const ua of AI_TRAINING_CRAWLERS) expect(training).toContain(`User-agent: ${ua}`);
    expect(training).toContain("Disallow: /");
    expect(training).not.toContain("Allow: /\n");
  });
  it("every group keeps API and bookings private", () => {
    for (const block of txt.split("\n\n").filter((b) => b.includes("User-agent:") && !b.includes("Disallow: /\n") && !b.endsWith("Disallow: /"))) {
      expect(block).toContain("Disallow: /api/");
      expect(block).toContain("Disallow: /bookings/");
    }
  });
});

describe("sitemap", () => {
  it("includes static pages and each service with absolute urls; excludes private paths", () => {
    const urls = buildSitemapEntries({ baseUrl: base, services }).map((e) => e.url);
    expect(urls).toContain(`${base}/`);
    expect(urls).toContain(`${base}/services`);
    expect(urls).toContain(`${base}/services/strategy-session`);
    expect(urls.some((u) => u.includes("/api/") || u.includes("/bookings"))).toBe(false);
  });
  it("falls back to static pages with no services and renders valid xml", () => {
    const xml = renderSitemapXml(buildSitemapEntries({ baseUrl: base, services: [] }));
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
    expect(xml).toContain(`<loc>${base}/services</loc>`);
  });
  it("escapes xml special characters", () => {
    const xml = renderSitemapXml([{ url: `${base}/a?x=1&y=2` }]);
    expect(xml).toContain("x=1&amp;y=2");
  });
});

describe("llms.txt", () => {
  const txt = renderLlmsTxt({ baseUrl: base, orgName: "Northwind", services });
  it("follows the llms.txt structure: H1, blockquote summary, H2 sections with links", () => {
    expect(txt.startsWith("# Northwind\n\n> ")).toBe(true);
    expect(txt).toContain("## Services");
    expect(txt).toContain(`- [Strategy session](${base}/services/strategy-session): Focused.`);
    expect(txt).toContain("## For agents");
  });
  it("is generated from maintainable content (faqs + static pages), not hand-copied", () => {
    for (const f of SITE.faqs) expect(txt).toContain(f.question);
    for (const p of SITE.pages) expect(txt).toContain(`${base}${p.path === "/" ? "" : p.path}`);
  });
  it("documents auth truthfully and only links endpoints that exist", () => {
    expect(txt).toContain(`${base}/api/organizations/northwind-studio/services`);
    expect(txt).toMatch(/booking.*(sign-in|authenticat)/i);
    expect(txt).not.toMatch(/openapi\.json|\/mcp\b/);
  });
});
