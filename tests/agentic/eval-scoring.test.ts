import { describe, expect, it } from "vitest";
import { gate, loadDataset, summarize, type TaskResult } from "../../evals/lib";

const r = (o: Partial<TaskResult> & Pick<TaskResult, "id" | "category">): TaskResult => ({ success: true, transactionCorrect: null, retries: 0, toolCalls: [], totalMs: 10, ...o });

describe("eval dataset + scoring", () => {
  it("dataset v1 is frozen, ids are unique, every task is well-formed", () => {
    const d = loadDataset();
    expect(d).toMatchObject({ version: "1.0.0", frozen: true });
    expect(d.tasks.length).toBeGreaterThanOrEqual(30);
    for (const t of d.tasks) {
      if (t.category === "book" || t.category === "recovery") expect(t.expect.service, t.id).toBeTruthy();
      if (t.category === "authz") expect(t.attack, t.id).toBeTruthy();
      if (t.category === "discovery") expect(t.expect.tools?.length, t.id).toBeGreaterThan(0);
    }
    expect(new Set(d.tasks.map((t) => t.category))).toEqual(new Set(["book", "recovery", "authz", "discovery"]));
  });
  it("failed tasks are counted, never dropped, and trip the gates", () => {
    const s = summarize([
      r({ id: "b1", category: "book", transactionCorrect: true, toolCalls: [{ tool: "x", ms: 5, ok: true }] }),
      r({ id: "b2", category: "book", success: false, failure: "no slot", transactionCorrect: false, toolCalls: [{ tool: "x", ms: 9, ok: false, code: "conflict" }] }),
      r({ id: "a1", category: "authz", success: false, failure: "NOT REJECTED" }),
    ]);
    expect(s.total).toBe(3);
    expect(s.failed).toEqual(["b2: no slot", "a1: NOT REJECTED"]);
    expect(s.taskSuccessRate).toBe(0.5);
    expect(s.authorizationSafety).toBe(0);
    expect(s.executionReliability).toBe(0.5); // the conflict is an unexpected failure…
    expect(gate(s)).toHaveLength(3);
  });
  it("expected control-flow codes (human approval, injected faults) do not count against reliability", () => {
    const s = summarize([r({ id: "b", category: "book", transactionCorrect: true, toolCalls: [{ tool: "c", ms: 1, ok: false, code: "confirmation_required" }, { tool: "c", ms: 1, ok: false, code: "transient" }, { tool: "c", ms: 1, ok: true }] }), r({ id: "a", category: "authz" })]);
    expect(s.executionReliability).toBe(1);
    expect(gate(s)).toEqual([]);
  });
});
