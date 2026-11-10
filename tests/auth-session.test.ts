import { beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "@/core/auth";
import { APP_URL, SESSION_SECRET, authKit, clock, req, ORG_ID, USER_ID } from "./fixtures/auth";
import { NOW } from "./fixtures";

beforeEach(() => { clock.now = NOW; });
const cookieOf = (setCookie: string) => setCookie.split(";")[0] as string;

describe("sessions + CSRF", () => {
  it("cookie attributes: HttpOnly, SameSite=Lax, Path=/, Max-Age; no Domain", async () => {
    const kit = await authKit();
    const { setCookie } = await kit.sessions.create({ userId: USER_ID, organizationId: ORG_ID, role: "user" });
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain=/);
  });
  it("https app uses __Host- prefix + Secure", async () => {
    const s = new SessionManager({ secret: SESSION_SECRET, appUrl: "https://agenticweb.example" });
    const { setCookie } = await s.create({ userId: USER_ID, organizationId: ORG_ID, role: "user" });
    expect(setCookie.startsWith("__Host-session=")).toBe(true);
    expect(setCookie).toMatch(/Secure/);
  });
  it("GET with a valid cookie resolves the actor without CSRF", async () => {
    const kit = await authKit();
    const { setCookie } = await kit.sessions.create({ userId: USER_ID, organizationId: ORG_ID, role: "admin" });
    expect(await kit.resolver.resolve(req({ cookie: cookieOf(setCookie) }))).toEqual({ kind: "admin", userId: USER_ID, organizationId: ORG_ID });
  });
  describe("unsafe methods", () => {
    const post = (cookie: string, h: Record<string, string> = {}) => req({ cookie, ...h }, { method: "POST" });
    it("rejects without CSRF token (403)", async () => {
      const kit = await authKit();
      const { setCookie } = await kit.sessions.create({ userId: USER_ID, organizationId: ORG_ID, role: "user" });
      await expect(kit.resolver.resolve(post(cookieOf(setCookie)))).rejects.toMatchObject({ code: "forbidden", status: 403 });
    });
    it("accepts correct token (and same-origin Origin)", async () => {
      const kit = await authKit();
      const { setCookie, csrfToken } = await kit.sessions.create({ userId: USER_ID, organizationId: ORG_ID, role: "user" });
      await expect(kit.resolver.resolve(post(cookieOf(setCookie), { "x-csrf-token": csrfToken, origin: APP_URL }))).resolves.toMatchObject({ kind: "user" });
    });
    it("rejects a cross-origin Origin even with a valid token", async () => {
      const kit = await authKit();
      const { setCookie, csrfToken } = await kit.sessions.create({ userId: USER_ID, organizationId: ORG_ID, role: "user" });
      await expect(kit.resolver.resolve(post(cookieOf(setCookie), { "x-csrf-token": csrfToken, origin: "https://evil.test" }))).rejects.toMatchObject({ code: "forbidden" });
    });
    it("rejects a CSRF token from a different session", async () => {
      const kit = await authKit();
      const a = await kit.sessions.create({ userId: USER_ID, organizationId: ORG_ID, role: "user" });
      const b = await kit.sessions.create({ userId: USER_ID, organizationId: ORG_ID, role: "user" });
      await expect(kit.resolver.resolve(post(cookieOf(a.setCookie), { "x-csrf-token": b.csrfToken }))).rejects.toMatchObject({ code: "forbidden" });
    });
  });
  it("expired, forged and wrong-secret cookies are anonymous (no session), not errors", async () => {
    const kit = await authKit();
    const { setCookie } = await kit.sessions.create({ userId: USER_ID, organizationId: ORG_ID, role: "user" });
    clock.now = new Date(NOW.getTime() + 9 * 3600_000);
    expect(await kit.resolver.resolve(req({ cookie: cookieOf(setCookie) }))).toEqual({ kind: "anonymous" });
    clock.now = NOW;
    const other = new SessionManager({ secret: "another-secret-another-secret-123456", appUrl: APP_URL, now: () => NOW });
    const forged = await other.create({ userId: USER_ID, organizationId: ORG_ID, role: "admin" });
    expect(await kit.resolver.resolve(req({ cookie: cookieOf(forged.setCookie) }))).toEqual({ kind: "anonymous" });
  });
  it("a session cookie value is not accepted as a bearer token (token confusion)", async () => {
    const kit = await authKit();
    const { setCookie } = await kit.sessions.create({ userId: USER_ID, organizationId: ORG_ID, role: "admin" });
    const jwt = cookieOf(setCookie).split("=")[1] as string;
    await expect(kit.resolver.resolve(req({ authorization: `Bearer ${jwt}` }))).rejects.toMatchObject({ status: 401 });
  });
  it("rejects secrets shorter than 32 chars", () => expect(() => new SessionManager({ secret: "short", appUrl: APP_URL })).toThrow());
});
