import { buildWebMcpManifest } from "@/agents/discovery/webmcp";
import { registry } from "@/capabilities";
import { currentActor, orgSlug } from "@/app/(website)/_lib/data";
import { WebMcpClient } from "./webmcp-client";

/** Server component: derives the tool manifest from the capability registry for the current visitor. */
export async function WebMcpRegistrar() {
  const manifest = buildWebMcpManifest(registry, await currentActor(), { orgSlug: orgSlug() });
  return <WebMcpClient manifest={manifest} />;
}
