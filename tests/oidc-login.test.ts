/**
 * OIDC authorization-code + PKCE login for humans, against the in-process mock issuer (no network).
 * Drives the real handlers: login → IdP authorize → callback → session cookie → resolveActor, plus every abuse case.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { CompositeActorResolver, MockIssuer, OidcClient, SessionManager, createOidcHandlers, MockOidcProvider, safeReturnTo } from "@/core/auth";
import { APP_URL, SESSION_SECRET, clock } from "./fixtures/auth";
import { NOW, ORG_ID, USER_ID } from "./fixtures";

const ISSUER = `${APP_URL}/api/dev/mock-issuer`;
const CLIENT_ID = "agenticweb-web";
let idp: MockOidcProvider;
let sessions: SessionManager;
let h: ReturnType<typeof createOidcHandlers>;
let oidc: OidcClient;

beforeEach(async () => {
  clock.now = NOW;
  idp = await MockOidcProvider.create({ issuer: ISSUER, now: () => clock.now });
  sessions = new SessionManager({ secret: SESSION_SECRET, appUrl: APP_URL, now: () => clock.now });
  oidc = new OidcClient({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: `${APP_URL}/api/auth/callback`, fetch: idp.fetch, now: () => clock.now });
  h = createOidcHandlers({ appUrl: APP_URL, sessions, oidc, secret: SESSION_SECRET, now: () => clock.now });
});

const req = (path: string, init: RequestInit = {}) => new Request(`${APP_URL}${path}`, init);
const cookieHeader = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const cookie = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const loc = (res: Response) => new URL(res.headers.get("location")!, APP_URL);

/** Full happy-path helper: returns the callback response plus intermediate artefacts. */
async function signIn(login = "/api/auth/login?returnTo=%2Fbookings", hint = "customer") {
  const l = await h.login(req(login));
  const auth = loc(l);
  auth.searchParams.set("login_hint", hint);
  const a = await idp.fetch(auth.toString(), { redirect: "manual" } as RequestInit);
  const back = loc(a);
  const cb = await h.callback(req(`${back.pathname}${back.search}`, { headers: { cookie: cookieHeader(l) } }));
  return { l, a, cb, auth, back };
}

