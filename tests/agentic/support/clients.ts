/** Channel drivers used by agentic tests, parity tests and evals: mint tokens, MCP client, REST, and DB ground truth. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";
import { assertIsolatedDb } from "./test-db";

export const ORG_SLUG = "northwind-studio";
export const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
export const ADMIN_ID = "00000000-0000-4000-8000-0000000000b1";
export const CUSTOMER_ID = "00000000-0000-4000-8000-0000000000b2";
export const OTHER_ID = "00000000-0000-4000-8000-0000000000b3";
export const ALL_AGENT_SCOPES = ["services:read", "bookings:read", "bookings:write"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface MintOpts {
  kind: "user" | "admin" | "agent";
  userId?: string; organizationId?: string; scopes?: string[]; resource?: "rest" | "mcp"; expiresInSec?: number; clientId?: string; grantId?: string;
}

export class Channels {
  constructor(readonly baseUrl: string, readonly dbUrl: string) { assertIsolatedDb(dbUrl); }

  /** Token from the app's mock issuer (the same verification path a real IdP token takes). */
  async mint(o: MintOpts): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/dev/mock-issuer/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resource: "rest", ...o }) });
    if (!res.ok) throw new Error(`mint failed ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }
  userToken = (userId = CUSTOMER_ID, resource: "rest" | "mcp" = "rest") => this.mint({ kind: "user", userId, organizationId: ORG_ID, resource });
  agentToken = (scopes: string[] = [...ALL_AGENT_SCOPES], userId: string | undefined = CUSTOMER_ID, o: Partial<MintOpts> = {}) =>
    this.mint({ kind: "agent", userId, organizationId: userId ? ORG_ID : undefined, scopes, resource: "mcp", ...o });

  /** MCP SDK client over Streamable HTTP — the same client a real agent host uses. */
  async mcp(token?: string): Promise<Client> {
    const c = new Client({ name: "agentic-qa", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp`), { requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } }));
    return c;
  }
  /** Raw JSON-RPC (for transport-level assertions: status codes, headers). */
  mcpRaw(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${this.baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  }
  async rest(method: string, path: string, o: { token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Headers; body: Json }> {
    const headers: Record<string, string> = { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) };
    let body = o.rawBody;
    if (o.body !== undefined) { body = JSON.stringify(o.body); headers["content-type"] = "application/json"; }
    const res = await fetch(`${this.baseUrl}/api/organizations/${ORG_SLUG}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed: Json = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: res.status, headers: res.headers, body: parsed };
  }

  // ---- ground truth straight from Postgres (not through any API) ----
  async sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const c = new pg.Client({ connectionString: this.dbUrl });
    await c.connect();
    try { return (await c.query(text, params)).rows as T[]; } finally { await c.end(); }
  }
  async ensureOtherUser() {
    await this.sql(`INSERT INTO "User"(id,"organizationId",email,name) VALUES ($1,$2,'other@example.com','Other Customer') ON CONFLICT DO NOTHING`, [OTHER_ID, ORG_ID]);
  }
  bookingsFor = (userId: string) => this.sql(`SELECT b.id,b.status,b.notes,b."userId",b."slotId",s."serviceId" FROM "Booking" b JOIN "Slot" s ON s.id=b."slotId" WHERE b."userId"=$1 ORDER BY b."createdAt"`, [userId]);
  activeBookingsOnSlot = (slotId: string) => this.sql(`SELECT id,status,"userId" FROM "Booking" WHERE "slotId"=$1 AND status<>'cancelled'`, [slotId]);
  bookingCount = async () => Number((await this.sql(`SELECT count(*)::int AS n FROM "Booking"`))[0]!.n);
  auditFor = (capability: string, outcome?: string) => this.sql(`SELECT outcome,"actorKind","actorId","onBehalfOf","resourceId","inputHash" FROM "AuditEvent" WHERE capability=$1 ${outcome ? "AND outcome=$2" : ""} ORDER BY "occurredAt"`, outcome ? [capability, outcome] : [capability]);
  /** A fresh, future, un-booked slot for `serviceSlug` (so scenarios never collide on shared seed data). */
  async freshSlot(serviceSlug: string, hoursAhead = 24 * 30): Promise<{ id: string; startsAt: string }> {
    const [svc] = await this.sql<{ id: string; durationMinutes: number }>(`SELECT id,"durationMinutes" FROM "Service" WHERE slug=$1`, [serviceSlug]);
    const startsAt = new Date(Date.now() + hoursAhead * 3_600_000 + Math.floor(Math.random() * 1800) * 1000); // <30 min jitter keeps hour-offset ordering
    const [row] = await this.sql<{ id: string }>(`INSERT INTO "Slot"("id","serviceId","startsAt","endsAt",capacity) VALUES (gen_random_uuid(),$1,$2,$3,1) RETURNING id`, [svc!.id, startsAt, new Date(startsAt.getTime() + svc!.durationMinutes * 60_000)]);
    return { id: row!.id, startsAt: startsAt.toISOString() };
  }
  async pastSlot(serviceSlug: string): Promise<string> {
    const [svc] = await this.sql<{ id: string }>(`SELECT id FROM "Service" WHERE slug=$1`, [serviceSlug]);
    const startsAt = new Date(Date.now() - 3_600_000 - Math.floor(Math.random() * 1e6) * 1000);
    const [row] = await this.sql<{ id: string }>(`INSERT INTO "Slot"("id","serviceId","startsAt","endsAt",capacity) VALUES (gen_random_uuid(),$1,$2,$3,1) RETURNING id`, [svc!.id, startsAt, new Date(startsAt.getTime() + 1_800_000)]);
    return row!.id;
  }
}

export const toolJson = (r: Json): Json => JSON.parse(r.content[0].text);
export const newKey = (p = "qa") => `${p}-${crypto.randomUUID()}`;
export const channels = () => {
  const baseUrl = process.env.AGENTIC_BASE_URL, dbUrl = process.env.AGENTIC_DATABASE_URL;
  if (!baseUrl || !dbUrl) throw new Error("agentic app not started (global setup missing)");
  return new Channels(baseUrl, dbUrl);
};
