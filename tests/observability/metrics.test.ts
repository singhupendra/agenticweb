import { afterAll, describe, expect, it } from "vitest";
import {
  METRIC_NAMES, recordAgentRequest, recordAuthzRejection, recordHumanIntervention, recordInvalidArgument,
  recordTaskCompletion, recordToolDiscovery, recordToolInvocation,
} from "@/observability";
import { installTelemetry } from "./harness";

const t = installTelemetry();
afterAll(() => t.shutdown());
const sum = async (name: string, where: Record<string, unknown> = {}) =>
  (await t.points(name)).filter((p) => Object.entries(where).every(([k, v]) => p.attributes[k] === v)).reduce((n, p) => n + (p.value as number), 0);

describe("agent metrics", () => {
  it("counts agent requests by channel and actor kind", async () => {
    recordAgentRequest({ channel: "mcp", actorKind: "agent" });
    recordAgentRequest({ channel: "mcp", actorKind: "agent" });
    recordAgentRequest({ channel: "rest", actorKind: "user" });
    expect(await sum(METRIC_NAMES.agentRequests, { channel: "mcp", actor_kind: "agent" })).toBe(2);
    expect(await sum(METRIC_NAMES.agentRequests)).toBe(3);
  });
  it("counts tool discovery success/failure", async () => {
    recordToolDiscovery({ channel: "mcp", outcome: "success" });
    recordToolDiscovery({ channel: "mcp", outcome: "error" });
    expect(await sum(METRIC_NAMES.toolDiscoveries, { outcome: "success" })).toBe(1);
    expect(await sum(METRIC_NAMES.toolDiscoveries, { outcome: "error" })).toBe(1);
  });
  it("records tool invocations and a latency histogram", async () => {
    recordToolInvocation({ tool: "bookings.create", actorKind: "agent", outcome: "success", durationMs: 12 });
    recordToolInvocation({ tool: "bookings.create", actorKind: "agent", outcome: "error", durationMs: 480 });
    expect(await sum(METRIC_NAMES.toolInvocations, { tool: "bookings.create", outcome: "success" })).toBe(1);
    const h = (await t.points(METRIC_NAMES.toolDuration)).find((p) => p.attributes.outcome === "error")!;
    expect((h.value as { count: number; sum: number }).count).toBe(1);
    expect((h.value as { sum: number }).sum).toBe(480);
  });
  it("counts invalid arguments, authz rejections, task completion and human intervention", async () => {
    recordInvalidArgument({ tool: "bookings.create" });
    recordAuthzRejection({ tool: "bookings.cancel", code: "forbidden" });
    recordTaskCompletion({ task: "bookings.create", outcome: "completed" });
    recordTaskCompletion({ task: "bookings.create", outcome: "failed" });
    recordHumanIntervention({ reason: "confirmation_required" });
    expect(await sum(METRIC_NAMES.invalidArguments, { tool: "bookings.create" })).toBe(1);
    expect(await sum(METRIC_NAMES.authzRejections, { code: "forbidden" })).toBe(1);
    expect(await sum(METRIC_NAMES.taskCompletions, { outcome: "completed" })).toBe(1);
    expect(await sum(METRIC_NAMES.taskCompletions, { outcome: "failed" })).toBe(1);
    expect(await sum(METRIC_NAMES.humanInterventions, { reason: "confirmation_required" })).toBe(1);
  });
  it("never accepts free-form/PII attributes: only the declared attribute keys are emitted", async () => {
    // @ts-expect-error extra keys are rejected by the type; the runtime must also drop them
    recordToolInvocation({ tool: "x.y", actorKind: "user", outcome: "success", durationMs: 1, userId: "u-1", email: "a@b.c" });
    const pts = await t.points(METRIC_NAMES.toolInvocations);
    const p = pts.find((q) => q.attributes.tool === "x.y")!;
    expect(Object.keys(p.attributes).sort()).toEqual(["actor_kind", "outcome", "tool"]);
  });
});
