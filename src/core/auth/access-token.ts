/**
 * OAuth 2.1 / OIDC bearer-token verification → Actor.
 * Fail closed: any verification problem is a 401 `invalid_token`; nothing ever degrades to anonymous.
 * Defences: signature via JWKS (asymmetric algs only — no `none`, no HS*, so session cookies/secrets cannot be
 * replayed as bearer tokens), exact issuer, audience binding (RFC 8707), exp/nbf with small skew, required jti/iat,
 * explicit token_use, agent tokens bound to a user and a grant, scope narrowing, never admin.
 */
import { errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { AppError } from "../errors";
import { ScopeSchema, type Actor, type Scope } from "./actor";
import { bearerChallenge } from "./challenge";
import type { GrantStore } from "./grants";

const ALGORITHMS = ["ES256", "ES384", "RS256", "PS256", "EdDSA"];

const ClaimsSchema = z.object({
  sub: z.string().min(1),
  jti: z.string().min(8),
  iat: z.number(),
  exp: z.number(),
  token_use: z.enum(["user", "agent"]),
  org_id: z.string().min(1).optional(),
  roles: z.array(z.string()).optional(),
  client_id: z.string().min(1).optional(),
  grant_id: z.string().min(1).optional(),
  scope: z.string().optional(),
});

export interface AccessTokenVerifierOptions {
  issuer: string;
  keys: JWTVerifyGetKey;
  grants?: GrantStore;
  /** Reject agent tokens living longer than this (default 3600 s): limits stolen-token usefulness. */
  maxAgentTokenTtlSec?: number;
  clockToleranceSec?: number;
  now?: () => Date;
}

export class TokenError extends AppError {
  constructor(readonly reason: "expired" | "invalid", cause?: unknown) {
    super("unauthenticated", reason === "expired" ? "The access token has expired." : "The access token is invalid.", {
      cause,
      headers: {
        "www-authenticate": bearerChallenge({
          error: "invalid_token",
          description: reason === "expired" ? "The access token expired" : "The access token is invalid",
        }),
      },
    });
  }
}

export interface AccessTokenVerifier {
  /** `audiences`: any-of resource identifiers this endpoint answers to (RFC 8707). */
  verify(token: string, audiences: string[]): Promise<Actor>;
}

export function createAccessTokenVerifier(o: AccessTokenVerifierOptions): AccessTokenVerifier {
  const now = o.now ?? (() => new Date());
  return {
    async verify(token, audiences) {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, o.keys, {
          issuer: o.issuer,
          audience: audiences,
          algorithms: ALGORITHMS,
          clockTolerance: o.clockToleranceSec ?? 5,
          currentDate: now(),
          requiredClaims: ["exp", "iat", "jti", "sub"],
        }));
      } catch (e) {
        throw new TokenError(e instanceof joseErrors.JWTExpired ? "expired" : "invalid", e);
      }
      const parsed = ClaimsSchema.safeParse(payload);
      if (!parsed.success) throw new TokenError("invalid", parsed.error);
      const c = parsed.data;

      if (c.token_use === "user") {
        if (!c.org_id || c.client_id || c.grant_id) throw new TokenError("invalid"); // a delegated token can never act as the user
        return { kind: c.roles?.includes("admin") ? "admin" : "user", userId: c.sub, organizationId: c.org_id };
      }

      // Agent (delegated) token.
      if (!c.client_id || !c.grant_id) throw new TokenError("invalid");
      if (c.exp - c.iat > (o.maxAgentTokenTtlSec ?? 3600)) throw new TokenError("invalid");
      let scopes: Scope[] = (c.scope ?? "").split(/\s+/).flatMap((s) => {
        const r = ScopeSchema.safeParse(s);
        return r.success ? [r.data] : []; // unknown scopes (e.g. openid) grant nothing
      });
      const bound = Boolean(c.org_id); // no org → public-only agent (no user data)
      if (o.grants) {
        const grant = await o.grants.get(c.grant_id);
        if (!grant || grant.revokedAt) throw new TokenError("invalid");
        if (grant.clientId !== c.client_id) throw new TokenError("invalid");
        if (bound && grant.userId !== c.sub) throw new TokenError("invalid");
        scopes = scopes.filter((s) => grant.scopes.includes(s)); // narrowing only — never widens
      }
      return {
        kind: "agent",
        clientId: c.client_id,
        onBehalfOf: bound ? { userId: c.sub, organizationId: c.org_id as string } : null,
        delegation: {
          grantId: c.grant_id,
          scopes: [...new Set(scopes)],
          expiresAt: new Date(c.exp * 1000).toISOString(),
          audience: Array.isArray(payload.aud) ? payload.aud[0] : payload.aud,
        },
      };
    },
  };
}