describe("login redirect", () => {
  it("redirects to the issuer with PKCE S256, state, nonce, response_type=code and our exact redirect_uri", async () => {
    const l = await h.login(req("/api/auth/login"));
    expect(l.status).toBe(302);
    const u = loc(l);
    expect(`${u.origin}${u.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: `${APP_URL}/api/auth/callback`, code_challenge_method: "S256", scope: "openid profile email",
    });
    for (const k of ["state", "nonce", "code_challenge"]) expect(u.searchParams.get(k)!.length).toBeGreaterThanOrEqual(32);
    expect(u.searchParams.has("code_verifier")).toBe(false); // the verifier never leaves our side
    expect(u.searchParams.has("client_secret")).toBe(false);
  });
  it("binds the transaction to this browser with an encrypted HttpOnly SameSite=Lax cookie (verifier not readable)", async () => {
    const l = await h.login(req("/api/auth/login"));
    const c = cookie(l, "login_tx")!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Max-Age=600/);
    expect(l.headers.get("cache-control")).toBe("no-store");
    const u = loc(l);
    const raw = decodeURIComponent(c.split(";")[0]!.split("=").slice(1).join("="));
    for (const secret of [u.searchParams.get("state")!, u.searchParams.get("nonce")!]) expect(raw).not.toContain(secret);
  });
  it("each login gets fresh state/nonce/challenge", async () => {
    const a = loc(await h.login(req("/api/auth/login")));
    const b = loc(await h.login(req("/api/auth/login")));
    for (const k of ["state", "nonce", "code_challenge"]) expect(a.searchParams.get(k)).not.toBe(b.searchParams.get(k));
  });
  it("is 404 when login is not configured", async () => {
    const off = createOidcHandlers({ appUrl: APP_URL, sessions, oidc: undefined, secret: SESSION_SECRET });
    expect((await off.login(req("/api/auth/login"))).status).toBe(404);
  });
});

describe("callback: success", () => {
  it("exchanges the code (PKCE verified by the issuer), verifies the ID token, sets the session cookie and lands on returnTo", async () => {
    const { cb } = await signIn();
    expect(cb.status).toBe(302);
    expect(loc(cb).pathname).toBe("/bookings");
    const s = cookie(cb, "session")!;
    expect(s).toMatch(/HttpOnly/);
    expect(s).toMatch(/SameSite=Lax/);
    expect(cookie(cb, "login_tx")).toMatch(/Max-Age=0/); // transaction cookie is single-use
    const resolver = new CompositeActorResolver({ appUrl: APP_URL, sessions });
    const actor = await resolver.resolve(req("/x", { headers: { cookie: s.split(";")[0]! } }));
    expect(actor).toMatchObject({ kind: "user", userId: expect.stringMatching(/^[0-9a-f-]{36}$/), organizationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });
  it("an admin identity from the issuer yields an admin session", async () => {
    const { cb } = await signIn("/api/auth/login", "admin");
    const actor = await new CompositeActorResolver({ appUrl: APP_URL, sessions }).resolve(req("/x", { headers: { cookie: cookie(cb, "session")!.split(";")[0]! } }));
    expect(actor.kind).toBe("admin");
  });
  it("any user/org via the test hint form <userId>:<orgId>", async () => {
    const { cb } = await signIn("/api/auth/login", `${USER_ID}:${ORG_ID}`);
    const actor = await new CompositeActorResolver({ appUrl: APP_URL, sessions }).resolve(req("/x", { headers: { cookie: cookie(cb, "session")!.split(";")[0]! } }));
    expect(actor).toEqual({ kind: "user", userId: USER_ID, organizationId: ORG_ID });
  });
});

describe("callback: attacks and failures (no session is ever issued)", () => {
  const noSession = (r: Response) => expect(cookie(r, "session")).toBeUndefined();
  it("state mismatch (login CSRF / forged callback) → 400", async () => {
    const l = await h.login(req("/api/auth/login"));
    const auth = loc(l); auth.searchParams.set("login_hint", "customer");
    const a = await idp.fetch(auth.toString());
    const back = loc(a); back.searchParams.set("state", "attacker-chosen-state-value-0123456789");
    const cb = await h.callback(req(`${back.pathname}${back.search}`, { headers: { cookie: cookieHeader(l) } }));
    expect(cb.status).toBe(400);
    noSession(cb);
  });
  it("callback without our transaction cookie (code injected into a victim's browser) → 400", async () => {
    const { back } = await signIn();
    const cb = await h.callback(req(`${back.pathname}${back.search}`));
    expect(cb.status).toBe(400);
    noSession(cb);
  });
  it("a tampered or foreign-key transaction cookie is rejected", async () => {
    const l = await h.login(req("/api/auth/login"));
    const auth = loc(l); auth.searchParams.set("login_hint", "customer");
    const back = loc(await idp.fetch(auth.toString()));
    const other = createOidcHandlers({ appUrl: APP_URL, sessions, oidc, secret: "another-secret-another-secret-0123456789" });
    expect((await other.callback(req(`${back.pathname}${back.search}`, { headers: { cookie: cookieHeader(l) } }))).status).toBe(400);
    const [name, value] = cookieHeader(l).split("=") as [string, string];
    const mid = Math.floor(value.length / 2); // flip a char inside the ciphertext (the final char can be padding bits and change nothing)
    const bad = `${name}=${value.slice(0, mid)}${value[mid] === "A" ? "B" : "A"}${value.slice(mid + 1)}`;
    expect((await h.callback(req(`${back.pathname}${back.search}`, { headers: { cookie: bad } }))).status).toBe(400);
  });
  it("an expired transaction (>10 min) is rejected", async () => {
    const l = await h.login(req("/api/auth/login"));
    const auth = loc(l); auth.searchParams.set("login_hint", "customer");
    const back = loc(await idp.fetch(auth.toString()));
    clock.now = new Date(NOW.getTime() + 11 * 60_000);
    expect((await h.callback(req(`${back.pathname}${back.search}`, { headers: { cookie: cookieHeader(l) } }))).status).toBe(400);
  });
  it("authorization codes are single use: replaying the callback fails", async () => {
    const { l, back, cb } = await signIn();
    expect(cb.status).toBe(302);
    const again = await h.callback(req(`${back.pathname}${back.search}`, { headers: { cookie: cookieHeader(l) } }));
    expect(again.status).toBe(400);
    noSession(again);
  });
  it("issuer error (access_denied) → 4xx, transaction cookie cleared, nothing leaked", async () => {
    const l = await h.login(req("/api/auth/login"));
    const state = loc(l).searchParams.get("state")!;
    const cb = await h.callback(req(`/api/auth/callback?error=access_denied&error_description=%3Cscript%3E&state=${state}`, { headers: { cookie: cookieHeader(l) } }));
    expect(cb.status).toBe(400);
    expect(await cb.text()).not.toContain("<script>");
    expect(cookie(cb, "login_tx")).toMatch(/Max-Age=0/);
    noSession(cb);
  });
  it("missing code → 400", async () => {
    const l = await h.login(req("/api/auth/login"));
    const state = loc(l).searchParams.get("state")!;
    expect((await h.callback(req(`/api/auth/callback?state=${state}`, { headers: { cookie: cookieHeader(l) } }))).status).toBe(400);
  });
  it("PKCE: the issuer refuses a code redeemed with a different verifier", async () => {
    const challenge = createHash("sha256").update("the-real-verifier-0123456789-0123456789-abcdef").digest("base64url");
    const code = idp.issueCode({ clientId: CLIENT_ID, redirectUri: `${APP_URL}/api/auth/callback`, challenge, nonce: "n", login: "customer" });
    const res = await idp.fetch(`${ISSUER}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${APP_URL}/api/auth/callback`, client_id: CLIENT_ID, code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier-123" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
  it("PKCE: the issuer refuses an authorize request without a S256 challenge", async () => {
    const u = new URL(`${ISSUER}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: `${APP_URL}/api/auth/callback`, state: "s", nonce: "n", login_hint: "customer" })) u.searchParams.set(k, v);
    expect((await idp.fetch(u.toString())).status).toBe(400);
    u.searchParams.set("code_challenge", "x".repeat(43)); u.searchParams.set("code_challenge_method", "plain");
    expect((await idp.fetch(u.toString())).status).toBe(400);
  });
  it("the issuer only redirects to the registered redirect_uri (no open redirect through the IdP)", async () => {
    const u = new URL(`${ISSUER}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: "https://evil.example/cb", state: "s", nonce: "n", code_challenge: "x".repeat(43), code_challenge_method: "S256", login_hint: "customer" })) u.searchParams.set(k, v);
    const r = await idp.fetch(u.toString());
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
  });
});

describe("ID token validation", () => {
  let signer: MockIssuer;
  const v = (token: string, nonce = "n1", c: OidcClient = oidc) => c.verifyIdToken(token, nonce);
  const claims = { sub: USER_ID, org_id: ORG_ID, nonce: "n1" };
  beforeEach(() => { signer = idp.issuer; });
  it("accepts a correct token and maps claims to a session identity", async () => {
    const t = await signer.sign(claims, { audience: CLIENT_ID, typ: "JWT", issuedAt: NOW });
    expect(await v(t)).toEqual({ userId: USER_ID, organizationId: ORG_ID, role: "user" });
    const a = await signer.sign({ ...claims, roles: ["admin"] }, { audience: CLIENT_ID, typ: "JWT", issuedAt: NOW });
    expect((await v(a)).role).toBe("admin");
  });
  const bad: [string, () => Promise<string>][] = [
    ["wrong audience", () => signer.sign(claims, { audience: "someone-else", typ: "JWT", issuedAt: NOW })],
    ["wrong issuer", () => signer.sign(claims, { audience: CLIENT_ID, typ: "JWT", issuedAt: NOW, issuer: "https://evil.example" })],
    ["wrong nonce (replayed token)", () => signer.sign({ ...claims, nonce: "other" }, { audience: CLIENT_ID, typ: "JWT", issuedAt: NOW })],
    ["missing nonce", () => signer.sign({ sub: USER_ID, org_id: ORG_ID }, { audience: CLIENT_ID, typ: "JWT", issuedAt: NOW })],
    ["expired", () => signer.sign(claims, { audience: CLIENT_ID, typ: "JWT", issuedAt: new Date(NOW.getTime() - 3600_000), expiresInSec: 60 })],
    ["missing org_id (no tenant binding)", () => signer.sign({ sub: USER_ID, nonce: "n1" }, { audience: CLIENT_ID, typ: "JWT", issuedAt: NOW })],
    ["missing sub", () => signer.sign({ org_id: ORG_ID, nonce: "n1" }, { audience: CLIENT_ID, typ: "JWT", issuedAt: NOW })],
    ["signed by an unknown key", async () => (await MockIssuer.create(ISSUER)).sign(claims, { audience: CLIENT_ID, typ: "JWT", issuedAt: NOW })],
    ["alg=none", async () => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: ISSUER, aud: CLIENT_ID, ...claims, exp: 9e9 })).toString("base64url")}.`],
  ];
  for (const [name, mk] of bad) it(`rejects ${name}`, async () => { await expect(v(await mk())).rejects.toMatchObject({ code: "login_failed", status: 400 }); });
});

