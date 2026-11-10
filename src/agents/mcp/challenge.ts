/**
 * RFC 6750 / RFC 9728 challenge for the MCP resource. 401s (and only 401s) gain `resource_metadata` so clients can
 * discover the authorization server. TODO(after Security PR #5): replace with `decorateAuthError` from `core/auth`.
 */
import { AppError } from "@/core/errors";

/** RFC 9728 §3.1: well-known segment goes between host and path of the resource identifier. */
export function resourceMetadataUrl(resource: string): string {
  const u = new URL(resource);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}

const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function authChallenge(err: unknown, resource: string): unknown {
  if (!(err instanceof AppError) || err.code !== "unauthenticated") return err;
  const existing = err.headers?.["www-authenticate"];
  const md = `resource_metadata=${quote(resourceMetadataUrl(resource))}`;
  const challenge = !existing ? `Bearer ${md}` : existing.includes("resource_metadata=") ? existing : `${existing}, ${md}`;
  return new AppError(err.code, err.message, { errors: err.errors, cause: err.cause, headers: { ...err.headers, "www-authenticate": challenge } });
}
