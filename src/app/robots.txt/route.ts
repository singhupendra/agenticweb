import { renderRobotsTxt } from "@/agents/discovery/robots";
import { discoveryHeaders } from "@/agents/discovery/catalog";
import { getEnv } from "@/core/env";

export const dynamic = "force-dynamic";

export function GET() {
  return new Response(renderRobotsTxt({ baseUrl: getEnv().APP_URL }), { headers: discoveryHeaders("text/plain; charset=utf-8", false) });
}
