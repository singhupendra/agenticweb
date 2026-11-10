/** The served spec: built once from the registry, ETag'd, with the server URL taken from the request origin. */
import { createHash } from "node:crypto";
import { registry } from "@/capabilities";
import { buildOpenApi, type OpenApiDocument } from "./openapi";
import { renderDocsHtml } from "./docs";
import { ifNoneMatchHit } from "./rest";

const base = (): OpenApiDocument => (cached ??= buildOpenApi(registry));
let cached: OpenApiDocument | undefined;

function respond(request: Request, contentType: string, render: (origin: string) => string): Response {
  const body = render(new URL(request.url).origin);
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  const headers = new Headers({ etag, "cache-control": "public, max-age=300", "content-type": contentType });
  if (ifNoneMatchHit(request.headers.get("if-none-match"), etag)) {
    headers.delete("content-type");
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}

const withServer = (origin: string): OpenApiDocument => ({ ...base(), servers: [{ url: origin }] });

export const openApiResponse = (request: Request) => respond(request, "application/json", (o) => JSON.stringify(withServer(o)));
export const docsResponse = (request: Request) => respond(request, "text/html; charset=utf-8", (o) => renderDocsHtml(withServer(o)));
