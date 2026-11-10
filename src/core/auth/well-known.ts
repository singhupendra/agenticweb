/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728), as required by the MCP authorization spec.
 * Served at /.well-known/oauth-protected-resource (REST resource = origin) and
 * /.well-known/oauth-protected-resource/mcp (MCP resource = <origin>/mcp).
 */
import { SCOPES } from "./actor";
import { resourceUri, type ResourceKind } from "./resolve-actor";

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ["header"];
  resource_name: string;
}

export function buildProtectedResourceMetadata(o: { appUrl: string; kind: ResourceKind; authorizationServers: string[] }): ProtectedResourceMetadata {
  return {
    resource: resourceUri(o.appUrl, o.kind),
    authorization_servers: o.authorizationServers,
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: o.kind === "mcp" ? "agenticweb MCP server" : "agenticweb API",
  };
}

/** `path` = segments after `/.well-known/oauth-protected-resource`. Unknown resources → 404 (no open metadata oracle). */
export function protectedResourceMetadataResponse(path: string[], o: { appUrl: string; authorizationServers: string[] }): Response {
  const kind: ResourceKind | null = path.length === 0 ? "rest" : path.length === 1 && path[0] === "mcp" ? "mcp" : null;
  if (!kind) return new Response(JSON.stringify({ code: "not_found", status: 404, title: "Resource not found" }), { status: 404, headers: { "content-type": "application/problem+json" } });
  return new Response(JSON.stringify(buildProtectedResourceMetadata({ ...o, kind })), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*", // public metadata; browser-based MCP clients must be able to read it
    },
  });
}
