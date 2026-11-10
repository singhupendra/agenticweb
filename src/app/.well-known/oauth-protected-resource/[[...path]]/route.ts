import { getEnv } from "@/core/env";
import { getAuthRuntime, protectedResourceMetadataResponse } from "@/core/auth";

export async function GET(_req: Request, ctx: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const { path = [] } = await ctx.params;
  const { authorizationServers } = await getAuthRuntime();
  return protectedResourceMetadataResponse(path, { appUrl: getEnv().APP_URL, authorizationServers });
}
