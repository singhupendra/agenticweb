/** Real HTTP server around the MCP handler + the official SDK client over Streamable HTTP. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DevHeaderActorResolver, type Actor } from "@/core/auth";
import { AgentConfirmationGate } from "@/agents/policies";
import { createMcpHandler, type McpDeps } from "@/agents/mcp/server";
import { actorHeader } from "../api/harness";
import { testRuntime } from "../fixtures";

export const NOW = new Date("2026-11-09T10:00:00.000Z");

export async function startMcp(over: Partial<McpDeps> = {}, rt = testRuntime()) {
  const gate = new AgentConfirmationGate();
  const handler = createMcpHandler({
    runtime: () => rt,
    gate: () => gate,
    resolver: () => new DevHeaderActorResolver({ enabled: true, nodeEnv: "test", now: () => NOW }),
    appUrl: () => "http://localhost:3000",
    ...over,
  });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost:3000");
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
      // @ts-expect-error node fetch needs duplex for streamed bodies
      duplex: hasBody ? "half" : undefined,
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  const clients: Client[] = [];
  async function connect(actor?: Actor, headers: Record<string, string> = {}) {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { ...(actor ? actorHeader(actor) : {}), ...headers } } }));
    clients.push(client);
    return client;
  }
  const raw = (body: unknown, headers: Record<string, string> = {}, method = "POST") =>
    fetch(url, { method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
  return { rt, gate, url, connect, raw, close: async () => { await Promise.all(clients.map((c) => c.close())); await new Promise((r) => server.close(r)); } };
}

/** Parse the JSON text content of a tool result (problem or data). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const textJson = (r: any) => JSON.parse(r.content[0].text);

/** A write needs the HUMAN's out-of-band approval: call → confirmationId → human approves → retry with the id. */
export async function writeApproved(gate: AgentConfirmationGate, client: Client, approver: Actor, call: { name: string; arguments: Record<string, unknown> }) {
  const first = await client.callTool(call);
  const p = textJson(first);
  if (p.code !== "confirmation_required") return first;
  await gate.approve(p.confirmationId, approver);
  return client.callTool({ ...call, arguments: { ...call.arguments, confirmationId: p.confirmationId } });
}
