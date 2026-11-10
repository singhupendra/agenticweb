/**
 * Local OIDC-style token issuer for tests and local development (no paid IdP). It signs ES256 JWTs with an
 * in-memory key and exposes its JWKS. NEVER enabled in production (env validation refuses MOCK_ISSUER_ENABLED there).
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWTPayload, type JWTVerifyGetKey, type KeyObject } from "jose";
import { randomUUID } from "node:crypto";

export interface MintOptions {
  audience: string | string[];
  /** seconds; negative = already expired */
  expiresInSec?: number;
  issuedAt?: Date;
  jti?: string | null;
  issuer?: string;
  typ?: string;
}

export class MockIssuer {
  private constructor(
    readonly issuer: string,
    private readonly privateKey: CryptoKey | KeyObject,
    readonly jwks: JSONWebKeySet,
    private readonly kid: string,
  ) {}

  static async create(issuer: string): Promise<MockIssuer> {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const kid = randomUUID();
    const jwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
    return new MockIssuer(issuer, privateKey, { keys: [jwk] }, kid);
  }

  /** Key resolver for the verifier (same shape as `createRemoteJWKSet`). */
  get keys(): JWTVerifyGetKey {
    return createLocalJWKSet(this.jwks);
  }

  /** Sign arbitrary claims. Tests use this to craft hostile tokens; claims are NOT validated here. */
  async sign(claims: JWTPayload, o: MintOptions): Promise<string> {
    const iat = Math.floor((o.issuedAt ?? new Date()).getTime() / 1000);
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: this.kid, typ: o.typ ?? "at+jwt" })
      .setIssuer(o.issuer ?? this.issuer)
      .setAudience(o.audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + (o.expiresInSec ?? 600));
    if (o.jti !== null) jwt.setJti(o.jti ?? randomUUID());
    return jwt.sign(this.privateKey);
  }

  user(p: { userId: string; organizationId: string; admin?: boolean }, o: MintOptions): Promise<string> {
    return this.sign({ sub: p.userId, org_id: p.organizationId, roles: p.admin ? ["admin"] : [], token_use: "user" }, o);
  }

  agent(
    p: { clientId: string; grantId: string; scopes: string[]; userId?: string; organizationId?: string },
    o: MintOptions,
  ): Promise<string> {
    return this.sign(
      {
        sub: p.userId ?? p.clientId,
        ...(p.userId && p.organizationId ? { org_id: p.organizationId } : {}),
        token_use: "agent",
        client_id: p.clientId,
        grant_id: p.grantId,
        scope: p.scopes.join(" "),
      },
      o,
    );
  }
}

const g = globalThis as unknown as { __mockIssuer?: Promise<MockIssuer> };
/** Process-wide singleton (survives Next.js module re-evaluation in dev). */
export function getMockIssuer(issuer: string): Promise<MockIssuer> {
  return (g.__mockIssuer ??= MockIssuer.create(issuer));
}
