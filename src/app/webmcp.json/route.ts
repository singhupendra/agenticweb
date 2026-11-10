import { defaultResolver } from "@/api/rest";
import { buildWebMcpManifest } from "@/agents/discovery/webmcp";
import { registry } from "@/capabilities";
import { getEnv } from "@/core/env";

export const dynamic = "force-dynamic";

/** WebMCP tool manifest for the *requesting* visitor (auth-aware, never cached). Fetched client-side so layouts stay static-capable. */
export async function GET(request: Request) {
  const actor = await defaultResolver().resolve(request);
  const manifest = buildWebMcpManifest(registry, actor, { orgSlug: getEnv().DEFAULT_ORG_SLUG });
  return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json", "cache-control": "private, no-store", vary: "cookie, authorization" } });
}
