import { describe, expect, it } from "vitest";
import { AppError, ProblemDetailsSchema, PROBLEM_CONTENT_TYPE, problemResponse, toEnvelope, toProblem, validationError } from "@/core/errors";

describe("problem details", () => {
  it("maps AppError to RFC 9457 shape with stable code", () => {
    const p = toProblem(new AppError("not_found", "Service was not found."), { requestId: "r1", instance: "/x" });
    expect(ProblemDetailsSchema.parse(p)).toMatchObject({ status: 404, code: "not_found", requestId: "r1", instance: "/x" });
    expect(p.type).toMatch(/\/not_found$/);
  });
  it("never leaks unknown error messages (500)", () => {
    const p = toProblem(new Error("password=hunter2 SELECT * FROM users"));
    expect(p.status).toBe(500);
    expect(JSON.stringify(p)).not.toContain("hunter2");
  });
  it("carries field issues for validation errors", () => {
    expect(toProblem(validationError([{ path: "a.b", message: "bad" }])).errors).toEqual([{ path: "a.b", message: "bad" }]);
  });
  it("responds with problem+json content type", async () => {
    const r = problemResponse(new AppError("forbidden"), { requestId: "r2" });
    expect(r.status).toBe(403);
    expect(r.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    expect(r.headers.get("x-request-id")).toBe("r2");
  });
});

describe("envelope", () => {
  it("wraps plain data", () => expect(toEnvelope({ a: 1 }, "r")).toEqual({ data: { a: 1 }, meta: { requestId: "r" } }));
  it("lifts pagination into meta", () =>
    expect(toEnvelope({ items: [1], page: 2, pageSize: 5, total: 9 }, "r")).toEqual({ data: [1], meta: { requestId: "r", page: 2, pageSize: 5, total: 9 } }));
});
