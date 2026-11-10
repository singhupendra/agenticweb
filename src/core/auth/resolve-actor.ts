/**
 * THE single identity entry point for every channel (REST, MCP, UI server code).
 *   const actor = await resolveActor(request);                       // REST / UI
 *   const actor = await resolveActor(request, { resource: "mcp" });  // MCP: tokens must be minted for the MCP server
 * Precedence: Authorization header (bearer; a bad token is a 401, never anonymous) → session cookie (+CSRF on unsafe
 * methods) → dev header (dev only) → anonymous. Nothing else in the codebase reads credentials.
 */
import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet } from "jose";
import { getEnv, type Env } from "../env";
import { AppError } from "../errors";
import { ANONYMOUS, type Actor, type ActorResolver } from "./actor";
import { bearerChallenge } from "./challenge";
import { DevHeaderActorResolver } from "./dev-resolver";
import type { GrantStore } from "./grants";
import { getMockIssuer } from "./mock-issuer";
import { createAccessTokenVerifier, type AccessTokenVerifier } from "./access-token";
import { SessionManager } from "./session";

export type ResourceKind = "rest" | "mcp";
export interface ResolveOptions {
  resource?: ResourceKind;
}

/** Canonical resource identifiers (RFC 8707 / RFC 9728): the REST API is the origin, MCP lives at /mcp. */
export function resourceUri(appUrl: string, kind: ResourceKind): string {
  const base = new URL(appUrl).origin;
  return kind === "mcp" ? `${base}/mcp` : base;
}

export interface ActorResolverDeps {
  appUrl: string;
  /** undefined → bearer tokens cannot be verified: they are rejected (401), not ignored. */
  verifier?: AccessTokenVerifier;
  sessions?: SessionManager;
  dev?: ActorResolver;
}

export class CompositeActorResolver implements ActorResolver {
  constructor(private readonly d: ActorResolverDeps) {}

  async resolve(request: Request, opts: ResolveOptions = {}): Promise<Actor> {
    const header = request.headers.get("authorization");
    if (header !== null) {
      const m = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(header.trim());
      if (!m || !this.d.verifier) {
        throw new AppError("unauthenticated", "Valid credentials are required.", {
          headers: { "www-authenticate": bearerChallenge({ error: "invalid_token", description: "Unsupported or invalid credentials" }) },
        });
      }
      return this.d.verifier.verify(m[1] as string, [resourceUri(this.d.appUrl, opts.resource ?? "rest")]);
    }
    if (this.d.sessions) {
      const s = await this.d.sessions.read(request);
      if (s) {
        this.d.sessions.assertCsrf(request, s.sessionId);
        return s.actor;
      }
    }
    if (this.d.dev) return this.d.dev.resolve(request);
    return ANONYMOUS;
  }
}

export interface AuthRuntime {
  resolver: CompositeActorResolver;
  sessions?: SessionManager;
  /** Authorization servers advertised in protected-resource metadata. */
  authorizationServers: string[];
}

export async function buildAuthRuntime(env: Env, extra: { grants?: GrantStore } = {}): Promise<AuthRuntime> {
  let verifier: AccessTokenVerifier | undefined;
  const authorizationServers: string[] = [];
  let issuer: string | undefined;
  let keys: JWTVerifyGetKey | undefined;
  if (env.MOCK_ISSUER_ENABLED) {
    issuer = `${new URL(env.APP_URL).origin}/api/dev/mock-issuer`;
    keys = (await getMockIssuer(issuer)).keys;
  } else if (env.AUTH_ISSUER) {
    issuer = env.AUTH_ISSUER;
    keys = createRemoteJWKSet(new URL(env.AUTH_JWKS_URI ?? `${env.AUTH_ISSUER.replace(/\/$/, "")}/.well-known/jwks.json`));
  }
  if (issuer && keys) {
    authorizationServers.push(issuer);
    verifier = createAccessTokenVerifier({ issuer, keys, grants: extra.grants });
  }
  const sessions = env.SESSION_SECRET ? new SessionManager({ secret: env.SESSION_SECRET, appUrl: env.APP_URL }) : undefined;
  const dev = env.DEV_AUTH_ENABLED ? new DevHeaderActorResolver({ enabled: true, nodeEnv: env.NODE_ENV }) : undefined;
  return { resolver: new CompositeActorResolver({ appUrl: env.APP_URL, verifier, sessions, dev }), sessions, authorizationServers };
}

const g = globalThis as unknown as { __authRuntime?: Promise<AuthRuntime>; __grantStore?: GrantStore };
/** Wire a persistent GrantStore (revocation) before the first request. */
export function setGrantStore(store: GrantStore): void {
  g.__grantStore = store;
}
export function getAuthRuntime(): Promise<AuthRuntime> {
  return (g.__authRuntime ??= buildAuthRuntime(getEnv(), { grants: g.__grantStore }));
}

export async function resolveActor(request: Request, opts: ResolveOptions = {}): Promise<Actor> {
  return (await getAuthRuntime()).resolver.resolve(request, opts);
}
