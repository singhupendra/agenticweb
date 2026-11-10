import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { z } from "zod";
import { ANONYMOUS } from "@/core/auth";
import { createExecutor, createRegistry, defineCapability } from "@/core/capabilities";
import { DefaultPolicy } from "@/core/authorization";
import { InMemoryIdempotencyStore } from "@/core/idempotency";
import { InMemoryAuditLog, nullLogger } from "@/core/logging";
import { METRIC_NAMES, createOtelInstrument } from "@/observability";
import { NOW, agent, user } from "../fixtures";
import { installTelemetry } from "./harness";

const t = installTelemetry();
afterAll(() => t.shutdown());
beforeAll(() => t.spans.reset());

const read = defineCapability({
  name: "things.list", summary: "read", input: z.strictObject({ q: z.string().optional() }), output: z.object({ ok: z.boolean() }),
  requirement: { access: "authenticated", scope: "services:read" }, mutating: false,
  http: { method: "GET", path: "/api/things" }, mcp: { toolName: "list_things", exposed: true },
  execute: async () => ({ ok: true }),
});
const write = defineCapability({
  name: "things.create", summary: "write", input: z.strictObject({ n: z.number() }), output: z.object({ ok: z.boolean() }),
  requirement: { access: "authenticated", scope: "bookings:write" }, mutating: true,
  http: { method: "POST", path: "/api/things" }, mcp: { toolName: "create_thing", exposed: true },
  execute: async (_c, i) => { if (i.n === 13) throw new Error("db password=hunter2 exploded"); return { ok: true }; },
});
const executor = createExecutor({
  registry: createRegistry([read, write]), policy: new DefaultPolicy(() => NOW), audit: new InMemoryAuditLog(),
  idempotency: new InMemoryIdempotencyStore(), logger: nullLogger, deps: {}, clock: () => NOW, instrument: createOtelInstrument(),
});
const count = async (name: string, where: Record<string, unknown>) =>
  (await t.points(name)).filter((p) => Object.entries(where).every(([k, v]) => p.attributes[k] === v)).reduce((n, p) => n + (p.value as number), 0);
const settle = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e as { code?: string }).code ?? "throw");

describe("executor instrumentation", () => {
  const ag = agent(["services:read", "bookings:write"]);

  it("emits a span + success metrics for a successful read", async () => {
    await executor.invoke("things.list", ag, {});
    const s = t.spans.getFinishedSpans().find((x) => x.name === "capability things.list")!;
    expect(s.attributes).toMatchObject({ "capability.name": "things.list", "actor.kind": "agent", "capability.mutating": false });
    expect(await count(METRIC_NAMES.toolInvocations, { tool: "things.list", outcome: "success", actor_kind: "agent" })).toBe(1);
    expect((await t.points(METRIC_NAMES.toolDuration)).length).toBeGreaterThan(0);
  });

  it("counts invalid arguments (and does not mark the span as a server error)", async () => {
    expect(await settle(executor.invoke("things.list", ag, { nope: 1 }))).toBe("validation_failed");
    expect(await count(METRIC_NAMES.invalidArguments, { tool: "things.list" })).toBe(1);
    expect(await count(METRIC_NAMES.toolInvocations, { tool: "things.list", outcome: "invalid_argument" })).toBe(1);
    const spans = t.spans.getFinishedSpans().filter((x) => x.name === "capability things.list");
    expect(spans.at(-1)!.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("counts authorization rejections (unauthenticated and missing scope)", async () => {
    expect(await settle(executor.invoke("things.list", ANONYMOUS, {}))).toBe("unauthenticated");
    expect(await settle(executor.invoke("things.create", agent(["services:read"]), { n: 1 }, { idempotencyKey: "key-12345678" }))).toBe("forbidden");
    expect(await count(METRIC_NAMES.authzRejections, { tool: "things.list", code: "unauthenticated" })).toBe(1);
    expect(await count(METRIC_NAMES.authzRejections, { tool: "things.create", code: "forbidden" })).toBe(1);
  });

  it("counts task completion for mutating capabilities only", async () => {
    await executor.invoke("things.create", user, { n: 1 }, { idempotencyKey: "key-aaaaaaaa" });
    expect(await count(METRIC_NAMES.taskCompletions, { task: "things.create", outcome: "completed" })).toBe(1);
    expect(await count(METRIC_NAMES.taskCompletions, { task: "things.list" })).toBe(0);
  });

  it("marks internal failures as span errors without leaking the message; rethrows", async () => {
    expect(await settle(executor.invoke("things.create", user, { n: 13 }, { idempotencyKey: "key-bbbbbbbb" }))).toBe("throw");
    expect(await count(METRIC_NAMES.toolInvocations, { tool: "things.create", outcome: "error" })).toBe(1);
    expect(await count(METRIC_NAMES.taskCompletions, { task: "things.create", outcome: "failed" })).toBe(1);
    const s = t.spans.getFinishedSpans().filter((x) => x.name === "capability things.create").at(-1)!;
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify([s.status, s.events, s.attributes])).not.toContain("hunter2");
  });

  it("unknown capability still yields a bounded tool label", async () => {
    expect(await settle(executor.invoke("evil.<script>", ag, {}))).toBe("not_found");
    expect((await t.points(METRIC_NAMES.toolInvocations)).some((p) => p.attributes.tool === "evil.<script>")).toBe(false);
    expect(await count(METRIC_NAMES.toolInvocations, { tool: "unknown" })).toBe(1);
  });
});
