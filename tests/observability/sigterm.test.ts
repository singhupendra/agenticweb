import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs the real SDK bootstrap in a child that installs NO SIGTERM handler of its own: it must still terminate on SIGTERM
// (after flushing), not hang because our listener swallowed the default behaviour.
let server: Server;
let endpoint = "";
beforeAll(async () => {
  server = createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(200).end("{}")); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("SIGTERM handling", () => {
  it("process still exits on SIGTERM after telemetry is started", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "-e", `
      import("${process.cwd()}/src/observability/sdk.ts").then(({ startTelemetry }) => {
        startTelemetry({ OTEL_SDK_DISABLED: false, OTEL_SERVICE_NAME: "t", OTEL_EXPORTER_OTLP_ENDPOINT: "${endpoint}", OTEL_TRACES_SAMPLER_ARG: 1 });
        console.log("ready");
        setInterval(() => {}, 1000);
      });
    `], { env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint } });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d) => String(d).includes("ready") && resolve());
      child.on("error", reject);
      setTimeout(() => reject(new Error("child never became ready")), 15_000);
    });
    const exited = new Promise<string | null>((r) => child.on("exit", (_c, sig) => r(sig)));
    child.kill("SIGTERM");
    const sig = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("HUNG"), 8_000))]);
    if (sig === "HUNG") child.kill("SIGKILL");
    expect(sig).toBe("SIGTERM");
  }, 40_000);
});
