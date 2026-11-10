/**
 * HTTP handlers for human sign-in (thin; protocol logic lives in `oidc.ts`, identity/CSRF in `session.ts`):
 *   GET  /api/auth/login?returnTo=/x   → 302 to the issuer (PKCE+state+nonce), sets the encrypted transaction cookie
 *   GET  /api/auth/callback            → verifies state/code/ID token, rotates in a fresh session cookie, 302 to returnTo
 *   GET  /api/auth/session             → identity + the CSRF token for cookie-authenticated unsafe requests
 *   POST /api/auth/logout              → CSRF-protected; clears the session cookie
 * The transaction (state, nonce, PKCE verifier, returnTo) lives in a short-lived AES-256-GCM cookie bound to the browser
 * that started the login, so there is no server-side state to leak or exhaust, and a callback injected into another
 * browser (login CSRF) has no matching transaction.
 */
import { EncryptJWT, jwtDecrypt } from "jose";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getEnv } from "../env";
import { AppError, notFound, problemResponse } from "../errors";
import { createLogger } from "../logging";
import { getMockOidc } from "./mock-oidc";
import { generatePkce, loginFailed, OidcClient, randomToken, safeReturnTo } from "./oidc";
import { getAuthRuntime } from "./resolve-actor";
import { parseCookies, type SessionManager } from "./session";

const TX_TTL_SEC = 600;
const Tx = z.object({ state: z.string(), nonce: z.string(), verifier: z.string(), returnTo: z.string() });

export interface OidcHandlerDeps {
  appUrl: string;
  sessions?: SessionManager;
  /** undefined → sign-in is not configured → 404. */
  oidc?: OidcClient;
  /** Encrypts the transaction cookie (the session secret). */
  secret: string;
  now?: () => Date;
}

export function createOidcHandlers(d: OidcHandlerDeps) {
  const secure = new URL(d.appUrl).protocol === "https:";
  const txName = secure ? "__Host-login_tx" : "login_tx";
  const now = () => d.now?.() ?? new Date();
  const key = createHash("sha256").update(`agenticweb:login-tx:${d.secret}`).digest();
  const cookie = (name: string, value: string, maxAge: number) => [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, ...(secure ? ["Secure"] : [])].join("; ");
  const noStore = { "cache-control": "no-store" };
  const requestId = () => randomToken(9);
  const fail = (e: unknown, clearTx = false) => {
    if (!(e instanceof AppError)) createLogger().error("auth handler error", { error: e });
    const res = problemResponse(e instanceof AppError ? e : new AppError("internal", undefined, { cause: e }), { requestId: requestId() });
    if (clearTx) res.headers.append("set-cookie", cookie(txName, "", 0));
    return res;
  };

  async function seal(tx: z.infer<typeof Tx>): Promise<string> {
    const iat = Math.floor(now().getTime() / 1000);
    return new EncryptJWT(tx).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setIssuedAt(iat).setExpirationTime(iat + TX_TTL_SEC).encrypt(key);
  }
  async function open(request: Request): Promise<z.infer<typeof Tx>> {
    const raw = parseCookies(request.headers.get("cookie"))[txName];
    if (!raw) throw loginFailed("no transaction cookie");
    try {
      const { payload } = await jwtDecrypt(raw, key, { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"], currentDate: now() });
      return Tx.parse(payload);
    } catch (e) {
      throw loginFailed(e);
    }
  }
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  return {
    async login(request: Request): Promise<Response> {
      try {
        if (!d.oidc) throw notFound();
        const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
        const pkce = generatePkce();
        const tx = { state: randomToken(), nonce: randomToken(), verifier: pkce.verifier, returnTo };
        const target = await d.oidc.authorizationUrl({ state: tx.state, nonce: tx.nonce, challenge: pkce.challenge });
        return new Response(null, { status: 302, headers: { location: target.toString(), "set-cookie": cookie(txName, await seal(tx), TX_TTL_SEC), ...noStore } });
      } catch (e) {
        return fail(e);
      }
    },

    async callback(request: Request): Promise<Response> {
      try {
        if (!d.oidc || !d.sessions) throw notFound();
        const q = new URL(request.url).searchParams;
        const tx = await open(request); // also proves this browser started the login
        if (q.get("error")) throw loginFailed(`issuer error: ${q.get("error")}`); // description is never echoed
        const state = q.get("state"), code = q.get("code");
        if (!state || !same(state, tx.state)) throw loginFailed("state mismatch");
        if (!code) throw loginFailed("missing code");
        const identity = await d.oidc.verifyIdToken(await d.oidc.exchange(code, tx.verifier), tx.nonce);
        const s = await d.sessions.create(identity); // always a NEW session id (no fixation)
        const res = new Response(null, { status: 302, headers: { location: new URL(safeReturnTo(tx.returnTo), d.appUrl).toString(), ...noStore } });
        res.headers.append("set-cookie", s.setCookie);
        res.headers.append("set-cookie", cookie(txName, "", 0)); // transaction is single-use
        return res;
      } catch (e) {
        return fail(e, true);
      }
    },

    async session(request: Request): Promise<Response> {
      try {
        const s = await d.sessions?.read(request);
        const data = s ? { authenticated: true, userId: s.actor.userId, organizationId: s.actor.organizationId, role: s.actor.kind === "admin" ? "admin" : "user", csrfToken: d.sessions!.csrfFor(s.sessionId) } : { authenticated: false };
        return Response.json({ data }, { headers: noStore });
      } catch (e) {
        return fail(e);
      }
    },

    async logout(request: Request): Promise<Response> {
      try {
        if (request.method !== "POST") throw new AppError("method_not_allowed", "Use POST.", { headers: { allow: "POST" } });
        const s = await d.sessions?.read(request);
        if (s) d.sessions!.assertCsrf(request, s.sessionId);
        return Response.json({ data: { authenticated: false } }, { headers: { ...noStore, "set-cookie": d.sessions?.clearCookie() ?? "" } });
      } catch (e) {
        return fail(e);
      }
    },
  };
}

let handlers: Promise<ReturnType<typeof createOidcHandlers>> | undefined;
/** Process-wide wiring from the environment (mock issuer locally, `AUTH_ISSUER` + `OIDC_CLIENT_ID` in real deployments). */
export function getOidcHandlers(): Promise<ReturnType<typeof createOidcHandlers>> {
  return (handlers ??= (async () => {
    const env = getEnv();
    const { sessions } = await getAuthRuntime();
    const secret = env.SESSION_SECRET ?? "";
    const redirectUri = `${new URL(env.APP_URL).origin}/api/auth/callback`;
    let oidc: OidcClient | undefined;
    if (sessions && env.MOCK_ISSUER_ENABLED && env.NODE_ENV !== "production") {
      const issuer = `${new URL(env.APP_URL).origin}/api/dev/mock-issuer`;
      const clientId = env.OIDC_CLIENT_ID ?? "agenticweb-web";
      const mock = await getMockOidc(issuer, clientId);
      oidc = new OidcClient({ issuer, clientId, redirectUri, fetch: mock.fetch, scopes: env.OIDC_SCOPES });
    } else if (sessions && env.AUTH_ISSUER && env.OIDC_CLIENT_ID) {
      oidc = new OidcClient({ issuer: env.AUTH_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET, redirectUri, scopes: env.OIDC_SCOPES });
    }
    return createOidcHandlers({ appUrl: env.APP_URL, sessions, oidc, secret });
  })());
}
