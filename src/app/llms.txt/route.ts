import { discoveryHeaders, loadCatalog } from "@/agents/discovery/catalog";
import { renderLlmsTxt } from "@/agents/discovery/llms";
import { getEnv } from "@/core/env";

export const dynamic = "force-dynamic";

export async function GET() {
  const { orgName, orgSlug, services, degraded } = await loadCatalog();
  const body = renderLlmsTxt({ baseUrl: getEnv().APP_URL, orgName, orgSlug, services });
  return new Response(body, { headers: discoveryHeaders("text/plain; charset=utf-8", degraded) });
}
