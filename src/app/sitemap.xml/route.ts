import { discoveryHeaders, loadCatalog } from "@/agents/discovery/catalog";
import { buildSitemapEntries, renderSitemapXml } from "@/agents/discovery/sitemap";
import { getEnv } from "@/core/env";

export const dynamic = "force-dynamic";

export async function GET() {
  const { services, degraded } = await loadCatalog();
  const xml = renderSitemapXml(buildSitemapEntries({ baseUrl: getEnv().APP_URL, services }));
  return new Response(xml, { headers: discoveryHeaders("application/xml; charset=utf-8", degraded) });
}
