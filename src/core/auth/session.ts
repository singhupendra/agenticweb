/**
 * Human sessions: HMAC-signed JWT in an HttpOnly, SameSite=Lax cookie (`__Host-` prefixed when Secure).
 * CSRF: cookie-authenticated unsafe requests must carry `x-csrf-token` = HMAC(secret, session id) (bound to the
 * session, so it cannot be forged or reused across sessions) AND, when sent, an Origin matching the app origin.
 * Bearer-token requests never use cookies and are therefore not CSRF-prone.
 */
import { jwtVerify, SignJWT } from "jose";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { forbidden } from "../errors";
import type { AdminActor, UserActor } from "./actor";

const ISSUER = "agenticweb:session";
const AUDIENCE = "agenticweb:session";
export const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface SessionManagerOptions {
  secret: string;
  appUrl: string;
  ttlSec?: number;
  now?: () => Date;
}

export interface SessionIdentity {
  userId: string;
  organizationId: string;
  role: "user" | "admin";
}

export class SessionManager {
  readonly cookieName: string;
  private readonly key: Uint8Array;
  private readonly secure: boolean;
  private readonly origin: string;
  constructor(private readonly o: SessionManagerOptions) {
    if (o.secret.length < 32) throw new Error("session secret must be at least 32 characters");
    this.key = new TextEncoder().encode(o.secret);
    const u = new URL(o.appUrl);
    this.secure = u.protocol === "https:";
    this.origin = u.origin;
    this.cookieName = this.secure ? "__Host-session" : "session";
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  /** Returns the Set-Cookie value plus the CSRF token the client must echo in `x-csrf-token`. */
  async create(id: SessionIdentity): Promise<{ setCookie: string; csrfToken: string; sessionId: string }> {
    const ttl = this.o.ttlSec ?? 8 * 3600;
    const sid = randomUUID();
    const iat = Math.floor(this.now().getTime() / 1000);
    const jwt = await new SignJWT({ org_id: id.organizationId, role: id.role, sid })
      .setProtectedHeader({ alg: "HS256", typ: "session+jwt" })
      .setSubject(id.userId).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt(iat).setExpirationTime(iat + ttl)
      .sign(this.key);
    return { setCookie: this.serialize(jwt, ttl), csrfToken: this.csrfFor(sid), sessionId: sid };
  }

  clearCookie(): string {
    return this.serialize("", 0);
  }

  private serialize(value: string, maxAge: number): string {
    return [`${this.cookieName}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, ...(this.secure ? ["Secure"] : [])].join("; ");
  }

  csrfFor(sessionId: string): string {
    return createHmac("sha256", this.key).update(`csrf:${sessionId}`).digest("base64url");
  }

  /** null when there is no (valid, unexpired) session cookie. */
  async read(request: Request): Promise<{ actor: UserActor | AdminActor; sessionId: string } | null> {
    const raw = parseCookies(request.headers.get("cookie"))[this.cookieName];
    if (!raw) return null;
    try {
      const { payload } = await jwtVerify(raw, this.key, {
        issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"], currentDate: this.now(), requiredClaims: ["sub", "sid", "org_id", "role"],
      });
      const role = payload.role === "admin" ? "admin" : payload.role === "user" ? "user" : null;
      if (!role || typeof payload.sub !== "string" || typeof payload.org_id !== "string" || typeof payload.sid !== "string") return null;
      return { actor: { kind: role, userId: payload.sub, organizationId: payload.org_id }, sessionId: payload.sid };
    } catch {
      return null; // expired / forged / wrong key: treated as no session
    }
  }

  /** Throws 403 unless the unsafe request proves same-origin intent. Safe methods pass. */
  assertCsrf(request: Request, sessionId: string): void {
    if (SAFE_METHODS.has(request.method.toUpperCase())) return;
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== this.origin) throw forbidden("CSRF validation failed.");
    const supplied = request.headers.get(CSRF_HEADER);
    const expected = this.csrfFor(sessionId);
    if (!supplied || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      throw forbidden("CSRF validation failed.");
    }
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
