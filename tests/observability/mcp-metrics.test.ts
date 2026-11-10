import { afterAll, describe, expect, it } from "vitest";
import { METRIC_NAMES } from "@/observability";
import { SLOTS, user } from "../fixtures";
import { startMcp } from "../mcp/harness";
import { installTelemetry } from "./harness";

const t = installTelemetry();
afterAll(() => t.shutdown());
const sum = async (name: string, where: Record<string, unknown> = {}) =>
  (await t.points(name)).filter((p) => Object.entries(where).every(([k, v]) => p.attributes[k] === v)).reduce((n, p) => n + (p.value as number), 0);

describe("MCP channel emits agent metrics", () => {
  it("records agent requests, tool discovery and human-intervention (human approval required)", async () => {
    const s = await startMcp();
    try {
      const client = await s.connect(user);
      await client.listTools();
      expect(await sum(METRIC_NAMES.agentRequests, { channel: "mcp" })).toBeGreaterThan(0);
      expect(await sum(METRIC_NAMES.toolDiscoveries, { channel: "mcp", outcome: "success" })).toBe(1);

      // A write is bounced to the human for out-of-band approval (428 confirmation_required).
      await client.callTool({ name: "create_booking", arguments: { orgSlug: "acme", slotId: SLOTS.one.id, idempotencyKey: "key-12345678" } });
      expect(await sum(METRIC_NAMES.humanInterventions, { reason: "consent_required" })).toBe(1);
    } finally {
      await s.close();
    }
  });
});
