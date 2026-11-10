/** Dev-only HTTP surface of the mock issuer: JWKS and a token-minting endpoint. 404 unless MOCK_ISSUER_ENABLED. */
import { z } from "zod";
import { getEnv } from "../env";
import { notFound, problemResponse, validationError } from "../errors";
import { ScopeSchema } from "./actor";
import { getMockIssuer } from "./mock-issuer";
import { getGrantStore, resourceUri } from "./resolve-actor";

const MintBody = z.strictObject({
  kind: z.enum(["user", "admin", "agent"]),
  userId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  clientId: z.string().min(1).default("dev-agent"),
  grantId: z.string().min(1).default("dev-grant"),
  scopes: z.array(ScopeSchema).default([]),
  resource: z.enum(["rest", "mcp"]).default("rest"),
  expiresInSec: z.number().int().min(1).max(3600).default(600),
});

async function enabledIssuer() {
  const env = getEnv();
  if (!env.MOCK_ISSUER_ENABLED || env.NODE_ENV === "production") throw notFound();
  return { env, issuer: await getMockIssuer(`${new URL(env.APP_URL).origin}/api/dev/mock-issuer`) };
}

export async function mockJwksResponse(): Promise<Response> {
  try {
    const { issuer } = await enabledIssuer();
    return Response.json(issuer.jwks, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return problemResponse(e);
  }
}

export async function mockTokenResponse(request: Request): Promise<Response> {
  try {
    const { env, issuer } = await enabledIssuer();
    const parsed = MintBody.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw validationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    const b = parsed.data;
    const o = { audience: resourceUri(env.APP_URL, b.resource), expiresInSec: b.expiresInSec };
    if (b.kind !== "agent" && (!b.userId || !b.organizationId)) throw validationError([{ path: "userId", message: "userId and organizationId are required" }]);
    if (b.kind === "agent") {
      // The mock issuer plays the consent screen: the user "consented" to this client+scopes, recorded durably (and revocable).
      const grants = await getGrantStore();
      await grants?.put?.({ grantId: b.grantId, userId: b.userId ?? b.clientId, clientId: b.clientId, scopes: b.scopes }).catch((e: unknown) => {
        if ((e as { code?: string }).code !== "conflict") throw e; // existing grant of the same owner is fine; a revoked one stays revoked
      });
    }
    const token =
      b.kind === "agent"
        ? await issuer.agent({ clientId: b.clientId, grantId: b.grantId, scopes: b.scopes, userId: b.userId, organizationId: b.organizationId }, o)
        : await issuer.user({ userId: b.userId as string, organizationId: b.organizationId as string, admin: b.kind === "admin" }, o);
    return Response.json({ access_token: token, token_type: "Bearer", expires_in: b.expiresInSec }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return problemResponse(e);
  }
}
