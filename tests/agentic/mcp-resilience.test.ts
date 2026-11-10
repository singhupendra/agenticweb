/**
 * Hermetic (in-process, in-memory) resilience scenarios over a real HTTP + MCP SDK client: tool timeout and transient errors.
 * Runs in the default `pnpm test:run` (no DB / server needed).
 */
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "@/core/errors";
import { SLOTS, agent, testRuntime, user } from "../fixtures";
import { startMcp, textJson, writeApproved } from "../mcp/harness";

const open: Awaited<ReturnType<typeof startMcp>>[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((s) => s.close())); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = (key: string) => ({ orgSlug: "acme", slotId: SLOTS.one.id, idempotencyKey: key });
const bookings = async (c: Awaited<ReturnType<Awaited<ReturnType<typeof startMcp>>["connect"]>>) =>
  (textJson(await c.callTool({ name: "list_my_bookings", arguments: { orgSlug: "acme" } })) as { items: unknown[] }).items;

describe("MCP tool timeout", () => {
  it("a slow write times out with a typed error telling the agent to retry with the SAME key; the retry never double-books", async () => {
    const rt = testRuntime();
    const orig = rt.executor.invoke.bind(rt.executor);
    let calls = 0;
    rt.executor.invoke = async (n, a, i, o) => { if (n === "bookings.create" && calls++ === 0) await sleep(250); return orig(n, a, i, o); };
    const s = await startMcp({ timeoutMs: 60, resolver: () => ({ resolve: async () => user }) }, rt);
    open.push(s);
    const c = await s.connect();

    // Each attempt needs the human's approval (a spent approval is single use, even if the call then times out).
    const timedOut = await writeApproved(s.gate, c, user, { name: "create_booking", arguments: args("timeout-key-1") });
    expect(timedOut.isError).toBe(true);
    expect(textJson(timedOut)).toMatchObject({ code: "timeout" });
    expect(textJson(timedOut).detail).toMatch(/SAME idempotencyKey/);

    await sleep(300); // the server-side work finished after the client gave up
    const retry = await writeApproved(s.gate, c, user, { name: "create_booking", arguments: args("timeout-key-1") });
    expect(retry.isError).toBeFalsy();
    expect(retry.structuredContent).toMatchObject({ status: "confirmed", slotId: SLOTS.one.id });
    expect(await bookings(c)).toHaveLength(1); // exactly one booking, never two
    expect(rt.bookingsRepo).toBeDefined();
  });

  it("a read tool that exceeds the budget times out without side effects", async () => {
    const rt = testRuntime();
    const orig = rt.executor.invoke.bind(rt.executor);
    rt.executor.invoke = async (n, a, i, o) => { await sleep(200); return orig(n, a, i, o); };
    const s = await startMcp({ timeoutMs: 30 }, rt);
    open.push(s);
    const r = await (await s.connect()).callTool({ name: "list_services", arguments: { orgSlug: "acme" } });
    expect(r.isError).toBe(true);
    expect(textJson(r).code).toBe("timeout");
  });
});

describe("transient failures", () => {
  it("a transient executor failure surfaces as an error result (no partial write) and the retry with the same key succeeds once", async () => {
    const rt = testRuntime();
    const orig = rt.executor.invoke.bind(rt.executor);
    let fail = 1;
    rt.executor.invoke = async (n, a, i, o) => { if (n === "bookings.create" && fail-- > 0) throw new AppError("internal", "db connection reset"); return orig(n, a, i, o); };
    const s = await startMcp({ resolver: () => ({ resolve: async () => agent(["bookings:read", "bookings:write"]) }) }, rt);
    open.push(s);
    const c = await s.connect();
    const first = await writeApproved(s.gate, c, user, { name: "create_booking", arguments: args("transient-key-1") });
    expect(first.isError).toBe(true);
    expect(JSON.stringify(first)).not.toContain("db connection reset");
    expect(await bookings(c)).toHaveLength(0);
    const second = await writeApproved(s.gate, c, user, { name: "create_booking", arguments: args("transient-key-1") });
    expect(second.isError).toBeFalsy();
    expect(await bookings(c)).toHaveLength(1);
  });
});
