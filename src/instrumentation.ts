/** Next.js instrumentation hook: starts OpenTelemetry once per server process (Node runtime only; no-op without an endpoint). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ getEnv }, { startTelemetry }] = await Promise.all([import("@/core/env"), import("@/observability/sdk")]);
  startTelemetry(getEnv());
}
