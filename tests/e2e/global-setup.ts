/** Warm `next dev`'s on-demand route compilation (runs after the webServer is healthy) so first-hit compile time never trips expect timeouts. */
export default async function globalSetup() {
  const base = `http://localhost:${process.env.E2E_PORT ?? 3100}`;
  const get = ["/", "/services", "/services/quick-consult", "/bookings/00000000-0000-4000-8000-000000000999", "/robots.txt", "/sitemap.xml", "/llms.txt", "/openapi.json", "/docs", "/webmcp.json",
    "/api/organizations/northwind-studio/services", "/api/organizations/northwind-studio/services/quick-consult/slots", "/api/organizations/northwind-studio/bookings"];
  for (const p of get) await fetch(base + p).catch(() => undefined);
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) }).catch(() => undefined);
  await post("/api/organizations/northwind-studio/bookings", {});
  await post("/api/dev/mock-issuer/token", { kind: "user" });
  await post("/api/confirmations/00000000-0000-4000-8000-000000000000/approve", {});
  await post("/mcp", { jsonrpc: "2.0", id: 0, method: "tools/list" });
}
