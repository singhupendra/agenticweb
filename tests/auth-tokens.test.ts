import { SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { MCP_AUD, REST_AUD, authKit, clock, ISSUER, ORG_ID, USER_ID } from "./fixtures/auth";
import { NOW } from "./fixtures";

let kit: Awaited<ReturnType<typeof authKit>>;
beforeEach(async () => {
  clock.now = NOW;
  kit = await authKit();
});
const verify = (t: string, aud = [REST_AUD]) => kit.verifier.verify(t, aud);
const agentP = { clientId: "client-1", grantId: "grant-1", userId: USER_ID, organizationId: ORG_ID };

describe("access token verification", () => {
  it("user token → user actor", async () => {
    expect(await verify(await kit.issuer.user({ userId: USER_ID, organizationId: ORG_ID }, kit.opts()))).toEqual({ kind: "user", userId: USER_ID, organizationId: ORG_ID });
  });
  it("admin role claim → admin actor (user tokens only)", async () => {
    expect((await verify(await kit.issuer.user({ userId: USER_ID, organizationId: ORG_ID, admin: true }, kit.opts()))).kind).toBe("admin");
  });
  it("agent token → delegated agent bound to the user, scopes parsed", async () => {
    const a = await verify(await kit.issuer.agent({ ...agentP, scopes: ["services:read", "bookings:write"] }, kit.opts()));
    expect(a).toMatchObject({ kind: "agent", clientId: "client-1", onBehalfOf: { userId: USER_ID, organizationId: ORG_ID }, delegation: { grantId: "grant-1", scopes: ["services:read", "bookings:write"], audience: REST_AUD } });
  });
  it("agents are never admin even if the token claims the admin role", async () => {
    const t = await kit.issuer.sign({ sub: USER_ID, org_id: ORG_ID, roles: ["admin"], token_use: "agent", client_id: "client-1", grant_id: "grant-1", scope: "bookings:read" }, kit.opts());
    expect((await verify(t)).kind).toBe("agent");
  });

  describe("rejections (401 invalid_token, never anonymous)", () => {
    const bad = (t: string, aud?: string[]) => expect(verify(t, aud)).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
    it("expired token (and says so in the challenge)", async () => {
      const t = await kit.issuer.user({ userId: USER_ID, organizationId: ORG_ID }, kit.opts({ expiresInSec: 60 }));
      clock.now = new Date(NOW.getTime() + 120_000);
      const e = await verify(t).catch((x) => x);
      expect(e).toMatchObject({ code: "unauthenticated", reason: "expired" });
      expect(e.headers["www-authenticate"]).toContain('error="invalid_token"');
      expect(e.headers["www-authenticate"]).toContain("expired");
    });
    it("expiry boundary honours only the small clock skew", async () => {
      const t = await kit.issuer.user({ userId: USER_ID, organizationId: ORG_ID }, kit.opts({ expiresInSec: 60 }));
      clock.now = new Date(NOW.getTime() + 64_000);
      await expect(verify(t)).resolves.toBeDefined();
      clock.now = new Date(NOW.getTime() + 66_000);
      await bad(t);
    });
    it("wrong audience (token minted for another resource / for MCP used on REST)", async () => {
      await bad(await kit.issuer.user({ userId: USER_ID, organizationId: ORG_ID }, kit.opts({ audience: "https://other.example" })));
      await bad(await kit.issuer.user({ userId: USER_ID, organizationId: ORG_ID }, kit.opts({ audience: MCP_AUD })));
      await expect(verify(await kit.issuer.user({ userId: USER_ID, organizationId: ORG_ID }, kit.opts({ audience: MCP_AUD })), [MCP_AUD])).resolves.toBeDefined();
    });
    it("wrong issuer", async () =>
      bad(await kit.issuer.user({ userId: USER_ID, organizationId: ORG_ID }, kit.opts({ issuer: "https://evil.test" }))));
    it("signature from a different key", async () => {
      const other = await (await import("@/core/auth")).MockIssuer.create(ISSUER);
      await bad(await other.user({ userId: USER_ID, organizationId: ORG_ID }, kit.opts()));
    });
    it("alg=none and HS256 (confusion) tokens", async () => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const claims = { iss: ISSUER, aud: REST_AUD, sub: USER_ID, org_id: ORG_ID, token_use: "user", jti: "abcdefgh1", iat: Math.floor(NOW.getTime() / 1000), exp: Math.floor(NOW.getTime() / 1000) + 600 };
      await bad(`${b64({ alg: "none", typ: "at+jwt" })}.${b64(claims)}.`);
      const hs = await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("x".repeat(32)));
      await bad(hs);
    });
    it("garbage / tampered payload", async () => {
      const t = await kit.issuer.user({ userId: USER_ID, organizationId: ORG_ID }, kit.opts());
      const [h, , s] = t.split(".");
      const evil = Buffer.from(JSON.stringify({ sub: "admin" })).toString("base64url");
      await bad(`${h}.${evil}.${s}`);
      await bad("not-a-jwt");
    });
    it("missing jti, missing token_use, user token without org", async () => {
      await bad(await kit.issuer.sign({ sub: USER_ID, org_id: ORG_ID, token_use: "user" }, kit.opts({ jti: null })));
      await bad(await kit.issuer.sign({ sub: USER_ID, org_id: ORG_ID }, kit.opts()));
      await bad(await kit.issuer.sign({ sub: USER_ID, token_use: "user" }, kit.opts()));
    });
    it("a token carrying agent claims cannot masquerade as the user", async () =>
      bad(await kit.issuer.sign({ sub: USER_ID, org_id: ORG_ID, token_use: "user", client_id: "c", grant_id: "g" }, kit.opts())));
    it("agent token without client_id/grant_id, or living longer than the cap", async () => {
      await bad(await kit.issuer.sign({ sub: USER_ID, org_id: ORG_ID, token_use: "agent", scope: "bookings:write" }, kit.opts()));
      await bad(await kit.issuer.agent({ ...agentP, scopes: ["services:read"] }, kit.opts({ expiresInSec: 7200 })));
    });
  });

  describe("scope escalation & revocation (grant store is authoritative)", () => {
    it("token scopes beyond the grant are dropped", async () => {
      kit.grantStore?.put({ grantId: "grant-r", userId: USER_ID, clientId: "client-1", scopes: ["services:read"] });
      const a = await verify(await kit.issuer.agent({ ...agentP, grantId: "grant-r", scopes: ["services:read", "bookings:write", "bookings:read"] }, kit.opts()));
      expect(a.kind === "agent" && a.delegation.scopes).toEqual(["services:read"]);
    });
    it("unknown scopes (openid, admin, *) grant nothing", async () => {
      const a = await verify(await kit.issuer.agent({ ...agentP, scopes: ["openid", "admin", "*", "bookings:read"] }, kit.opts()));
      expect(a.kind === "agent" && a.delegation.scopes).toEqual(["bookings:read"]);
    });
    it("revoked grant is rejected immediately", async () => {
      const t = await kit.issuer.agent({ ...agentP, scopes: ["bookings:read"] }, kit.opts());
      await expect(verify(t)).resolves.toBeDefined();
      kit.grantStore?.revoke("grant-1", NOW);
      await expect(verify(t)).rejects.toMatchObject({ status: 401 });
    });
    it("unknown grant, other user's grant, other client's grant are rejected", async () => {
      await expect(verify(await kit.issuer.agent({ ...agentP, grantId: "nope", scopes: ["bookings:read"] }, kit.opts()))).rejects.toMatchObject({ status: 401 });
      await expect(verify(await kit.issuer.agent({ ...agentP, userId: "someone-else-1", scopes: ["bookings:read"] }, kit.opts()))).rejects.toMatchObject({ status: 401 });
      await expect(verify(await kit.issuer.agent({ ...agentP, clientId: "client-2", scopes: ["bookings:read"] }, kit.opts()))).rejects.toMatchObject({ status: 401 });
    });
    it("public-only agent (no org) has no user identity", async () => {
      const a = await verify(await kit.issuer.agent({ clientId: "client-1", grantId: "grant-1", scopes: ["services:read"] }, kit.opts()));
      expect(a).toMatchObject({ kind: "agent", onBehalfOf: null });
    });
  });
});