describe("discovery", () => {
  it("rejects a discovery document whose issuer differs from the configured one (mix-up defence)", async () => {
    const evil = new OidcClient({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: `${APP_URL}/api/auth/callback`, fetch: async () => Response.json({ issuer: "https://evil.example", authorization_endpoint: "https://evil.example/a", token_endpoint: "https://evil.example/t", jwks_uri: "https://evil.example/j" }) });
    await expect(evil.authorizationUrl({ state: "s", nonce: "n", challenge: "c" })).rejects.toMatchObject({ code: "login_failed", cause: expect.stringMatching(/issuer/i) });
  });
  it("refuses plain-http endpoints for non-local issuers", async () => {
    const c = new OidcClient({ issuer: "https://idp.example", clientId: CLIENT_ID, redirectUri: `${APP_URL}/api/auth/callback`, fetch: async () => Response.json({ issuer: "https://idp.example", authorization_endpoint: "http://idp.example/a", token_endpoint: "https://idp.example/t", jwks_uri: "https://idp.example/j" }) });
    await expect(c.authorizationUrl({ state: "s", nonce: "n", challenge: "c" })).rejects.toMatchObject({ code: "login_failed", cause: expect.stringMatching(/https/i) });
  });
});

describe("returnTo is same-site only", () => {
  for (const [input, out] of [
    ["/bookings", "/bookings"], ["/a?b=1#c", "/a?b=1#c"], [undefined, "/"], ["", "/"],
    ["https://evil.example", "/"], ["//evil.example", "/"], ["/\\evil.example", "/"], ["javascript:alert(1)", "/"], ["/%2f%2fevil", "/%2f%2fevil"], ["/\n/evil", "/"],
  ] as const) it(`${JSON.stringify(input)} → ${out}`, () => expect(safeReturnTo(input)).toBe(out));
  it("an attacker returnTo never survives the round trip", async () => {
    const { cb } = await signIn("/api/auth/login?returnTo=https%3A%2F%2Fevil.example%2Fphish");
    expect(loc(cb).origin).toBe(APP_URL);
    expect(loc(cb).pathname).toBe("/");
  });
});

