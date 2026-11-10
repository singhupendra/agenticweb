/**
 * OIDC relying party for HUMAN sign-in: authorization-code flow + PKCE (S256), `state` + `nonce`, ID-token validation.
 * No client secret is required (public client + PKCE); a secret is sent (client_secret_post) only when configured.
 * Everything network-facing goes through an injectable `fetch` (tests use the in-process mock issuer; no network).
 * Failure policy: any problem is a generic 400 `login_failed`; the cause is only in `cause` (logged, never returned).
 */
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors";
import type { SessionIdentity } from "./session";

const ALGORITHMS = ["ES256", "ES384", "RS256", "PS256", "EdDSA"];
const DISCOVERY_TTL_MS = 3600_000;
const HTTP_TIMEOUT_MS = 5000;

export const loginFailed = (cause?: unknown) => new AppError("login_failed", "Sign-in could not be completed. Please start again.", { cause });

const Discovery = z.object({ issuer: z.string(), authorization_endpoint: z.string().url(), token_endpoint: z.string().url(), jwks_uri: z.string().url() });
type Discovery = z.infer<typeof Discovery>;

export interface Pkce {
  verifier: string;
  challenge: string;
}
/** RFC 7636: 256-bit random verifier, S256 challenge. */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Only same-site relative paths survive; everything else (absolute, protocol-relative, backslashes, control chars) → "/". */
export function safeReturnTo(v: string | null | undefined): string {
  if (!v || !v.startsWith("/") || v.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(v)) return "/";
  return v;
}

export interface OidcClientOptions {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
}

const isLocalHost = (u: URL) => u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";

export class OidcClient {
  private disc?: { at: number; value: Discovery };
  private jwks?: { at: number; keys: JWTVerifyGetKey };
  constructor(private readonly o: OidcClientOptions) {}

  private get fetcher() {
    return this.o.fetch ?? ((input: string, init?: RequestInit) => fetch(input, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }));
  }
  private now(): number {
    return (this.o.now?.() ?? new Date()).getTime();
  }

  /** Every network/parse failure at the issuer becomes the generic `login_failed` (400); the cause is kept for logs only. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw e instanceof AppError ? e : loginFailed(e);
    }
  }

  discover(): Promise<Discovery> {
    return this.guard(() => this.discoverUnguarded());
  }

  private async discoverUnguarded(): Promise<Discovery> {
    if (this.disc && this.now() - this.disc.at < DISCOVERY_TTL_MS) return this.disc.value;
    const res = await this.fetcher(`${this.o.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!res.ok) throw loginFailed(`discovery ${res.status}`);
    const d = Discovery.parse(await res.json());
    if (d.issuer !== this.o.issuer) throw loginFailed("discovery issuer mismatch"); // mix-up defence (RFC 9207 spirit)
    for (const e of [d.authorization_endpoint, d.token_endpoint, d.jwks_uri]) {
      const u = new URL(e);
      if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost(u))) throw loginFailed("issuer endpoints must use https");
    }
    this.disc = { at: this.now(), value: d };
    return d;
  }

  async authorizationUrl(p: { state: string; nonce: string; challenge: string }): Promise<URL> {
    const d = await this.discover();
    const u = new URL(d.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: "code", client_id: this.o.clientId, redirect_uri: this.o.redirectUri, scope: this.o.scopes ?? "openid profile email",
      state: p.state, nonce: p.nonce, code_challenge: p.challenge, code_challenge_method: "S256",
    })) u.searchParams.set(k, v);
    return u;
  }

  /** Redeems the code; returns the raw ID token. The issuer enforces PKCE + single use + redirect_uri equality. */
  exchange(code: string, verifier: string): Promise<string> {
    return this.guard(() => this.exchangeUnguarded(code, verifier));
  }

  private async exchangeUnguarded(code: string, verifier: string): Promise<string> {
    const d = await this.discover();
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.o.redirectUri, client_id: this.o.clientId, code_verifier: verifier });
    if (this.o.clientSecret) body.set("client_secret", this.o.clientSecret);
    const res = await this.fetcher(d.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
    if (!res.ok) throw loginFailed(`token endpoint ${res.status}`);
    const json = (await res.json()) as { id_token?: unknown };
    if (typeof json.id_token !== "string") throw loginFailed("no id_token");
    return json.id_token;
  }

  private keys(refresh = false): Promise<JWTVerifyGetKey> {
    return this.guard(() => this.keysUnguarded(refresh));
  }

  private async keysUnguarded(refresh: boolean): Promise<JWTVerifyGetKey> {
    if (!refresh && this.jwks && this.now() - this.jwks.at < 600_000) return this.jwks.keys;
    const d = await this.discover();
    const res = await this.fetcher(d.jwks_uri);
    if (!res.ok) throw loginFailed(`jwks ${res.status}`);
    const keys = createLocalJWKSet((await res.json()) as JSONWebKeySet);
    this.jwks = { at: this.now(), keys };
    return keys;
  }

  /** Signature (asymmetric only), iss, aud = our client id, exp, nonce equality, and the tenant/user claims we need. */
  async verifyIdToken(idToken: string, expectedNonce: string): Promise<SessionIdentity> {
    const verify = async (keys: JWTVerifyGetKey) =>
      jwtVerify(idToken, keys, { issuer: this.o.issuer, audience: this.o.clientId, algorithms: ALGORITHMS, clockTolerance: 5, currentDate: new Date(this.now()), requiredClaims: ["exp", "iat", "sub"] });
    let payload;
    try {
      try {
        ({ payload } = await verify(await this.keys()));
      } catch (e) {
        if (!(e instanceof joseErrors.JWKSNoMatchingKey)) throw e;
        ({ payload } = await verify(await this.keys(true))); // key rotation: refetch once
      }
    } catch (e) {
      throw loginFailed(e);
    }
    if (typeof payload.nonce !== "string" || payload.nonce !== expectedNonce) throw loginFailed("nonce mismatch");
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.org_id !== "string" || !payload.org_id) throw loginFailed("missing sub/org_id");
    const roles = Array.isArray(payload.roles) ? payload.roles : [];
    return { userId: payload.sub, organizationId: payload.org_id, role: roles.includes("admin") ? "admin" : "user" };
  }
}
