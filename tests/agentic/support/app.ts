/** Starts the REAL Next.js app (dev mode: mock issuer + dev actor are refused in production builds) against an isolated DB. */
import { spawn, type ChildProcess } from "node:child_process";
import { assertIsolatedDb } from "./test-db";

export interface RunningApp { baseUrl: string; stop: () => Promise<void> }

export async function startApp(databaseUrl: string, port = Number(process.env.AGENTIC_PORT ?? 3200)): Promise<RunningApp> {
  assertIsolatedDb(databaseUrl);
  const baseUrl = `http://localhost:${port}`;
  // Never attach to someone else's server (it would talk to a different database): the port must be free.
  if (await fetch(`${baseUrl}/api/health`).then(() => true, () => false)) throw new Error(`port ${port} is already serving; set AGENTIC_PORT to a free port`);
  const child: ChildProcess = spawn("pnpm", ["exec", "next", "dev", "-p", String(port)], {
    env: {
      ...process.env, DATABASE_URL: databaseUrl, APP_URL: baseUrl, NODE_ENV: "development", LOG_LEVEL: "error",
      DEV_AUTH_ENABLED: "true", MOCK_ISSUER_ENABLED: "true", RATE_LIMIT_ANON_PER_MIN: "100000", RATE_LIMIT_AUTH_PER_MIN: "100000",
    },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let log = "";
  child.stdout?.on("data", (d) => (log += d)); child.stderr?.on("data", (d) => (log += d));
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next dev exited early:\n${log}`);
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error(`next dev did not become healthy:\n${log}`); }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    baseUrl,
    stop: async () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ } },
  };
}
