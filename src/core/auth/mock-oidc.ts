/**
 * In-process OIDC provider for tests and local demos (NEVER production: env validation refuses MOCK_ISSUER_ENABLED there).
 * Implements just enough of the protocol to exercise a real relying party: discovery, JWKS, /authorize (PKCE S256 required,
 * exact redirect_uri match, single-use short-lived codes), /oauth/token (PKCE verified), ID tokens signed ES256.
 * "Login" is a stub: `login_hint=customer|admin|<userId>:<orgId>`, or a page with links when absent.
 */
import { randomUUID } from "node:crypto";
import { MockIssuer } from "./mock-issuer";
import { pkceChallenge, randomToken } from "./oidc";

/** Seeded demo identities (`prisma/seed.ts`). */
export const DEV_IDENTITIES = {
  customer: { sub: "00000000-0000-4000-8000-0000000000b2", org: "00000000-0000-4000-8000-0000000000a1", roles: [] as string[], name: "Demo Customer" },
  admin: { sub: "00000000-0000-4000-8000-0000000000b1", org: "00000000-0000-4000-8000-0000000000a1", roles: ["admin"], name: "Demo Admin" },
} as const;

interface CodeRecord { clientId: string; redirectUri: string; challenge: string; nonce: string; sub: string; org: string; roles: string[]; name: string; expiresAt: number }

export interface MockOidcOptions {
  issuer: string;
  clientId?: string;
  redirectUris?: string[];
  now?: () => Date;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const oauthError = (error: string, status = 400) => json({ error }, status);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class MockOidcProvider {
  private readonly codes = new Map<string, CodeRecord>();
  private constructor(readonly issuer: MockIssuer, private readonly o: Required<Pick<MockOidcOptions, "issuer" | "clientId" | "redirectUris">> & { now: () => Date }) {}

  static async create(o: MockOidcOptions): Promise<MockOidcProvider> {
    return MockOidcProvider.from(await MockIssuer.create(o.issuer), o);
  }
  static from(issuer: MockIssuer, o: MockOidcOptions): MockOidcProvider {
    const clientId = o.clientId ?? "agenticweb-web";
    return new MockOidcProvider(issuer, { issuer: o.issuer, clientId, redirectUris: o.redirectUris ?? [`${new URL(o.issuer).origin}/api/auth/callback`], now: o.now ?? (() => new Date()) });
  }

  /** `fetch`-compatible entry point (what the relying party is given in tests and what the Next routes delegate to). */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    this.handle(input instanceof Request ? input : new Request(input, { ...init, redirect: "manual" } as RequestInit));

  /** Test/demo helper: mint a code as if the user had just logged in. */
  issueCode(p: { clientId: string; redirectUri: string; challenge: string; nonce: string; login: string }): string {
    const id = this.identity(p.login);
    if (!id) throw new Error("unknown login");
    const code = randomToken(24);
    this.codes.set(code, { clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, nonce: p.nonce, ...id, expiresAt: this.o.now().getTime() + 60_000 });
    return code;
  }

  private identity(login: string | null): { sub: string; org: string; roles: string[]; name: string } | null {
    if (login === "customer" || login === "admin") return { ...DEV_IDENTITIES[login], roles: [...DEV_IDENTITIES[login].roles] };
    const m = /^([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(login ?? "");
    return m ? { sub: m[1] as string, org: m[2] as string, roles: [], name: "Test User" } : null;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const base = new URL(this.o.issuer).pathname.replace(/\/$/, "");
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
    switch (path) {
      case "/.well-known/openid-configuration":
        return json({
          issuer: this.o.issuer, authorization_endpoint: `${this.o.issuer}/authorize`, token_endpoint: `${this.o.issuer}/oauth/token`, jwks_uri: `${this.o.issuer}/jwks`,
          response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["ES256"], subject_types_supported: ["public"],
        });
      case "/jwks":
        return json(this.issuer.jwks);
      case "/authorize":
        return this.authorize(url);
      case "/oauth/token":
        return request.method === "POST" ? this.token(request) : oauthError("invalid_request", 405);
      default:
        return oauthError("not_found", 404);
    }
  }

  private authorize(url: URL): Response {
    const q = url.searchParams;
    const redirectUri = q.get("redirect_uri") ?? "";
    // Errors about client/redirect_uri are NEVER redirected (RFC 6749 §4.1.2.1): that would be an open redirect.
    if (q.get("client_id") !== this.o.clientId || !this.o.redirectUris.includes(redirectUri)) return oauthError("invalid_request");
    if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? "") || !q.get("state") || !q.get("nonce")) {
      return oauthError("invalid_request");
    }
    const login = q.get("login_hint");
    if (!login || !this.identity(login)) {
      const link = (who: string, label: string) => { const u = new URL(url); u.searchParams.set("login_hint", who); return `<li><a href="${esc(u.toString())}">${label}</a></li>`; };
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Mock sign-in</title><main><h1>Mock identity provider</h1><p>Local development only. Choose who to sign in as:</p><ul>${link("customer", "Demo customer")}${link("admin", "Demo admin")}</ul></main></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
      );
    }
    const code = this.issueCode({ clientId: this.o.clientId, redirectUri, challenge: q.get("code_challenge") as string, nonce: q.get("nonce") as string, login });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state") as string);
    return new Response(null, { status: 302, headers: { location: back.toString(), "cache-control": "no-store" } });
  }

  private async token(request: Request): Promise<Response> {
    const f = new URLSearchParams(await request.text());
    const rec = this.codes.get(f.get("code") ?? "");
    if (rec) this.codes.delete(f.get("code") as string); // single use, even when the rest of the request is wrong
    const verifier = f.get("code_verifier") ?? "";
    if (f.get("grant_type") !== "authorization_code") return oauthError("unsupported_grant_type");
    if (!rec || rec.expiresAt <= this.o.now().getTime() || rec.clientId !== f.get("client_id") || rec.redirectUri !== f.get("redirect_uri")) return oauthError("invalid_grant");
    if (verifier.length < 43 || verifier.length > 128 || pkceChallenge(verifier) !== rec.challenge) return oauthError("invalid_grant");
    const idToken = await this.issuer.sign(
      { sub: rec.sub, org_id: rec.org, roles: rec.roles, name: rec.name, nonce: rec.nonce },
      { audience: rec.clientId, typ: "JWT", issuedAt: this.o.now(), expiresInSec: 300, jti: randomUUID() },
    );
    return json({ token_type: "Bearer", access_token: randomToken(24), expires_in: 300, id_token: idToken });
  }
}

const g = globalThis as unknown as { __mockOidc?: Promise<MockOidcProvider> };
/** Process-wide singleton that SHARES the key of the bearer-token mock issuer (one mock IdP, two protocols). */
export function getMockOidc(issuerUrl: string, clientId?: string): Promise<MockOidcProvider> {
  return (g.__mockOidc ??= import("./mock-issuer").then(async (m) => MockOidcProvider.from(await m.getMockIssuer(issuerUrl), { issuer: issuerUrl, clientId })));
}
