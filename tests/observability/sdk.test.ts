import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@/core/env";
import { recordToolInvocation, traced } from "@/observability";
import { startTelemetry } from "@/observability/sdk";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };
const hits: { url: string; bytes: number; body: string }[] = [];
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      hits.push({ url: req.url ?? "", bytes: buf.length, body: buf.toString("latin1") });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("SDK bootstrap", () => {
  it("exports spans and metrics over OTLP/HTTP to the configured endpoint, and flushes on shutdown", async () => {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint; // exporters read the standard variable themselves
    const handle = startTelemetry(loadEnv({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_SERVICE_NAME: "agenticweb-test" }));
    expect(handle.config).toMatchObject({ enabled: true, serviceName: "agenticweb-test" });

    await traced("sdk.smoke", async () => recordToolInvocation({ tool: "services.list", actorKind: "agent", outcome: "success", durationMs: 3 }));
    await handle.shutdown();

    expect(hits.some((h) => h.url === "/v1/traces" && h.bytes > 0)).toBe(true);
    expect(hits.some((h) => h.url === "/v1/metrics" && h.bytes > 0)).toBe(true);
    const all = hits.map((h) => h.body).join("\n");
    expect(all).toContain("agenticweb-test");
    expect(all).toContain("sdk.smoke");
    // Resource must not carry host/process details (command args may contain secrets).
    for (const key of ["process.command_args", "process.owner", "host.id", "process.pid"]) expect(all).not.toContain(key);
  });
});
