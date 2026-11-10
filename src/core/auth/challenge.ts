/** RFC 6750 / RFC 9728 / MCP authorization: `WWW-Authenticate: Bearer ...` challenges. */
import { AppError } from "../errors";

export interface ChallengeParams {
  resourceMetadata?: string;
  error?: "invalid_request" | "invalid_token" | "insufficient_scope";
  description?: string;
  /** Space-delimited scopes required for the operation (all of them, in one challenge). */
  scope?: string;
}

const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function bearerChallenge(p: ChallengeParams = {}): string {
  const parts: string[] = [];
  if (p.error) parts.push(`error=${quote(p.error)}`);
  if (p.description) parts.push(`error_description=${quote(p.description)}`);
  if (p.scope) parts.push(`scope=${quote(p.scope)}`);
  if (p.resourceMetadata) parts.push(`resource_metadata=${quote(p.resourceMetadata)}`);
  return parts.length ? `Bearer ${parts.join(", ")}` : "Bearer";
}

/** RFC 9728 §3.1: well-known segment goes between host and path of the resource identifier. */
export function resourceMetadataUrl(resource: string): string {
  const u = new URL(resource);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}

/**
 * Adapters call this on any AppError before responding. 401s (and insufficient_scope 403s) gain the
 * `resource_metadata` pointer MCP clients need to discover the authorization server; other errors pass through.
 */
export function decorateAuthError(err: unknown, resource: string): unknown {
  if (!(err instanceof AppError)) return err;
  const existing = err.headers?.["www-authenticate"];
  const isInsufficientScope = err.code === "forbidden" && existing?.includes("insufficient_scope");
  if (err.code !== "unauthenticated" && !isInsufficientScope) return err;
  const md = resourceMetadataUrl(resource);
  const challenge = !existing
    ? bearerChallenge({ resourceMetadata: md })
    : existing.includes("resource_metadata=")
      ? existing
      : `${existing}, resource_metadata=${quote(md)}`;
  return new AppError(err.code, err.message, { errors: err.errors, cause: err.cause, headers: { ...err.headers, "www-authenticate": challenge } });
}
