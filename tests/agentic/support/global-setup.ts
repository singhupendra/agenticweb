import { startApp } from "./app";
import { assertIsolatedDb, createIsolatedDb, dropIsolatedDb } from "./test-db";

export default async function setup() {
  const given = process.env.QA_DATABASE_URL;
  if (given) assertIsolatedDb(given);
  const dbUrl = given ?? (await createIsolatedDb());
  const app = await startApp(dbUrl);
  process.env.AGENTIC_BASE_URL = app.baseUrl;
  process.env.AGENTIC_DATABASE_URL = dbUrl;
  // Warm the routes (first `next dev` compile is slow) so test latencies are not dominated by compilation.
  for (const p of ["/api/health", "/openapi.json", "/api/organizations/northwind-studio/services"]) await fetch(`${app.baseUrl}${p}`).catch(() => undefined);
  await fetch(`${app.baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }) }).catch(() => undefined);
  return async () => { await app.stop(); if (!given) await dropIsolatedDb(dbUrl); };
}
