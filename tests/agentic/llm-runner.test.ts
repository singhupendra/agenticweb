/**
 * Plumbing test for the optional LLM runner (evals/llm-agent.ts) — NOT a model result. A scripted stand-in for the API
 * drives the loop over the real in-process MCP server to prove: tool schema conversion, tool_use → MCP call → tool_result,
 * human-approval hook, fault interception, token accounting. Real model quality is only ever measured by `pnpm eval:llm`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { runLlmAgent, type Complete, type Completion } from "../../evals/llm-agent";
import { SLOTS, user } from "../fixtures";
import { startMcp, textJson } from "../mcp/harness";

const open: Awaited<ReturnType<typeof startMcp>>[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((s) => s.close())); });
const call = (id: string, name: string, input: Record<string, unknown>): Completion => ({ stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id, name, input }] });
const done = (text: string): Completion => ({ stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 }, content: [{ type: "text", text }] });
const scripted = (steps: (Completion | ((req: Parameters<Complete>[0]) => Completion))[], seen: { tools?: string[]; results?: string[] } = {}): Complete => async (req) => {
  seen.tools ??= req.tools.map((t) => t.name);
  const last = req.messages.at(-1)!;
  if (Array.isArray(last.content)) seen.results = [...(seen.results ?? []), ...last.content.map((b) => b.content ?? "")];
  const step = steps.shift()!;
  return typeof step === "function" ? step(req) : step;
};

describe("LLM runner plumbing", () => {
  it("converts MCP tools, executes tool_use blocks, counts tokens, lets the simulated human approve", async () => {
    const s = await startMcp({ resolver: () => ({ resolve: async () => user }) }); open.push(s);
    const seen: { tools?: string[]; results?: string[] } = {};
    const run = await runLlmAgent({
      mcp: await s.connect(), goal: "book it", orgSlug: "acme",
      hooks: { onConfirmation: (id) => s.gate.approve(id, user) }, // the simulated HUMAN approves out of band
      complete: scripted([call("1", "list_services", { orgSlug: "acme" }), call("2", "create_booking", { orgSlug: "acme", slotId: SLOTS.one.id, idempotencyKey: "plumbing-key-1" }),
        // the model repeats the identical call WITH the confirmationId it was given (the human approved out of band via the hook)
        (req) => call("3", "create_booking", { orgSlug: "acme", slotId: SLOTS.one.id, idempotencyKey: "plumbing-key-1", confirmationId: /confirmationId\W+([0-9a-f-]{36})/.exec(JSON.stringify(req.messages.at(-1)))![1] }),
        done("Booked.")], seen),
    });
    expect(seen.tools).toEqual(expect.arrayContaining(["list_services", "create_booking", "get_booking"]));
    expect(run).toMatchObject({ turns: 4, stoppedBy: "end_turn", finalText: "Booked.", tokens: { input: 37, output: 18 } });
    expect(run.toolCalls.map((c) => [c.tool, c.ok, c.code])).toEqual([["list_services", true, undefined], ["create_booking", false, "confirmation_required"], ["create_booking", true, undefined]]);
    expect(textJson(await (await s.connect()).callTool({ name: "list_my_bookings", arguments: { orgSlug: "acme" } })).items).toHaveLength(1);
  });

  it("intercept can inject a transient error that the model sees as a tool error", async () => {
    const s = await startMcp(); open.push(s);
    const seen: { results?: string[] } = {};
    const run = await runLlmAgent({
      mcp: await s.connect(), goal: "x", orgSlug: "acme",
      complete: scripted([call("1", "list_services", { orgSlug: "acme" }), done("gave up")], seen),
      hooks: { intercept: async () => "Network error: connection reset" },
    });
    expect(seen.results).toEqual(["Network error: connection reset"]);
    expect(run.toolCalls[0]).toMatchObject({ ok: false, code: "transient" });
  });

  it("stops at maxTurns instead of looping forever", async () => {
    const s = await startMcp(); open.push(s);
    const run = await runLlmAgent({ mcp: await s.connect(), goal: "x", orgSlug: "acme", maxTurns: 3, complete: async () => call("1", "get_organization", { orgSlug: "acme" }) });
    expect(run.stoppedBy).toBe("max_turns");
    expect(run.turns).toBe(3);
  });

  it("the CLI refuses to run (and fabricates nothing) without ANTHROPIC_API_KEY", () => {
    const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
    const r = spawnSync("pnpm", ["exec", "tsx", "evals/run-llm.ts"], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/SKIPPED: ANTHROPIC_API_KEY is not set/);
  }, 30_000);
});
