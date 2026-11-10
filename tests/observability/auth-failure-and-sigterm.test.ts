import { afterAll, describe, expect, it } from "vitest";
import { AppError } from "@/core/errors";
import { createRestHandler } from "@/api/rest";
import { METRIC_NAMES } from "@/observability";
import { testRuntime } from "../fixtures";
import { installTelemetry } from "./harness";

const t = installTelemetry();
afterAll(() => t.shutdown());
const sum = async (name: string, where: Record<string, unknown> = {}) =>
  (await t.points(name)).filter((p) => Object.entries(where).every(([k, v]) => p.attributes[k] === v)).reduce((n, p) => n + (p.value as number), 0);

describe("failed authentication is visible in agent metrics", () => {
  it("counts a request and an authz rejection when the resolver throws (bad token floods)", async () => {
    const handler = createRestHandler("services.list", {
      runtime: () => testRuntime(),
      resolver: () => ({ resolve: async () => { throw new AppError("unauthenticated", "bad token"); } }),
    });
    const res = await handler(new Request("http://localhost/api/organizations/acme/services", { headers: { authorization: "Bearer nope" } }), { params: Promise.resolve({ orgSlug: "acme" }) });
    expect(res.status).toBe(401);
    expect(await sum(METRIC_NAMES.agentRequests, { channel: "rest", actor_kind: "anonymous" })).toBe(1);
    expect(await sum(METRIC_NAMES.authzRejections, { tool: "services.list", code: "unauthenticated" })).toBe(1);
  });
});
