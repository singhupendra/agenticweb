import { CompositeActorResolver, InMemoryGrantStore, MockIssuer, SessionManager, createAccessTokenVerifier, resourceUri } from "@/core/auth";
import type { Grant } from "@/core/auth";
import { NOW, ORG_ID, USER_ID } from "./index";

export const APP_URL = "http://localhost:3000";
export const ISSUER = "https://idp.test";
export const REST_AUD = resourceUri(APP_URL, "rest");
export const MCP_AUD = resourceUri(APP_URL, "mcp");
export const SESSION_SECRET = "test-session-secret-0123456789-abcdefgh";
export const clock = { now: NOW };

export async function authKit(grants: Grant[] | null = [{ grantId: "grant-1", userId: USER_ID, clientId: "client-1", scopes: ["services:read", "bookings:read", "bookings:write"] }]) {
  const issuer = await MockIssuer.create(ISSUER);
  const grantStore = grants ? new InMemoryGrantStore(grants) : undefined;
  const verifier = createAccessTokenVerifier({ issuer: ISSUER, keys: issuer.keys, grants: grantStore, now: () => clock.now });
  const sessions = new SessionManager({ secret: SESSION_SECRET, appUrl: APP_URL, now: () => clock.now });
  const resolver = new CompositeActorResolver({ appUrl: APP_URL, verifier, sessions });
  const opts = (over: object = {}) => ({ audience: REST_AUD, issuedAt: clock.now, ...over });
  return { issuer, grantStore, verifier, sessions, resolver, opts };
}
export const bearer = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });
export const req = (headers: Record<string, string> = {}, init: RequestInit = {}) => new Request(`${APP_URL}/api/x`, { ...init, headers });
export { ORG_ID, USER_ID };
