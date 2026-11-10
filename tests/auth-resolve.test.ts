import { beforeEach, describe, expect, it } from "vitest";
import { CompositeActorResolver, DevHeaderActorResolver, bearerChallenge, decorateAuthError, resourceMetadataUrl, buildProtectedResourceMetadata, protectedResourceMetadataResponse } from "@/core/auth";
import { AppError, unauthenticated } from "@/core/errors";
import { APP_URL, MCP_AUD, authKit, bearer, clock, req, ORG_ID, USER_ID } from "./fixtures/auth";
import { NOW } from "./fixtures";

beforeEach(() => { clock.now = NOW; });

describe("resolveActor precedence & fail-closed behaviour", () => {
  it("no credentials → anonymous", async () => expect(await (await authKit()).resolver.resolve(req())).toEqual({ kind: "anonymous" }));
  it("valid bearer → actor; MCP resource requires an MCP-audience token", async () => {
    const kit = await authKit();
    const rest = await kit.issuer.user({ userId: USER_ID, organizationId: ORG_ID }, kit.opts());
    await expect(kit.resolver.resolve(req(bearer(rest)))).resolves.toMatchObject({ kind: "user" });
    await expect(kit.resolver.resolve(req(bearer(rest)), { resource: "mcp" })).rejects.toMatchObject({ status: 401 });
    const mcp = await kit.issuer.user({ userId: USER_ID, organizationId: ORG_ID }, kit.opts({ audience: MCP_AUD }));
    await expect(kit.resolver.resolve(req(bearer(mcp)), { resource: "mcp" })).resolves.toMatchObject({ kind: "user" });
    await expect(kit.resolver.resolve(req(bearer(mcp)))).rejects.toMatchObject({ status: 401 }); // no token passthrough across resources
  });
  it("an invalid bearer is a 401 even when a valid session cookie is also present (never downgraded)", async () => {
    const kit = await authKit();
    const { setCookie } = await kit.sessions.create({ userId: USER_ID, organizationId: ORG_ID, role: "user" });
    await expect(kit.resolver.resolve(req({ authorization: "Bearer abc.def.ghi", cookie: setCookie.split(";")[0] as string }))).rejects.toMatchObject({ status: 401 });
  });
  it("non-Bearer schemes and malformed headers are 401 with a challenge", async () => {
    const kit = await authKit();
    for (const h of ["Basic dXNlcjpwdw==", "Bearer", "Bearer a b", "bearer"]) {
      const e = await kit.resolver.resolve(req({ authorization: h })).catch((x) => x);
      expect(e).toMatchObject({ status: 401 });
      expect(e.headers["www-authenticate"]).toMatch(/^Bearer/);
    }
  });
  it("bearer with no verifier configured is rejected, not ignored", async () => {
    const r = new CompositeActorResolver({ appUrl: APP_URL });
    await expect(r.resolve(req({ authorization: "Bearer abc.def.ghi" }))).rejects.toMatchObject({ status: 401 });
  });
  it("dev header is only consulted when configured, and loses to real credentials", async () => {
    const kit = await authKit();
    const dev = new DevHeaderActorResolver({ enabled: true, nodeEnv: "test" });
    const r = new CompositeActorResolver({ appUrl: APP_URL, verifier: kit.verifier, dev });
    expect(await r.resolve(req({ "x-dev-actor": `admin|${USER_ID}|${ORG_ID}` }))).toMatchObject({ kind: "admin" });
    await expect(r.resolve(req({ "x-dev-actor": `admin|${USER_ID}|${ORG_ID}`, authorization: "Bearer x.y.z" }))).rejects.toMatchObject({ status: 401 });
    expect(await kit.resolver.resolve(req({ "x-dev-actor": `admin|${USER_ID}|${ORG_ID}` }))).toEqual({ kind: "anonymous" });
  });
  it("401 bodies never leak verification internals", async () => {
    const kit = await authKit();
    const e = await kit.resolver.resolve(req(bearer("a.b.c"))).catch((x) => x);
    expect(e.message).toBe("The access token is invalid.");
    expect(e.headers["www-authenticate"]).not.toMatch(/signature|JWS|jose|alg/i);
  });
});

describe("WWW-Authenticate / RFC 9728", () => {
  const md = `${APP_URL}/.well-known/oauth-protected-resource`;
  it("challenge formats per RFC 6750 + MCP", () => {
    expect(bearerChallenge({ resourceMetadata: md })).toBe(`Bearer resource_metadata="${md}"`);
    expect(bearerChallenge({ error: "insufficient_scope", scope: "bookings:write", resourceMetadata: md })).toBe(
      `Bearer error="insufficient_scope", scope="bookings:write", resource_metadata="${md}"`);
    expect(bearerChallenge({ description: 'a"b' })).toContain('a\\"b');
  });
  it("metadata URL inserts the well-known segment before the resource path", () => {
    expect(resourceMetadataUrl("http://localhost:3000")).toBe(md);
    expect(resourceMetadataUrl("http://localhost:3000/mcp")).toBe(`${md}/mcp`);
  });
  it("decorateAuthError adds resource_metadata to 401 and insufficient_scope 403 only", () => {
    const h = (e: unknown) => (e as AppError).headers?.["www-authenticate"];
    expect(h(decorateAuthError(unauthenticated(), APP_URL))).toBe(`Bearer resource_metadata="${md}"`);
    const tok = new AppError("unauthenticated", "x", { headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
    expect(h(decorateAuthError(tok, APP_URL))).toBe(`Bearer error="invalid_token", resource_metadata="${md}"`);
    expect(h(decorateAuthError(new AppError("forbidden", "x"), APP_URL))).toBeUndefined();
    expect(h(decorateAuthError(new AppError("not_found", "x"), APP_URL))).toBeUndefined();
    const once = decorateAuthError(unauthenticated(), APP_URL);
    expect(h(decorateAuthError(once, APP_URL))).toBe(`Bearer resource_metadata="${md}"`);
  });
  it("metadata document: resource, authorization_servers, scopes, header bearer only", () => {
    const m = buildProtectedResourceMetadata({ appUrl: APP_URL, kind: "mcp", authorizationServers: ["https://idp.test"] });
    expect(m).toMatchObject({ resource: `${APP_URL}/mcp`, authorization_servers: ["https://idp.test"], bearer_methods_supported: ["header"] });
    expect(m.scopes_supported).toEqual(["services:read", "bookings:read", "bookings:write", "profile:read"]);
  });
  it("route handler serves root + /mcp, 404s anything else, is public + cacheable", async () => {
    const o = { appUrl: APP_URL, authorizationServers: ["https://idp.test"] };
    const root = protectedResourceMetadataResponse([], o);
    expect(root.status).toBe(200);
    expect((await root.json()).resource).toBe(APP_URL);
    expect(root.headers.get("access-control-allow-origin")).toBe("*");
    expect((await protectedResourceMetadataResponse(["mcp"], o).json()).resource).toBe(`${APP_URL}/mcp`);
    expect(protectedResourceMetadataResponse(["admin"], o).status).toBe(404);
    expect(protectedResourceMetadataResponse(["mcp", "x"], o).status).toBe(404);
  });
});
