import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("/api/health", () => {
  it("is a dependency-free liveness probe", async () => {
    const r = GET();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok" });
  });
});