describe("session endpoint + logout", () => {
  async function session() {
    const { cb } = await signIn();
    return cookie(cb, "session")!.split(";")[0]!;
  }
  it("GET /api/auth/session returns identity + the CSRF token for the signed-in browser; anonymous → authenticated:false", async () => {
    const c = await session();
    const r = await h.session(req("/api/auth/session", { headers: { cookie: c } }));
    const b = await r.json();
    expect(b.data).toMatchObject({ authenticated: true, role: "user", csrfToken: expect.any(String) });
    expect(r.headers.get("cache-control")).toBe("no-store");
    const anon = await (await h.session(req("/api/auth/session"))).json();
    expect(anon.data).toEqual({ authenticated: false });
  });
  it("logout needs CSRF: without the token → 403 and the session survives", async () => {
    const c = await session();
    const r = await h.logout(req("/api/auth/logout", { method: "POST", headers: { cookie: c } }));
    expect(r.status).toBe(403);
    expect(cookie(r, "session")).toBeUndefined();
  });
  it("logout with CSRF clears the cookie", async () => {
    const c = await session();
    const csrf = (await (await h.session(req("/api/auth/session", { headers: { cookie: c } }))).json()).data.csrfToken;
    const r = await h.logout(req("/api/auth/logout", { method: "POST", headers: { cookie: c, "x-csrf-token": csrf, origin: APP_URL } }));
    expect(r.status).toBe(200);
    expect(cookie(r, "session")).toMatch(/Max-Age=0/);
  });
  it("logout with a cross-origin Origin is refused even with a valid token", async () => {
    const c = await session();
    const csrf = (await (await h.session(req("/api/auth/session", { headers: { cookie: c } }))).json()).data.csrfToken;
    expect((await h.logout(req("/api/auth/logout", { method: "POST", headers: { cookie: c, "x-csrf-token": csrf, origin: "https://evil.example" } }))).status).toBe(403);
  });
  it("GET /api/auth/logout is not allowed (no logout-by-link)", async () => {
    expect((await h.logout(req("/api/auth/logout"))).status).toBe(405);
  });
});
